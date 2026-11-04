import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve as resolvePath } from 'node:path';
import ts from 'typescript';

/**
 * A small bundler for the renderer. It reads the entry script from
 * index.html, follows imports through TypeScript, JSX, ES modules and
 * CommonJS packages, and writes one script, one stylesheet and the assets
 * the stylesheet points at, with content hashes in the names.
 *
 * Every module is compiled to CommonJS with TypeScript's transpileModule
 * and wrapped in a function, so ES modules and packages like React share one
 * module system. `define` replacements (process.env.NODE_ENV) are applied
 * before dependencies are read, and `if` branches they make constant are
 * dropped, so React's development build is never pulled in.
 */
export interface BundleOptions {
  /** The package directory; index.html and outDir are relative to it. */
  root: string;
  html?: string;
  outDir?: string;
  /** Exact text replacements in JavaScript, e.g. process.env.NODE_ENV → "production". */
  define?: Record<string, string>;
  /** Package specifiers mapped to files, relative to root. */
  alias?: Record<string, string>;
  /** Called with each HTML string before it is written; the dev server uses it. */
  transformHtml?: (html: string) => string;
  /** Empty outDir first (default true). */
  emptyOutDir?: boolean;
}

export interface BundleResult {
  /** Output files, relative to outDir, with their sizes. */
  files: Array<{ path: string; bytes: number }>;
  /** Source files the bundle read, for watching. */
  inputs: string[];
  modules: number;
  durationMs: number;
}

interface Module {
  id: number;
  file: string;
  kind: 'js' | 'css' | 'json' | 'asset';
  code: string;
  /** Specifier → module id. */
  deps: Record<string, number>;
}

const JS_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];
const RESOLVE_EXT = [...JS_EXT, '.json', '.css'];
const CONDITIONS = ['browser', 'import', 'module', 'default', 'require'];

const transformCache = new Map<string, { mtimeMs: number; size: number; code: string; requires: string[] }>();

export class BundleError extends Error {
  override name = 'BundleError';
}

/** Find a package's directory by walking up node_modules folders. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return realpathSync(p);
    if (dirname(dir) === dir) return undefined;
  }
}

function pickExport(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = pickExport(t);
      if (r) return r;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    for (const c of CONDITIONS) if (c in target) {
      const r = pickExport((target as Record<string, unknown>)[c]);
      if (r) return r;
    }
  }
  return undefined;
}

/** Resolve "./sub" against a package.json "exports" field, including "./x/*" patterns. */
function resolveExports(exportsField: unknown, sub: string): string | undefined {
  const map: Record<string, unknown> =
    typeof exportsField === 'string' || Array.isArray(exportsField) || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((k) => k.startsWith('.')))
      ? { '.': exportsField }
      : (exportsField as Record<string, unknown>);
  if (sub in map) return pickExport(map[sub]);
  // Like Node: the pattern with the longest prefix wins, then the longest key.
  const patterns = Object.entries(map)
    .filter(([k]) => k.includes('*'))
    .sort(([a], [b]) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const [k, v] of patterns) {
    const star = k.indexOf('*');
    const pre = k.slice(0, star);
    const post = k.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const hit = pickExport(v);
      if (hit) return hit.replace('*', sub.slice(pre.length, sub.length - post.length));
    }
  }
  return undefined;
}

function tryFile(base: string): string | undefined {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (isFile(base)) return base;
  const swapped = base.replace(/\.js$/, '.ts');
  if (swapped !== base) {
    if (isFile(swapped)) return swapped;
    if (isFile(swapped + 'x')) return swapped + 'x';
  }
  for (const e of RESOLVE_EXT) if (isFile(base + e)) return base + e;
  for (const e of RESOLVE_EXT) if (isFile(join(base, 'index' + e))) return join(base, 'index' + e);
  return undefined;
}

function resolveSpecifier(spec: string, fromFile: string, alias: Record<string, string>): string {
  if (alias[spec]) return alias[spec]!;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const hit = tryFile(resolvePath(dirname(fromFile), spec));
    if (hit) return hit;
    throw new BundleError(`cannot find ${spec} (imported by ${fromFile})`);
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
  const dir = findPackage(name, dirname(fromFile));
  if (!dir) throw new BundleError(`cannot find package ${name} (imported by ${fromFile})`);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; browser?: unknown; module?: string; main?: string };
  let target: string | undefined;
  if (pkg.exports !== undefined) {
    target = resolveExports(pkg.exports, sub ? `./${sub}` : '.');
    if (!target) throw new BundleError(`${name} does not export ${sub ? `./${sub}` : '.'} (imported by ${fromFile})`);
  } else if (sub) target = sub;
  else target = (typeof pkg.browser === 'string' ? pkg.browser : undefined) ?? pkg.module ?? pkg.main ?? 'index.js';
  const hit = tryFile(join(dir, target));
  if (!hit) throw new BundleError(`cannot find ${spec} at ${join(dir, target)} (imported by ${fromFile})`);
  return hit;
}

