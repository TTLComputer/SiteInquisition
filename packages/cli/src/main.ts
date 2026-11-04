#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
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
  type ScopeConfig,
} from '@siteinquisition/core';

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
  const status = e.status === null ? e.state.slice(0, 3).toUpperCase() : String(e.status);
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
  .option('--port <n>', 'proxy port (0 = first free port from 8000)', '8080')
  .option('--api-port <n>', 'core API port (0 = pick a free port)', '0')
  .option('--lan', 'accept connections from other machines, e.g. IoT devices', false)
  .option('--include <host...>', 'add include rules for these host globs before starting')
  .option('--insecure-upstream', 'skip certificate checks on upstream servers', false)
  .addOption(new Option('--quiet', 'do not print each exchange'))
  .action(async (o: { port: string; apiPort: string; lan: boolean; include?: string[]; insecureUpstream: boolean; quiet?: boolean }) => {
    const core = await Core.open({
      projectDir: projectDir(),
      proxy: { port: Number(o.port), allowLan: o.lan, ignoreUpstreamTlsErrors: o.insecureUpstream },
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
    console.error(`  decrypting  ${info.decryptHosts.length ? info.decryptHosts.join(', ') : 'nothing yet: add hosts with --include or `siq scope add`'}`);
    if (!o.quiet) core.proxy.on('response', (e) => console.log(line(e)));
    core.proxy.on('error', (err) => console.error(paint(31, `capture error: ${err.message}`)));
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
      console.log(`${ex.method} ${ex.url} HTTP/${ex.httpVersion}`);
      for (const [k, v] of ex.requestHeaders) console.log(`${k}: ${v}`);
      if (req.byteLength) console.log(`\n${text(req)}`);
      console.log('');
      if (ex.status !== null) {
        console.log(`HTTP/${ex.httpVersion} ${ex.status} ${ex.statusMessage ?? ''}`.trim());
        for (const [k, v] of ex.responseHeaders ?? []) console.log(`${k}: ${v}`);
        if (res.byteLength) console.log(`\n${text(res)}`);
      } else {
        console.log(`(${ex.state}${ex.error ? `: ${ex.error}` : ''})`);
      }
      const stream = s.getStreamForExchange(id);
      if (stream) {
        console.log(`\n-- ${stream.protocol} messages --`);
        for (const m of s.getStreamMessages(stream.id)) {
          const arrow = m.direction === 'client' ? '>>' : '<<';
          console.log(`${arrow} ${m.opcode === 'text' ? Buffer.from(m.payload).toString('utf8') : `<${m.size} bytes> ${Buffer.from(m.payload.subarray(0, 32)).toString('hex')}`}`);
        }
      }
    });
  });

const scope = program.command('scope').description('view and change which hosts are decrypted and recorded');

const saveScope = async (config: ScopeConfig) => {
  const running = readRuntimeInfo(projectDir());
  if (running) {
    // A live core owns the scope (it may need to restart its listener), so ask it.
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${running.apiPort}/?token=${running.token}`);
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    await new Promise<void>((r, j) => {
      ws.once('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { error?: { message: string } };
        ws.close();
        return msg.error ? j(new Error(msg.error.message)) : r();
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'scope.set', params: { config } }));
    });
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

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
