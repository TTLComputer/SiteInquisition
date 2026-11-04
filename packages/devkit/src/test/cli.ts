#!/usr/bin/env node
import { fork } from 'node:child_process';
import { existsSync, globSync, readFileSync, watch } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SerializedError, TestResult } from './index.js';
import type { WorkerMessage } from './worker.js';

/**
 * siq-test [file filters...] [-t name pattern] [--watch]
 *
 * Finds test files from the "siqTest" field of package.json in the current
 * directory, runs each in its own process (several at a time), and prints a
 * vitest-style report. Exits 1 when anything failed.
 */
interface Config {
  include: string[];
  timeout: number;
  hookTimeout: number;
  alias: Record<string, string>;
}

const cwd = process.cwd();
const pkg = existsSync(join(cwd, 'package.json')) ? (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { siqTest?: Partial<Config> }) : {};
const config: Config = { include: ['**/*.test.ts'], timeout: 5000, hookTimeout: 10000, alias: {}, ...pkg.siqTest };

const args = process.argv.slice(2);
const filters: string[] = [];
let namePattern: string | undefined;
let watchMode = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '-t' || a === '--testNamePattern') namePattern = args[++i];
  else if (a.startsWith('--testNamePattern=')) namePattern = a.slice(18);
  else if (a === '--watch' || a === '-w') watchMode = true;
  else if (a === 'run') continue;
  else filters.push(a);
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32);
const red = c(31);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

function findFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of config.include) for (const f of globSync(pattern, { cwd, exclude: (p) => p.includes('node_modules') })) files.add(f);
  return [...files].filter((f) => !filters.length || filters.some((x) => f.includes(x) || resolve(cwd, f) === resolve(cwd, x))).sort();
}

const aliases = Object.fromEntries(Object.entries(config.alias).map(([k, v]) => [k, pathToFileURL(isAbsolute(v) ? v : join(cwd, v)).href]));
const here = fileURLToPath(new URL('.', import.meta.url));

interface FileRun {
  file: string;
  results: TestResult[];
  errors: SerializedError[];
  durationMs: number;
}

function runFile(file: string): Promise<FileRun> {
  const start = performance.now();
  return new Promise((done) => {
    const out: FileRun = { file, results: [], errors: [], durationMs: 0 };
    const child = fork(join(here, 'worker.js'), [resolve(cwd, file), namePattern ?? '', String(config.timeout), String(config.hookTimeout)], {
      execArgv: ['--enable-source-maps', '--no-warnings=ExperimentalWarning', '--import', pathToFileURL(join(here, 'register.js')).href],
      env: { ...process.env, SIQ_TEST_ALIASES: JSON.stringify(aliases) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let finished = false;
    child.on('message', (m: WorkerMessage) => {
      if (m.type === 'result') out.results.push(m.result);
      else if (m.type === 'file-error') out.errors.push(m.error);
      else finished = true;
    });
    child.on('exit', (code, signal) => {
      if (!finished) out.errors.push({ message: `the test process exited early (${signal ?? `code ${code}`})` });
      out.durationMs = performance.now() - start;
      done(out);
    });
  });
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);

/** Line diff of two inspected values, shortest edit script by LCS. */
function diff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  if (a.length * b.length > 250_000) return `${red('- Expected')}\n${expected}\n${green('+ Received')}\n${actual}`;
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const lines: string[] = [green('- Expected'), red('+ Received'), ''];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) lines.push(dim(`  ${a[i++]}`)), j++;
    else if (i < a.length && (j >= b.length || L[i + 1]![j]! >= L[i]![j + 1]!)) lines.push(green(`- ${a[i++]}`));
    else lines.push(red(`+ ${b[j++]}`));
  }
  return lines.join('\n');
}

function stackOf(e: SerializedError): string {
  const frames = (e.stack ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l) && !l.includes('node:') && !l.includes('/devkit/dist/test/') && !l.includes('node_modules'))
    .slice(0, 4)
    .map((l) => l.replace(`file://${cwd}/`, '').replace(`${cwd}/`, ''));
  return frames.map((f) => dim(`  ❯ ${f.trim().replace(/^at /, '')}`)).join('\n');
}

function describeError(e: SerializedError): string {
  const parts = [red(`${e.message}`)];
  if (e.diff && e.expected !== undefined && e.actual !== undefined) parts.push('', diff(e.expected, e.actual));
  const s = stackOf(e);
  if (s) parts.push('', s);
  if (e.cause) parts.push('', `Caused by: ${describeError(e.cause)}`);
  return parts.join('\n');
}