const hasEsmSyntax = (code: string) => /^\s*(import\s*[\w{*'"]|export\s)/m.test(code) || /\bimport\.meta\b/.test(code);

/** Drop `if` branches and `?:` arms whose test compares two string literals. */
export function foldConstantBranches(code: string, file = 'module.js'): string {
  if (!/(['"])[^'"\n]*\1\s*[!=]==?\s*(['"])/.test(code)) return code;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const constant = (e: ts.Expression): boolean | undefined => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = constant(e.operand);
      return v === undefined ? undefined : !v;
    }
    if (!ts.isBinaryExpression(e)) return undefined;
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const l = constant(e.left);
      const r = constant(e.right);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return l === false || r === false ? false : l === true && r === true ? true : undefined;
      return l === true || r === true ? true : l === false && r === false ? false : undefined;
    }
    if (!ts.isStringLiteral(e.left) || !ts.isStringLiteral(e.right)) return undefined;
    const same = e.left.text === e.right.text;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) return same;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return !same;
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      const v = constant(n.expression);
      if (v !== undefined) {
        const keep = v ? n.thenStatement : n.elseStatement;
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: keep ? keep.getText(sf) : '' });
        if (keep) visit(keep);
        return;
      }
    }
    if (ts.isConditionalExpression(n)) {
      const v = constant(n.condition);
      if (v !== undefined) {
        const keep = v ? n.whenTrue : n.whenFalse;
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `(${keep.getText(sf)})` });
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!edits.length) return code;
  // Nested folds are inside an outer kept branch; apply only the outermost edits, then fold again.
  edits.sort((a, b) => a.start - b.start);
  const outer: typeof edits = [];
  for (const e of edits) if (!outer.length || e.start >= outer[outer.length - 1]!.end) outer.push(e);
  let out = code;
  for (const e of outer.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return foldConstantBranches(out, file);
}

