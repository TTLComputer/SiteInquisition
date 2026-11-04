import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CoreApiServer } from './api.js';
import { loadOrCreateCA, type CertificateAuthority } from './ca.js';
import { defaultDataDir } from './paths.js';
import { ProxyEngine, type ProxyOptions } from './proxy.js';
import { DEFAULT_SCOPE, Scope, type ScopeConfig } from './scope.js';
import { CaptureStore, type StoreOptions } from './store.js';

export const VERSION = '0.0.0';

export interface CoreOptions {
  /** Folder holding project.sqlite. Created if missing. */
  projectDir: string;
  /** Per-user folder for the CA. Defaults to the platform config dir. */
  dataDir?: string;
  actor?: string;
  store?: Omit<StoreOptions, 'actor'>;
  proxy?: ProxyOptions;
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

export class Core {
  readonly projectDir: string;
  readonly store: CaptureStore;
  readonly scope: Scope;
  readonly proxy: ProxyEngine;
  readonly api?: CoreApiServer;

  private constructor(
    private readonly opts: CoreOptions,
    readonly ca: CertificateAuthority,
  ) {
    this.projectDir = resolve(opts.projectDir);
    this.store = CaptureStore.openProject(this.projectDir, { ...opts.store, actor: opts.actor });
    this.scope = new Scope(this.store.getMeta<ScopeConfig>('scope') ?? DEFAULT_SCOPE);
    this.proxy = new ProxyEngine(this.store, this.scope, ca, opts.proxy);
    if (opts.api !== false) this.api = new CoreApiServer(this, opts.api?.token);
  }

  static async open(opts: CoreOptions): Promise<Core> {
    const ca = await loadOrCreateCA(opts.dataDir ?? defaultDataDir());
    return new Core(opts, ca);
  }

  async start(): Promise<{ proxyPort: number; apiPort?: number }> {
    const proxyPort = await this.proxy.start();
    let apiPort: number | undefined;
    if (this.api) {
      apiPort = await this.api.start(this.opts.api ? this.opts.api.port : undefined);
      const info: CoreRuntimeInfo = { pid: process.pid, apiPort, token: this.api.token, proxyPort };
      writeFileSync(join(this.projectDir, RUNTIME_FILE), JSON.stringify(info, null, 2), { mode: 0o600 });
    }
    return { proxyPort, apiPort };
  }

  async close(): Promise<void> {
    await this.api?.stop();
    await this.proxy.stop();
    if (this.api) rmSync(join(this.projectDir, RUNTIME_FILE), { force: true });
    this.store.close();
  }

  /** Replace the scope config, persist it, and restart the proxy if the set of decrypted hosts changed. */
  async setScope(config: ScopeConfig): Promise<void> {
    const before = this.scope.decryptHosts().join('\n');
    this.scope.set(config);
    this.store.setMeta('scope', this.scope.get());
    if (this.proxy.running && before !== this.scope.decryptHosts().join('\n')) await this.proxy.restart();
  }

  info() {
    return {
      version: VERSION,
      projectDir: this.projectDir,
      actor: this.store.actor,
      proxyPort: this.proxy.running ? this.proxy.port : null,
      apiPort: this.api ? safe(() => this.api!.port) : null,
      ca: { certPath: this.ca.certPath, fingerprint: this.ca.fingerprint, expiresAt: this.ca.expiresAt.toISOString() },
      decryptHosts: this.scope.decryptHosts(),
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
