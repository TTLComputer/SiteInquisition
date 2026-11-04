import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from './args.js';
import {
  CaptureStore,
  Core,
  DEFAULT_SCOPE,
  VERSION,
  defaultDataDir,
  loadOrCreateCA,
  normalizeRule,
  readRuntimeInfo,
  type ExchangeSummary,
  type MqttListenerConfig,
  type ScopeConfig,
} from '@siteinquisition/core';

/**
 * Parse an MQTT listener spec: LISTEN_PORT=BROKER_HOST[:PORT][,tls][,listen-tls][,insecure]
 *   1883=broker.local              plain in, plain out
 *   8883=broker.example.com:8883,tls,listen-tls
 */
export function parseMqttSpec(spec: string, allowLan: boolean): MqttListenerConfig {
  const m = /^(\d+)=([^,:]+|\[[^\]]+\])(?::(\d+))?((?:,[a-z-]+)*)$/i.exec(spec.trim());
  if (!m) throw new Error(`invalid --mqtt spec "${spec}" (expected PORT=HOST[:PORT][,tls][,listen-tls][,insecure])`);
  const flags = new Set(m[4]!.split(',').filter(Boolean).map((f) => f.toLowerCase()));
  for (const f of flags) if (!['tls', 'listen-tls', 'insecure'].includes(f)) throw new Error(`unknown --mqtt flag "${f}"`);
  return {
    port: Number(m[1]),
    upstreamHost: m[2]!.replace(/^\[|\]$/g, ''),
    upstreamPort: m[3] ? Number(m[3]) : undefined,
    upstreamTls: flags.has('tls'),
    listenTls: flags.has('listen-tls'),
    ignoreUpstreamTlsErrors: flags.has('insecure'),
    allowLan,
  };
}

const program = new Command()
  .name('siq')
  .description('SiteInquisition: capture, search and replay HTTP(S) and WebSocket traffic.')
  .version(VERSION)
  .option('-p, --project <dir>', 'project folder', '.siq');

const projectDir = () => resolve(program.opts<{ project: string }>().project);

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const statusColor = (s: number | null) => (s === null ? 90 : s >= 500 ? 31 : s >= 400 ? 33 : s >= 300 ? 36 : 32);

const size = (n: number | null) => (n === null ? '-' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);

function line(e: ExchangeSummary): string {
  const time = new Date(e.startedAt).toTimeString().slice(0, 8);
  const status = e.status === null ? (e.state === 'complete' ? 'OK' : e.state.slice(0, 3).toUpperCase()) : String(e.status);
  const dur = e.durationMs === null ? '' : `${Math.round(e.durationMs)}ms`;
  return [
    paint(90, time),
    e.method.padEnd(7),
    paint(statusColor(e.status), status.padStart(3)),
    e.url,
    paint(90, `${dur} ${size(e.resBodySize)}`.trim()),
    paint(90, e.id),
  ].join(' ');
}

