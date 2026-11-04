import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { BundleError, bundle, foldConstantBranches } from '../src/bundle/index.js';

let dir: string;
const put = (rel: string, text: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-bundle-'));
  put('package.json', '{"name":"page","private":true}');
  put('index.html', '<!doctype html><html><head><title>t</title></head><body><script type="module" src="./src/main.tsx"></script></body></html>');
  put(
    'src/main.tsx',
    `import './app.css';
import lib, { flavour } from 'lib';
import cjs from 'cjs-lib';
import { greet } from './greet.js';
import data from './data.json';
import type { Unused } from './types';
const el = <b title="x">{greet('bundle')}</b>;
(globalThis as any).out = { greet: greet('there'), lib, flavour, cjs, data, el, mode: process.env.NODE_ENV };
`,
  );
  put('src/greet.ts', 'export const greet = (who: string): string => `hello ${who}`;\n');
  put('src/types.ts', 'export interface Unused { a: number }\n');
  put('src/data.json', '{ "n": 3 }');
  put('src/app.css', "@import './base.css';\nbody { font-family: Demo; }\n@font-face { src: url(./fonts/demo.woff2) format('woff2'), url('data:font/woff2;base64,AA'); }\n");
  put('src/base.css', 'html { color: red; }\n');
  put('src/fonts/demo.woff2', Buffer.from([1, 2, 3, 4]));
  // An ES module package with conditional exports.
  put('node_modules/lib/package.json', JSON.stringify({ name: 'lib', type: 'module', exports: { '.': { types: './x.d.ts', node: './node.js', browser: './browser.js', default: './node.js' } } }));
  put('node_modules/lib/browser.js', "export default 'browser build';\nexport const flavour = 'esm';\n");
  put('node_modules/lib/node.js', "throw new Error('the node build was bundled');\n");
  // A CommonJS package that picks its build like React does.
  put('node_modules/cjs-lib/package.json', JSON.stringify({ name: 'cjs-lib', main: 'index.js' }));
  put('node_modules/cjs-lib/index.js', "'use strict';\nif (process.env.NODE_ENV === 'production') {\n  module.exports = require('./prod.js');\n} else {\n  module.exports = require('./dev.js');\n}\n");
  put('node_modules/cjs-lib/prod.js', "module.exports = 'prod build';\n");
  put('node_modules/cjs-lib/dev.js', "module.exports = require('does-not-exist');\n");
  // A JSX runtime stand-in, so the test does not need React.
  put('node_modules/react/package.json', JSON.stringify({ name: 'react', exports: { './jsx-runtime': './jsx.js' } }));
  put('node_modules/react/jsx.js', 'exports.jsx = (type, props) => ({ type, props });\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('bundle', () => {
  it('bundles TypeScript, JSX, ES and CommonJS packages, JSON and CSS with assets', () => {
    const r = bundle({ root: dir });
    const html = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    const js = r.files.find((f) => f.path.endsWith('.js'))!.path;
    const css = r.files.find((f) => f.path.endsWith('.css'))!.path;
    expect(html).toContain(`<script defer src="./${js}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="./${css}" />`);
    expect(js).toMatch(/^assets\/index-[A-Za-z0-9]{8}\.js$/);

    const ctx: { out?: Record<string, unknown> } = {};
    runInNewContext(readFileSync(join(dir, 'dist', js), 'utf8'), { globalThis: ctx });
    expect(ctx.out).toEqual({
      greet: 'hello there',
      lib: 'browser build',
      flavour: 'esm',
      cjs: 'prod build',
      data: { n: 3 },
      el: { type: 'b', props: { title: 'x', children: 'hello bundle' } },
      mode: 'production',
    });

    const sheet = readFileSync(join(dir, 'dist', css), 'utf8');
    expect(sheet.indexOf('html { color: red; }')).toBeLessThan(sheet.indexOf('body { font-family: Demo; }'));
    const font = r.files.find((f) => f.path.endsWith('.woff2'))!;
    expect(font.path).toMatch(/^assets\/demo-[A-Za-z0-9]{8}\.woff2$/);
    expect(sheet).toContain(`url(./${font.path.slice(7)})`);
    expect(sheet).toContain("url('data:font/woff2;base64,AA')");
    expect(r.inputs).toContain(join(dir, 'src/greet.ts'));
  });

  it('names an import it cannot find', () => {
    put('bad/package.json', '{}');
    put('bad/index.html', '<script src="./main.ts"></script>');
    put('bad/main.ts', "import './missing.js';\n");
    expect(() => bundle({ root: join(dir, 'bad') })).toThrow(BundleError);
    expect(() => bundle({ root: join(dir, 'bad') })).toThrow(/cannot find \.\/missing\.js/);
  });
});

describe('foldConstantBranches', () => {
  it('keeps only the live branch of literal comparisons', () => {
    expect(foldConstantBranches(`if ("production" !== "production") { a(); } else { b(); }`).trim()).toBe('{ b(); }');
    expect(foldConstantBranches(`x = "a" === "a" ? 1 : 2;`)).toBe('x = (1);');
    expect(foldConstantBranches(`if ("a" === "b") { a(); }\nrest();`).trim()).toBe('rest();');
    expect(foldConstantBranches(`if (!("a" === "b") && "x" == "x") { keep(); if ("p" !== "p") drop(); }`).trim()).toBe('{ keep();  }');
    expect(foldConstantBranches(`if (a === "b") x();`)).toBe('if (a === "b") x();');
  });
});
