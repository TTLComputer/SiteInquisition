import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InitializeHook, LoadHook, ResolveHook } from 'node:module';
import ts from 'typescript';

/**
 * Module hooks for test runs: TypeScript files are compiled one at a time
 * with transpileModule (no type checking, like vitest), `./x.js` imports
 * find `./x.ts`, and configured aliases point packages at their sources.
 */
let aliases: Record<string, string> = {};

export const initialize: InitializeHook<{ aliases: Record<string, string> }> = (data) => {
  aliases = data?.aliases ?? {};
};

const TS = /\.(c|m)?tsx?$/;

export const resolve: ResolveHook = async (specifier, context, next) => {
  const alias = aliases[specifier];
  if (alias) return { url: alias, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (e) {
    const parent = context.parentURL;
    if (!parent || !(specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:'))) throw e;
    const base = new URL(specifier, parent);
    const candidates = /\.(m|c)?jsx?$/.test(base.pathname)
      ? [base.href.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'), base.href.replace(/\.js$/, '.tsx')]
      : [`${base.href}.ts`, `${base.href}.tsx`, `${base.href}/index.ts`, `${base.href}.js`];
    for (const c of candidates) if (existsSync(fileURLToPath(c))) return { url: c, shortCircuit: true };
    throw e;
  }
};

const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  isolatedModules: true,
  inlineSourceMap: true,
  inlineSources: true,
  useDefineForClassFields: true,
};

export const load: LoadHook = async (url, context, next) => {
  if (!url.startsWith('file:') || !TS.test(new URL(url).pathname)) return next(url, context);
  const file = fileURLToPath(url);
  const out = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: OPTIONS, reportDiagnostics: false });
  return { format: 'module', source: out.outputText, shortCircuit: true };
};

export const toUrl = (p: string) => pathToFileURL(p).href;