/** Use the store directly. SQLite WAL mode lets this run alongside a live `siq proxy`. */
function withStore<T>(fn: (store: CaptureStore) => T): T {
  const store = CaptureStore.openProject(projectDir());
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

program
  .command('proxy')
  .description('run the capture proxy headless and print traffic as it happens')
  .option('--port <n>', 'proxy port (0 = any free port)', '8080')
  .option('--api-port <n>', 'core API port (0 = pick a free port)', '0')
  .option('--lan', 'accept connections from other machines, e.g. IoT devices', false)
  .option('--include <host...>', 'add include rules for these host globs before starting')
  .option('--insecure-upstream', 'skip certificate checks on upstream servers', false)
  .option('--mqtt <spec...>', 'relay MQTT: PORT=BROKER[:PORT][,tls][,listen-tls][,insecure], e.g. 1883=broker.local')
  .addOption(new Option('--quiet', 'do not print each exchange'))
  .action(async (o: { port: string; apiPort: string; lan: boolean; include?: string[]; insecureUpstream: boolean; mqtt?: string[]; quiet?: boolean }) => {
    const core = await Core.open({
      projectDir: projectDir(),
      proxy: { port: Number(o.port), allowLan: o.lan, ignoreUpstreamTlsErrors: o.insecureUpstream },
      mqtt: (o.mqtt ?? []).map((spec) => parseMqttSpec(spec, o.lan)),
      api: { port: Number(o.apiPort) },
    });
    if (o.include?.length) {
      const current = core.scope.get();
      const have = new Set(current.rules.map((r) => `${r.action}:${r.host}`));
      const added = o.include.filter((h) => !have.has(`include:${h.toLowerCase()}`)).map((host) => ({ action: 'include' as const, host }));
      await core.setScope({ ...current, rules: [...current.rules, ...added.map(normalizeRule)] });
    }
    const { proxyPort, apiPort } = await core.start();
    const info = core.info();
    console.error(`SiteInquisition ${VERSION}`);
    console.error(`  project     ${core.projectDir}`);
    console.error(`  proxy       ${o.lan ? '0.0.0.0' : '127.0.0.1'}:${proxyPort} (HTTP, HTTPS, SOCKS5)`);
    console.error(`  core API    ws://127.0.0.1:${apiPort} (token in ${core.projectDir}/core.json)`);
    console.error(`  CA          ${info.ca.certPath}`);
    for (const m of info.mqtt) console.error(`  mqtt        ${o.lan ? '0.0.0.0' : '127.0.0.1'}:${m.port}${m.listenTls ? ' (TLS)' : ''} -> ${m.broker}`);
    console.error(`  decrypting  ${info.decryptHosts.length ? info.decryptHosts.join(', ') : 'nothing yet: add hosts with --include or `siq scope add`'}`);
    if (!o.quiet) {
      core.proxy.on('response', (e) => console.log(line(e)));
      core.store.on('change', (c) => {
        if (c.kind === 'exchange.established' || (c.kind === 'exchange.error' && core.store.getSummary(c.entityId)?.scheme.startsWith('mqtt'))) {
          const e = core.store.getSummary(c.entityId);
          if (e) console.log(line(e));
        }
      });
    }
    // Headless there is no approval card: say what an agent is waiting for.
    core.tools.mcp.on('approval', (a) =>
      console.error(paint(33, `agent wants to ${a.tool}: ${a.summary}. Approve it in the app, or run \`siq agent-writes allow\` to stop asking. It is denied in 5 minutes.`)),
    );
    core.proxy.on('error', (err) => console.error(paint(31, `capture error: ${err.message}`)));
    for (const relay of core.mqtt) relay.on('error', (err) => console.error(paint(31, `mqtt: ${err.message}`)));
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await core.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('search')
  .description('search captured traffic, e.g. siq search host:api.example.com status:>=400 "session expired"')
  .argument('[query...]', 'filters and free text')
  .option('-n, --limit <n>', 'maximum results', '50')
  .option('--json', 'print JSON', false)
  .action((query: string[], o: { limit: string; json: boolean }) => {
    const rows = withStore((s) => s.search(query.join(' '), { limit: Number(o.limit) }));
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else for (const e of rows.reverse()) console.log(line(e));
  });

program
  .command('show')
  .description('print one exchange with headers and (decoded) bodies')
  .argument('<id>')
  .option('--raw', 'print bodies as captured, without undoing Content-Encoding', false)
  .option('--json', 'print JSON', false)
  .action((id: string, o: { raw: boolean; json: boolean }) => {
    withStore((s) => {
      const ex = s.getExchange(id);
      if (!ex) {
        console.error(`no exchange ${id}`);
        process.exitCode = 1;
        return;
      }
      const req = s.getBody(id, 'request', !o.raw) ?? new Uint8Array();
      const res = s.getBody(id, 'response', !o.raw) ?? new Uint8Array();
      if (o.json) {
        console.log(JSON.stringify({ ...ex, requestBody: Buffer.from(req).toString('base64'), responseBody: Buffer.from(res).toString('base64') }, null, 2));
        return;
      }
      const text = (b: Uint8Array) => (b.byteLength ? Buffer.from(b).toString('utf8') : '');
      const proto = (v: string) => (/^[A-Z]+\//.test(v) ? v : `HTTP/${v}`);
      console.log(`${ex.method} ${ex.url} ${proto(ex.httpVersion)}`);
      for (const [k, v] of ex.requestHeaders) console.log(`${k}: ${v}`);
      if (req.byteLength) console.log(`\n${text(req)}`);
      console.log('');
      if (ex.status !== null) {
        console.log(`${proto(ex.httpVersion)} ${ex.status} ${ex.statusMessage ?? ''}`.trim());
        for (const [k, v] of ex.responseHeaders ?? []) console.log(`${k}: ${v}`);
        if (res.byteLength) console.log(`\n${text(res)}`);
      } else {
        console.log(`(${ex.state}${ex.error ? `: ${ex.error}` : ''})`);
      }
      const stream = s.getStreamForExchange(id);
      if (stream) {
        console.log(`\n-- ${stream.protocol} messages --`);
        const show = (b: Uint8Array) => {
          const buf = Buffer.from(b);
          const printable = !buf.subarray(0, 512).some((c) => c < 9 || (c > 13 && c < 32));
          return printable ? buf.toString('utf8') : `<${b.byteLength} bytes> ${buf.subarray(0, 32).toString('hex')}`;
        };
        for (const m of s.getStreamMessages(stream.id)) {
          const arrow = m.direction === 'client' ? '>>' : '<<';
          if (stream.protocol === 'mqtt') {
            const meta = m.meta ?? {};
            const bits = [m.opcode.toUpperCase()];
            if (typeof meta.topic === 'string') bits.push(meta.topic);
            if (typeof meta.qos === 'number' && (m.opcode === 'publish' || m.opcode === 'subscribe')) bits.push(`qos${meta.qos}`);
            if (meta.retain) bits.push('retain');
            if (typeof meta.messageId === 'number') bits.push(`#${meta.messageId}`);
            if (Array.isArray(meta.subscriptions)) bits.push((meta.subscriptions as Array<{ topic: string }>).map((x) => x.topic).join(' '));
            console.log(`${arrow} ${bits.join(' ')}${m.size ? `  ${show(m.payload)}` : ''}`);
          } else {
            console.log(`${arrow} ${m.opcode === 'text' ? Buffer.from(m.payload).toString('utf8') : show(m.payload)}`);
          }
        }
      }
    });
  });

/** One JSON-RPC call to a running core over its WebSocket API (Node's built-in WebSocket client). */
async function callRunningCore(running: { apiPort: number; token: string }, method: string, params: unknown): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${running.apiPort}/?token=${running.token}`);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot reach the running core on port ${running.apiPort}`)), { once: true });
    });
    const reply = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
      ws.addEventListener('message', (ev) => resolve(JSON.parse(String(ev.data)) as { result?: unknown; error?: { message: string } }), { once: true }),
    );
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    const msg = await reply;
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  } finally {
    ws.close();
  }
}

