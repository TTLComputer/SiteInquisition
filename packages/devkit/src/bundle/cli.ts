#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { bundle, BundleError, type BundleOptions } from './index.js';

/**
 * siq-bundle [--watch] [--serve [port]]
 *
 * Builds the page in the current directory (index.html → dist). Options
 * come from the "siqBundle" field of package.json. --watch rebuilds when an
 * input changes; --serve also serves dist on 127.0.0.1 and reloads the page
 * after each rebuild.
 */
const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { siqBundle?: Partial<BundleOptions> };
const args = process.argv.slice(2);
const serveAt = args.indexOf('--serve');
const serve = serveAt >= 0;
const port = serve && /^\d+$/.test(args[serveAt + 1] ?? '') ? Number(args[serveAt + 1]) : 5173;
const watching = serve || args.includes('--watch');

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const reloaders = new Set<ServerResponse>();

// In dev the page needs the reload script, which the strict CSP would block.
const devHtml = (html: string) =>
  html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<\/body>/i, `<script>new EventSource('/__siq_reload').onmessage = () => location.reload();</script>\n  </body>`);

function build(): string[] {
  const r = bundle({ ...pkg.siqBundle, root: cwd, ...(serve ? { transformHtml: devHtml } : {}) });
  const outDir = pkg.siqBundle?.outDir ?? 'dist';
  const big = r.files.filter((f) => !f.path.endsWith('.woff') && !f.path.endsWith('.woff2'));
  for (const f of big) console.log(`  ${join(outDir, f.path).padEnd(40)} ${kb(f.bytes).padStart(10)}`);
  const fonts = r.files.length - big.length;
  if (fonts) console.log(`  ${`${fonts} font files`.padEnd(40)} ${kb(r.files.filter((f) => !big.includes(f)).reduce((n, f) => n + f.bytes, 0)).padStart(10)}`);
  console.log(`built ${r.modules} modules in ${Math.round(r.durationMs)}ms`);
  return r.inputs;
}

function tryBuild(): string[] | undefined {
  try {
    return build();
  } catch (e) {
    if (!(e instanceof BundleError) && !(e instanceof Error)) throw e;
    console.error(`build failed: ${e.message}`);
    if (!watching) process.exit(1);
    return undefined;
  }
}

const outDir = resolve(cwd, pkg.siqBundle?.outDir ?? 'dist');
let inputs = tryBuild() ?? [];
if (watching) {
  // Watch the folders that hold inputs outside node_modules; rebuild on any change there.
  const watchers = new Map<string, FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  const sync = () => {
    const dirs = new Set(inputs.filter((f) => !f.split(sep).includes('node_modules')).map((f) => dirname(f)));
    for (const d of dirs)
      if (!watchers.has(d))
        watchers.set(
          d,
          watch(d, (_event, name) => {
            // The output folder can sit next to index.html; its writes are not changes.
            if (name && resolve(d, name.toString()).startsWith(outDir)) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              const next = tryBuild();
              if (next) {
                inputs = next;
                sync();
                for (const r of reloaders) r.write('data: reload\n\n');
              }
            }, 50);
          }),
        );
  };
  sync();
  console.log('watching for changes');
}

if (serve) {
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (path === '/__siq_reload') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': connected\n\n');
      reloaders.add(res);
      req.on('close', () => reloaders.delete(res));
      return;
    }
    const file = normalize(join(outDir, path === '/' ? 'index.html' : path));
    if (relative(outDir, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${port}/`));
}
