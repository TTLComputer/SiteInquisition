import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CoreApiServer } from './api.js';
import { loadOrCreateCA, type CertificateAuthority } from './ca.js';
import { MqttRelay, type MqttListenerConfig } from './mqtt.js';
import { defaultDataDir } from './paths.js';
import { ProxyEngine, type ProxyOptions } from './proxy.js';
import { DEFAULT_SCOPE, Scope, type ScopeConfig } from './scope.js';
import { SeenHosts } from './seen.js';
import { PowerTools } from './powertools.js';
import { CaptureStore, type StoreOptions } from './store.js';

export { VERSION } from './version.js';
import { VERSION } from './version.js';

export interface CoreOptions {
  /** Folder holding project.sqlite. Created if missing. */
  projectDir: string;
  /** Per-user folder for the CA. Defaults to the platform config dir. */
  dataDir?: string;
  actor?: string;
  store?: Omit<StoreOptions, 'actor'>;
  proxy?: ProxyOptions;
  /** MQTT listeners that relay to real brokers and record every packet. */
  mqtt?: MqttListenerConfig[];
  /**
   * A second, loopback-only listener for the built-in browser. Its traffic is
   * recorded with source "browser" so the browser view can show its own feed.
   */
  browserProxy?: boolean | { port?: number; http3?: boolean };
  /** Core API settings, or false to run without it. */
  api?: { port?: number; token?: string } | false;
}

/** Connection details a running core writes into its project folder for local clients such as `siq`. */
export interface CoreRuntimeInfo {
  pid: number;
  apiPort: number;
  token: string;
  proxyPort: number;
}

export const RUNTIME_FILE = 'core.json';

/**
 * Hosts the built-in browser sends to the HTTP/3 listener. Chromium reads
 * them from its command line, so the app reads this file before it starts
 * and changes take effect on the next launch.
 */
export const BROWSER_FILE = 'browser.json';

export function readBrowserHttp3Hosts(projectDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(projectDir, BROWSER_FILE), 'utf8')) as { http3Hosts?: unknown };
    return Array.isArray(v.http3Hosts) ? v.http3Hosts.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/** Host names only: Chromium's force-QUIC switch takes exact origins, so no wildcards or ports. */
export function normalizeBrowserHttp3Hosts(hosts: string[]): string[] {
  const out = new Set<string>();
  for (const raw of hosts) {
    const h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) throw new Error(`"${raw.trim()}" is not a host name (wildcards and IP addresses are not supported)`);
    out.add(h);
  }
  return [...out];
}

export function writeBrowserHttp3Hosts(projectDir: string, hosts: string[]): string[] {
  const list = normalizeBrowserHttp3Hosts(hosts);
  writeFileSync(join(projectDir, BROWSER_FILE), JSON.stringify({ http3Hosts: list }, null, 2));
  return list;
}

export class Core {
  readonly projectDir: string;
  /** Per-user folder: the CA and settings that belong to this computer, not the project. */
  readonly dataDir: string;
  readonly store: CaptureStore;
  readonly scope: Scope;
  readonly proxy: ProxyEngine;
  readonly browserProxy?: ProxyEngine;
  readonly api?: CoreApiServer;
  readonly mqtt: MqttRelay[];
  readonly seen = new SeenHosts();
  readonly tools: PowerTools;

  private constructor(
    private readonly opts: CoreOptions,
    readonly ca: CertificateAuthority,
  ) {
    this.projectDir = resolve(opts.projectDir);
    this.dataDir = resolve(opts.dataDir ?? defaultDataDir());
    this.store = CaptureStore.openProject(this.projectDir, { ...opts.store, actor: opts.actor });
    this.scope = new Scope(this.store.getMeta<ScopeConfig>('scope') ?? DEFAULT_SCOPE);
    this.proxy = new ProxyEngine(this.store, this.scope, ca, opts.proxy, this.seen);
    if (opts.browserProxy) {
      const b = opts.browserProxy === true ? {} : opts.browserProxy;
      this.browserProxy = new ProxyEngine(this.store, this.scope, ca, { ignoreUpstreamTlsErrors: opts.proxy?.ignoreUpstreamTlsErrors, source: 'browser', port: b.port, http3: b.http3 }, this.seen);
    }
    this.mqtt = (opts.mqtt ?? []).map((cfg) => new MqttRelay(this.store, this.scope, ca, cfg, this.seen));
    this.tools = new PowerTools(this);
    this.proxy.setHooks(this.tools.hooks);
    this.browserProxy?.setHooks(this.tools.hooks);
    if (opts.api !== false) this.api = new CoreApiServer(this, opts.api?.token);
  }