const scope = program.command('scope').description('view and change which hosts are decrypted and recorded');

const saveScope = async (config: ScopeConfig) => {
  const running = readRuntimeInfo(projectDir());
  if (running) {
    // A live core owns the scope (it may need to restart its listener), so ask it.
    await callRunningCore(running, 'scope.set', { config });
  } else {
    withStore((s) => s.setMeta('scope', config));
  }
};
const loadScope = () => withStore((s) => s.getMeta<ScopeConfig>('scope') ?? DEFAULT_SCOPE);

scope
  .command('list', { isDefault: true })
  .description('show scope rules in evaluation order')
  .action(() => {
    const cfg = loadScope();
    if (!cfg.rules.length) console.log('No rules: nothing is decrypted or recorded.');
    cfg.rules.forEach((r, i) => {
      const where = [r.scheme && `${r.scheme}://`, r.host, r.port && `:${r.port}`, r.pathPrefix].filter(Boolean).join('');
      const flags = r.action === 'include' ? ['decrypt', 'record', 'modify'].filter((f) => r[f as 'decrypt'] !== false).join(',') : '';
      console.log(`${String(i + 1).padStart(2)}. ${r.action.padEnd(7)} ${where} ${flags}${r.enabled === false ? ' (disabled)' : ''}  ${paint(90, r.id)}`);
    });
    console.log(`Unmatched traffic: ${cfg.defaultAction}`);
  });

