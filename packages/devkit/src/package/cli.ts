#!/usr/bin/env node
/**
 * siq-package [--out DIR] [--platform linux|win32] [--format tar.gz|deb]...
 * Packages the built app for Linux (.tar.gz, .deb) or Windows (.zip). Run `pnpm build` first.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { packageLinux, packageWindows } from './index.js';

const args = process.argv.slice(2);
let out = 'release';
let platform = process.platform === 'win32' ? 'win32' : 'linux';
const formats: Array<'tar.gz' | 'deb'> = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--out') out = args[++i] ?? out;
  else if (a === '--platform') {
    platform = args[++i] ?? '';
    if (platform !== 'linux' && platform !== 'win32') throw new Error(`unknown platform ${platform} (linux or win32)`);
  }
  else if (a === '--format') {
    const f = args[++i];
    if (f !== 'tar.gz' && f !== 'deb') throw new Error(`unknown format ${f}`);
    formats.push(f);
  } else throw new Error(`unknown argument ${a}`);
}
// Archive timestamps: SOURCE_DATE_EPOCH, else the last commit's time, so a rebuild gives the same bytes.
const commitTime = () => {
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
};
const mtime = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : commitTime();
const t0 = Date.now();
const r =
  platform === 'win32'
    ? await packageWindows({ root: process.cwd(), out: resolve(out), mtime })
    : packageLinux({ root: process.cwd(), out: resolve(out), formats: formats.length ? formats : undefined, mtime });
console.log(`SiteInquisition ${r.version}: ${r.unpacked}`);
for (const f of r.files) console.log(`  ${f}`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