function applyDefines(code: string, define: Record<string, string>): string {
  let out = code;
  for (const [k, v] of Object.entries(define)) {
    if (!out.includes(k)) continue;
    const re = new RegExp(`(?<![\\w$.])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');
    out = out.replace(re, v);
  }
  return out;
}

const REQUIRE = /(?<![\w$.])require\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function transformJs(file: string, define: Record<string, string>): { code: string; requires: string[] } {
  const st = statSync(file);
  const key = `${file}\0${JSON.stringify(define)}`;
  const cached = transformCache.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let code = readFileSync(file, 'utf8');
  const ext = extname(file);
  if (ext === '.ts' || ext === '.tsx' || ext === '.jsx' || ext === '.mjs' || hasEsmSyntax(code)) {
    code = ts.transpileModule(code, {
      fileName: file,
      reportDiagnostics: false,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        isolatedModules: true,
        removeComments: !file.includes('node_modules'),
        useDefineForClassFields: true,
        allowJs: true,
      },
    }).outputText.replace(/\n\/\/# sourceMappingURL=.*$/, '');
  }
  const defined = applyDefines(code, define);
  if (defined !== code) code = foldConstantBranches(defined, file);
  const requires = [...code.matchAll(REQUIRE)].map((m) => m[2]!);
  const out = { mtimeMs: st.mtimeMs, size: st.size, code, requires: [...new Set(requires)] };
  transformCache.set(key, out);
  return out;
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('base64url').replace(/[-_]/g, '').slice(0, 8);

/** Build the page. Throws BundleError for imports that cannot be resolved. */
export function bundle(opts: BundleOptions): BundleResult {
  const started = performance.now();
  const root = resolvePath(opts.root);
  const htmlFile = join(root, opts.html ?? 'index.html');
  const outDir = join(root, opts.outDir ?? 'dist');
  const define = opts.define ?? { 'process.env.NODE_ENV': '"production"' };
  const alias = Object.fromEntries(Object.entries(opts.alias ?? {}).map(([k, v]) => [k, resolvePath(root, v)]));
  const html = readFileSync(htmlFile, 'utf8');
  const entryTag = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/.exec(html);
  if (!entryTag) throw new BundleError(`${htmlFile} has no <script src="..."> entry`);
  const entry = resolveSpecifier(entryTag[1]!.startsWith('.') ? entryTag[1]! : `./${entryTag[1]}`, htmlFile, alias);

  const modules = new Map<string, Module>();
  const order: Module[] = [];
  const cssOrder: Module[] = [];

  const add = (file: string): Module => {
    const known = modules.get(file);
    if (known) return known;
    const ext = extname(file);
    const kind: Module['kind'] = ext === '.css' ? 'css' : ext === '.json' ? 'json' : JS_EXT.includes(ext) ? 'js' : 'asset';
    const m: Module = { id: modules.size, file, kind, code: '', deps: {} };
    modules.set(file, m);
    order.push(m);
    if (kind === 'js') {
      const t = transformJs(file, define);
      m.code = t.code;
      for (const spec of t.requires) m.deps[spec] = add(resolveSpecifier(spec, file, alias)).id;
    } else if (kind === 'json') {
      m.code = `module.exports = ${readFileSync(file, 'utf8').trim()};`;
    } else if (kind === 'css') {
      cssOrder.push(m);
      m.code = 'module.exports = {};';
    } else {
      throw new BundleError(`cannot import ${file} from JavaScript; only scripts, JSON and CSS are supported`);
    }
    return m;
  };
  add(entry);

  if (opts.emptyOutDir !== false) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  const files: BundleResult['files'] = [];
  const inputs = new Set<string>([htmlFile, ...modules.keys()]);
  const write = (rel: string, data: string | Buffer) => {
    writeFileSync(join(outDir, rel), data);
    files.push({ path: rel, bytes: Buffer.byteLength(data) });
  };

  // Stylesheets: inline @import, copy url() assets under hashed names.
  const assetNames = new Map<string, string>();
  const seenCss = new Set<string>();
  const readCss = (file: string): string => {
    if (seenCss.has(file)) return '';
    seenCss.add(file);
    inputs.add(file);
    let css = readFileSync(file, 'utf8');
    css = css.replace(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?\s*;/g, (_m, _q, spec: string) => readCss(resolveSpecifier(spec, file, alias)));
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, ref: string) => {
      if (/^(data:|https?:|#|\/\/)/.test(ref)) return m;
      const clean = ref.split(/[?#]/)[0]!;
      const src = resolvePath(dirname(file), clean);
      if (!existsSync(src)) throw new BundleError(`${file} points at ${ref}, which does not exist`);
      let name = assetNames.get(src);
      if (!name) {
        const data = readFileSync(src);
        const ext = extname(src);
        name = `${basename(src, ext)}-${hash(data)}${ext}`;
        assetNames.set(src, name);
        write(`assets/${name}`, data);
      }
      return `url(./${name})`;
    });
  };
  const css = cssOrder.map((m) => `/* ${relative(root, m.file)} */\n${readCss(m.file)}`).join('\n');

  const body = order
    .map((m) => `[function (module, exports, require) {\n${m.code}\n}, ${JSON.stringify(m.deps)}]`)
    .join(',\n');
  const js = `(function () {
var process = { env: ${JSON.stringify(Object.fromEntries(Object.entries(define).filter(([k]) => k.startsWith('process.env.')).map(([k, v]) => [k.slice(12), JSON.parse(v)])))} };
var defs = [
${body}
];
var cache = [];
function load(id) {
  var hit = cache[id];
  if (hit) return hit.exports;
  var module = (cache[id] = { exports: {} });
  var def = defs[id];
  def[0].call(module.exports, module, module.exports, function (spec) {
    var dep = def[1][spec];
    if (dep === undefined) throw new Error('module not bundled: ' + spec);
    return load(dep);
  });
  return module.exports;
}
load(0);
})();
`;
  const jsName = `assets/index-${hash(js)}.js`;
  write(jsName, js);
  let page = html.replace(entryTag[0], `<script defer src="./${jsName}"></script>`);
  if (css) {
    const cssName = `assets/index-${hash(css)}.css`;
    write(cssName, css);
    page = page.replace(/<\/head>/i, `  <link rel="stylesheet" href="./${cssName}" />\n  </head>`);
  }
  if (opts.transformHtml) page = opts.transformHtml(page);
  write('index.html', page);
  return { files, inputs: [...inputs], modules: modules.size, durationMs: performance.now() - started };
}