scope
  .command('add')
  .description('add a rule at the end of the list')
  .argument('<host>', 'host glob, e.g. *.example.com')
  .option('--exclude', 'exclude instead of include', false)
  .option('--path <prefix>', 'only paths starting with this prefix')
  .option('--port <n>', 'only this port')
  .option('--no-decrypt', 'do not intercept TLS for this host')
  .option('--no-record', 'do not record matching traffic')
  .action(async (host: string, o: { exclude: boolean; path?: string; port?: string; decrypt: boolean; record: boolean }) => {
    const cfg = loadScope();
    const rule = normalizeRule({
      action: o.exclude ? 'exclude' : 'include',
      host,
      pathPrefix: o.path,
      port: o.port ? Number(o.port) : undefined,
      ...(o.exclude ? {} : { decrypt: o.decrypt, record: o.record }),
    });
    await saveScope({ ...cfg, rules: [...cfg.rules, rule] });
    console.log(`added ${rule.action} ${rule.host} (${rule.id})`);
  });

scope
  .command('remove')
  .description('remove a rule by id or list position')
  .argument('<idOrIndex>')
  .action(async (key: string) => {
    const cfg = loadScope();
    const idx = /^\d+$/.test(key) ? Number(key) - 1 : cfg.rules.findIndex((r) => r.id === key);
    if (idx < 0 || idx >= cfg.rules.length) {
      console.error(`no rule ${key}`);
      process.exitCode = 1;
      return;
    }
    const [removed] = cfg.rules.splice(idx, 1);
    await saveScope(cfg);
    console.log(`removed ${removed!.action} ${removed!.host}`);
  });

scope
  .command('default')
  .description('what to do with traffic no rule matches')
  .argument('<action>', 'ignore | record')
  .action(async (action: string) => {
    if (action !== 'ignore' && action !== 'record') throw new Error('action must be "ignore" or "record"');
    await saveScope({ ...loadScope(), defaultAction: action });
  });

/** Run against the running app or `siq proxy` when there is one, so its view stays current; otherwise use the store. */
async function viaCore<T>(method: string, params: unknown, offline: (store: CaptureStore) => T): Promise<T> {
  const running = readRuntimeInfo(projectDir());
  if (running) return (await callRunningCore(running, method, params)) as T;
  return withStore(offline);
}

program
  .command('delete')
  .description('delete the recorded exchanges a search query matches (same syntax as `siq search`)')
  .argument('<query...>', 'search query, e.g. host:ads.example.com')
  .option('--yes', 'do not ask for confirmation', false)
  .action(async (query: string[], o: { yes: boolean }) => {
    const q = query.join(' ').trim();
    if (!q) throw new Error('a query is required; use `siq clear` to delete everything');
    if (!o.yes) {
      const n = withStore((s) => s.search(q, { limit: 100000 }).length);
      if (!n) return console.log('nothing matches');
      if (!(await confirm(`Delete ${n} exchange${n === 1 ? '' : 's'}?`))) return;
    }
    const r = await viaCore<{ deleted: number }>('traffic.delete', { query: q }, (s) => ({ deleted: s.deleteMatching(q) }));
    console.log(`deleted ${r.deleted}`);
  });

program
  .command('clear')
  .description("delete all of this project's recorded traffic (settings, rules and scripts stay)")
  .option('--yes', 'do not ask for confirmation', false)
  .action(async (o: { yes: boolean }) => {
    if (!o.yes && !(await confirm('Delete all recorded traffic in this project?'))) return;
    const r = await viaCore<{ deleted: number }>('traffic.clear', {}, (s) => ({ deleted: s.clearTraffic() }));
    console.log(`deleted ${r.deleted}`);
  });