  static async open(opts: CoreOptions): Promise<Core> {
    const ca = await loadOrCreateCA(opts.dataDir ?? defaultDataDir());
    return new Core(opts, ca);
  }

  async start(): Promise<{ proxyPort: number; apiPort?: number; browserProxyPort?: number }> {
    const proxyPort = await this.proxy.start();
    const browserProxyPort = this.browserProxy ? await this.browserProxy.start() : undefined;
    for (const relay of this.mqtt) await relay.start();
    let apiPort: number | undefined;
    if (this.api) {
      apiPort = await this.api.start(this.opts.api ? this.opts.api.port : undefined);
      const info: CoreRuntimeInfo = { pid: process.pid, apiPort, token: this.api.token, proxyPort };
      writeFileSync(join(this.projectDir, RUNTIME_FILE), JSON.stringify(info, null, 2), { mode: 0o600 });
    }
    return { proxyPort, apiPort, browserProxyPort };
  }

  async close(): Promise<void> {
    this.tools.close();
    await this.api?.stop();
    await this.proxy.stop();
    await this.browserProxy?.stop();
    for (const relay of this.mqtt) await relay.stop();
    if (this.api) rmSync(join(this.projectDir, RUNTIME_FILE), { force: true });
    this.store.close();
  }

  /** Replace the scope config, persist it, and restart the proxy if the set of decrypted hosts changed. */
  async setScope(config: ScopeConfig): Promise<void> {
    const before = this.scope.decryptHosts().join('\n');
    this.scope.set(config);
    this.store.setMeta('scope', this.scope.get());
    if (before === this.scope.decryptHosts().join('\n')) return;
    if (this.proxy.running) await this.proxy.restart();
    if (this.browserProxy?.running) await this.browserProxy.restart();
  }

  /** Hosts seen recently that the current scope does not record. */
  seenNotInScope() {
    return this.seen.list().filter((h) => {
      const scheme = h.kinds.includes('mqtt') ? 'mqtt' : h.kinds.includes('tls') ? 'https' : 'http';
      return !this.scope.evaluate(`${scheme}://${h.host.includes(':') && !h.host.startsWith('[') ? `[${h.host}]` : h.host}/`).record;
    });
  }

  info() {
    return {
      version: VERSION,
      projectDir: this.projectDir,
      actor: this.store.actor,
      proxyPort: this.proxy.running ? this.proxy.port : null,
      browserProxyPort: this.browserProxy?.running ? this.browserProxy.port : null,
      browserHttp3Port: this.browserProxy?.http3Port ?? null,
      browserHttp3Hosts: readBrowserHttp3Hosts(this.projectDir),
      apiPort: this.api ? safe(() => this.api!.port) : null,
      ca: { certPath: this.ca.certPath, fingerprint: this.ca.fingerprint, expiresAt: this.ca.expiresAt.toISOString() },
      decryptHosts: this.scope.decryptHosts(),
      allowLan: !!this.opts.proxy?.allowLan,
      stats: this.store.stats(),
      mqtt: this.mqtt.map((m) => ({ port: safe(() => m.port), broker: m.brokerUrl, listenTls: !!m.config.listenTls })),
    };
  }
}

const safe = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** Read the connection file a running core left in a project folder, if any. */
export function readRuntimeInfo(projectDir: string): CoreRuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(resolve(projectDir), RUNTIME_FILE), 'utf8')) as CoreRuntimeInfo;
  } catch {
    return undefined;
  }
}