async function runAll(): Promise<boolean> {
  const started = performance.now();
  const files = findFiles();
  if (!files.length) {
    console.log(red('No test files found.'));
    return false;
  }
  console.log(`\n ${bold('RUN')} ${dim(cwd)}\n`);
  const queue = [...files];
  const runs: FileRun[] = [];
  const workers = Array.from({ length: Math.min(files.length, Math.max(1, availableParallelism() - 1)) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await runFile(f);
      runs.push(r);
      printFile(r);
    }
  });
  await Promise.all(workers);

  const all = runs.flatMap((r) => r.results);
  const failed = all.filter((r) => r.state === 'fail');
  const failedFiles = runs.filter((r) => r.errors.length || r.results.some((x) => x.state === 'fail'));
  if (failed.length || failedFiles.some((r) => r.errors.length)) {
    console.log(`\n${red(bold(`⎯⎯⎯⎯ Failed Tests ${failed.length} ⎯⎯⎯⎯`))}\n`);
    for (const r of runs) {
      for (const t of r.results.filter((x) => x.state === 'fail')) {
        console.log(`${red(bold(' FAIL '))} ${r.file} > ${t.path.join(' > ')}`);
        console.log(describeError(t.error ?? { message: 'failed' }) + '\n');
      }
      for (const e of r.errors) {
        console.log(`${red(bold(' FAIL '))} ${r.file}`);
        console.log(describeError(e) + '\n');
      }
    }
  }
  const count = (s: TestResult['state']) => all.filter((r) => r.state === s).length;
  const summary = (label: string, parts: Array<[number, string, (s: string) => string]>, total: number) =>
    console.log(
      `${label.padStart(11)}  ${parts
        .filter(([n]) => n)
        .map(([n, w, f]) => f(`${n} ${w}`))
        .join(' | ')} ${dim(`(${total})`)}`,
    );
  console.log('');
  summary('Test Files', [[failedFiles.length, 'failed', red], [runs.length - failedFiles.length, 'passed', green]], runs.length);
  summary('Tests', [[count('fail'), 'failed', red], [count('pass'), 'passed', green], [count('skip'), 'skipped', yellow], [count('todo'), 'todo', dim]], all.length);
  console.log(`${'Duration'.padStart(11)}  ${ms(performance.now() - started)}\n`);
  return failedFiles.length === 0;
}

function printFile(r: FileRun): void {
  const n = r.results.length;
  const failed = r.results.filter((x) => x.state === 'fail');
  const skipped = r.results.filter((x) => x.state === 'skip' || x.state === 'todo').length;
  const bad = failed.length || r.errors.length;
  const counts = `(${n} test${n === 1 ? '' : 's'}${failed.length ? ` | ${failed.length} failed` : ''}${skipped && skipped < n ? ` | ${skipped} skipped` : ''})`;
  const mark = bad ? red('❯') : skipped === n && n ? yellow('↓') : green('✓');
  console.log(` ${mark} ${r.file} ${dim(counts)} ${dim(ms(r.durationMs))}`);
  if (!bad && !namePattern && !filters.length) return;
  for (const t of r.results) {
    if (t.state === 'fail') console.log(`   ${red('×')} ${t.path.join(' > ')} ${dim(ms(t.durationMs))}\n     ${red(`→ ${t.error?.message.split('\n')[0] ?? ''}`)}`);
    else if (t.state === 'pass') console.log(`   ${green('✓')} ${t.path.join(' > ')} ${dim(ms(t.durationMs))}`);
    else console.log(`   ${yellow('↓')} ${t.path.join(' > ')}`);
  }
}

if (!watchMode) {
  process.exitCode = (await runAll()) ? 0 : 1;
} else {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  const go = async () => {
    if (running) return void (again = true);
    running = true;
    console.clear();
    await runAll();
    running = false;
    console.log(dim('Watching for changes...'));
    if (again) {
      again = false;
      void go();
    }
  };
  watch(cwd, { recursive: true }, (_e, f) => {
    if (!f || /(^|[/\\])(node_modules|dist|\.git)([/\\]|$)/.test(f) || !/\.(tsx?|json|css)$/.test(f)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void go(), 100);
  });
  void go();
}