program
  .command('prune')
  .description('delete old traffic now, and with --keep, set the limits the app applies every hour')
  .option('--older-than <days>', 'delete exchanges older than this many days')
  .option('--max-size <MB>', 'delete the oldest exchanges until the stored bodies fit')
  .option('--keep', 'save these limits as the project\'s retention setting', false)
  .option('--off', 'turn the retention setting off', false)
  .action(async (o: { olderThan?: string; maxSize?: string; keep: boolean; off: boolean }) => {
    const pos = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
      return n;
    };
    const limits = { maxAgeDays: pos(o.olderThan, '--older-than'), maxSizeMB: pos(o.maxSize, '--max-size') };
    if (o.off) {
      await viaCore('retention.set', { retention: {} }, (s) => s.setMeta('retention', {}));
      return console.log('retention off: traffic is kept until you delete it');
    }
    if (!limits.maxAgeDays && !limits.maxSizeMB) {
      const r = await viaCore<{ maxAgeDays?: number; maxSizeMB?: number }>('retention.get', {}, (s) => s.getMeta('retention') ?? {});
      const parts = [r.maxAgeDays && `older than ${r.maxAgeDays} days`, r.maxSizeMB && `beyond ${r.maxSizeMB} MB`].filter(Boolean);
      return console.log(parts.length ? `retention: delete traffic ${parts.join(' or ')}` : 'retention off: traffic is kept until you delete it');
    }
    const offline = (s: CaptureStore) => {
      if (o.keep) s.setMeta('retention', limits);
      return { deleted: s.prune({ maxAgeDays: limits.maxAgeDays, maxBytes: limits.maxSizeMB ? limits.maxSizeMB * 1048576 : undefined }) };
    };
    const running = readRuntimeInfo(projectDir());
    let deleted: number;
    if (running && o.keep) {
      await callRunningCore(running, 'retention.set', { retention: limits });
      deleted = ((await callRunningCore(running, 'retention.apply', {})) as { deleted: number }).deleted;
    } else deleted = withStore(offline).deleted;
    console.log(`deleted ${deleted}${o.keep ? '; limits saved' : ''}`);
  });

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error(`${question} Pass --yes to confirm when not at a terminal.`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

program
  .command('ca')
  .description('print the root CA certificate path and fingerprint, or the PEM itself')
  .option('--pem', 'print the certificate in PEM format', false)
  .action(async (o: { pem: boolean }) => {
    const ca = await loadOrCreateCA(defaultDataDir());
    if (o.pem) process.stdout.write(readFileSync(ca.certPath, 'utf8'));
    else {
      console.log(`certificate  ${ca.certPath}`);
      console.log(`sha256       ${ca.fingerprint}`);
      console.log(`expires      ${ca.expiresAt.toISOString().slice(0, 10)}`);
      console.log('Install this certificate as a trusted root on devices whose HTTPS traffic you want to inspect.');
    }
  });

program
  .command('agent-writes')
  .description('whether agents connected over MCP may send traffic and change settings without asking')
  .argument('<mode>', 'ask | allow')
  .action(async (mode: string) => {
    if (mode !== 'ask' && mode !== 'allow') throw new Error('mode must be "ask" or "allow"');
    const running = readRuntimeInfo(projectDir());
    if (running) {
      await callRunningCore(running, 'mcp.setSettings', { writeMode: mode });
    } else withStore((s) => s.setMeta('mcpSettings', { writeMode: mode }));
    console.log(mode === 'allow' ? 'Agents may now send traffic and change settings without asking.' : 'Agent write actions will wait for approval.');
  });

program
  .command('mcp')
  .description('MCP server over stdio for agents such as Claude Code; forwards to the running app or `siq proxy` for this project')
  .action(async () => {
    const { createInterface } = await import('node:readline');
    const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let pending = 0;
    let ended = false;
    const maybeExit = () => ended && pending === 0 && process.exit(0);
    rl.on('line', (raw) => {
      if (!raw.trim()) return;
      let msg: { id?: string | number | null; method?: string };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      pending++;
      (async () => {
        // Read the runtime file every time: the app may have restarted on a new port and token.
        const running = readRuntimeInfo(projectDir());
        if (!running?.apiPort) throw new Error(`SiteInquisition is not running for ${projectDir()}. Open the project in the app, or run \`siq proxy\` there.`);
        const res = await fetch(`http://127.0.0.1:${running.apiPort}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${running.token}` },
          body: raw,
        });
        if (res.status === 202) return;
        if (!res.ok) throw new Error(`the app answered ${res.status}`);
        out(await res.json());
      })()
        .catch((e: Error) => {
          if (msg.id !== undefined && msg.id !== null) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
          else console.error(e.message);
        })
        .finally(() => {
          pending--;
          maybeExit();
        });
    });
    rl.on('close', () => {
      ended = true;
      maybeExit();
    });
    await new Promise(() => undefined);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
