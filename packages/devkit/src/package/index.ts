import { createRequire } from 'node:module';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ar, tarGz, unzip, zip, type TarEntry, type ZipEntry } from './archive.js';

/**
 * Release packaging without electron-builder: lay out an unpacked app
 * (Electron's own files, renamed, plus our code in resources/app), then write
 * it as a .tar.gz and a .deb for Linux, or a .zip for Windows.
 *
 *   resources/app/                  package.json, dist/ (main process), renderer/ (UI)
 *   resources/app/node_modules/     @siteinquisition/{core,codecs,cli}: package.json + dist
 *   bin/siq (Linux), bin/siq.cmd    the CLI, run by the app's binary in Node mode
 */

export interface PackageOptions {
  /** Monorepo root. */
  root: string;
  /** Output folder; cleared first. */
  out: string;
  /** Which formats to write (the unpacked folder is always written). */
  formats?: Array<'tar.gz' | 'deb'>;
  /** Archive timestamps, for reproducible output. Defaults to SOURCE_DATE_EPOCH or 0. */
  mtime?: number;
}

export interface PackageResult {
  version: string;
  unpacked: string;
  files: string[];
}

const NAME = 'siteinquisition';
const PRODUCT = 'SiteInquisition';

const OUR_PACKAGES = ['codecs', 'core', 'cli'] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function electronDist(root: string): string {
  const req = createRequire(join(root, 'packages', 'app', 'package.json'));
  const dir = join(dirname(req.resolve('electron/package.json')), 'dist');
  if (!existsSync(join(dir, 'electron'))) throw new Error(`Electron's binary is missing in ${dir}; run "node install.js" in the electron package`);
  return dir;
}

function copyPackage(root: string, name: (typeof OUR_PACKAGES)[number], dest: string, version: string) {
  const src = join(root, 'packages', name);
  if (!existsSync(join(src, 'dist'))) throw new Error(`packages/${name} is not built; run pnpm build`);
  const pkg = readJson(join(src, 'package.json'));
  // Workspace links become plain version numbers; everything we ship is in this folder.
  const deps = Object.fromEntries(Object.keys((pkg.dependencies as Record<string, string>) ?? {}).map((d) => [d, version]));
  const out = join(dest, '@siteinquisition', name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'package.json'), JSON.stringify({ ...pkg, version, dependencies: deps, devDependencies: undefined, scripts: undefined }, null, 2));
  cpSync(join(src, 'dist'), join(out, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.map') && !f.endsWith('.d.ts') && !f.endsWith('.d.cts') });
}

/** Write the unpacked Linux app to `dir`. */
function layout(root: string, dir: string, version: string) {
  const electron = electronDist(root);
  cpSync(electron, dir, { recursive: true, verbatimSymlinks: true });
  rmSync(join(dir, 'resources', 'default_app.asar'), { force: true });
  const bin = join(dir, NAME);
  cpSync(join(dir, 'electron'), bin);
  rmSync(join(dir, 'electron'));
  chmodSync(bin, 0o755);
  addApp(root, dir, version);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(
    join(dir, 'bin', 'siq'),
    [
      '#!/bin/sh',
      '# The siq CLI, run by the SiteInquisition binary in Node mode.',
      'here="$(dirname "$(readlink -f "$0")")"',
      `ELECTRON_RUN_AS_NODE=1 exec "$here/../${NAME}" "$here/../resources/app/node_modules/@siteinquisition/cli/dist/main.js" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** Our part of the package, the same on every platform: resources/app and the license files. */
function addApp(root: string, dir: string, version: string) {
  const app = join(dir, 'resources', 'app');
  mkdirSync(app, { recursive: true });
  const appPkg = readJson(join(root, 'packages', 'app', 'package.json'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: NAME, productName: PRODUCT, version, description: appPkg.description, license: appPkg.license, type: 'module', main: 'dist/main.js' }, null, 2),
  );
  cpSync(join(root, 'packages', 'app', 'dist'), join(app, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.map') && !/\.d\.c?ts$/.test(f) });
  const ui = join(root, 'packages', 'ui', 'dist');
  if (!existsSync(join(ui, 'index.html'))) throw new Error('packages/ui is not built; run pnpm build');
  cpSync(ui, join(app, 'renderer'), { recursive: true });
  for (const p of OUR_PACKAGES) copyPackage(root, p, join(app, 'node_modules'), version);

  cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE.siteinquisition'));
  const notices = join(root, 'THIRD_PARTY_NOTICES.md');
  if (existsSync(notices)) cpSync(notices, join(dir, 'THIRD_PARTY_NOTICES.md'));
}

/** Every file, folder and link under `dir`, as tar entries under `prefix`. */
function entries(dir: string, prefix: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const rel = `${prefix}${relative(dir, p)}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push({ type: 'symlink', path: rel, target: readlinkSync(p) });
      else if (st.isDirectory()) {
        out.push({ type: 'dir', path: rel, mode: 0o755 });
        walk(p);
      } else {
        let mode = st.mode & 0o777;
        // Chromium's setuid sandbox helper; only takes effect when root unpacks or installs it.
        if (name === 'chrome-sandbox') mode = 0o4755;
        out.push({ type: 'file', path: rel, data: readFileSync(p), mode: mode & 0o111 ? mode | 0o755 : 0o644 });
      }
    }
  };
  walk(dir);
  return out;
}

function sizeKiB(dir: string): number {
  let total = 0;
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return Math.ceil(total / 1024);
}

const DESKTOP = `[Desktop Entry]
Name=${PRODUCT}
Comment=Intercepting proxy, built-in browser and replay toolkit for testing websites, APIs and IoT devices
Exec=/opt/${NAME}/${NAME} %U
Icon=${NAME}
Type=Application
Categories=Development;Network;
StartupWMClass=${PRODUCT}
Terminal=false
`;

function deb(root: string, unpacked: string, version: string, mtime: number): Buffer {
  const opt = `./opt/${NAME}/`;
  const data: TarEntry[] = [
    { type: 'dir', path: './' },
    { type: 'dir', path: './opt/' },
    { type: 'dir', path: opt },
    ...entries(unpacked, opt),
    { type: 'dir', path: './usr/' },
    { type: 'dir', path: './usr/bin/' },
    { type: 'symlink', path: `./usr/bin/${NAME}`, target: `/opt/${NAME}/${NAME}` },
    { type: 'symlink', path: './usr/bin/siq', target: `/opt/${NAME}/bin/siq` },
    { type: 'dir', path: './usr/share/' },
    { type: 'dir', path: './usr/share/applications/' },
    { type: 'file', path: `./usr/share/applications/${NAME}.desktop`, data: Buffer.from(DESKTOP) },
    { type: 'dir', path: './usr/share/icons/' },
    { type: 'dir', path: './usr/share/icons/hicolor/' },
    { type: 'dir', path: './usr/share/icons/hicolor/scalable/' },
    { type: 'dir', path: './usr/share/icons/hicolor/scalable/apps/' },
    { type: 'file', path: `./usr/share/icons/hicolor/scalable/apps/${NAME}.svg`, data: readFileSync(join(root, 'packages', 'app', 'build', 'icon.svg')) },
    { type: 'dir', path: './usr/share/doc/' },
    { type: 'dir', path: `./usr/share/doc/${NAME}/` },
    { type: 'file', path: `./usr/share/doc/${NAME}/copyright`, data: readFileSync(join(root, 'LICENSE')) },
  ];
  const control = [
    `Package: ${NAME}`,
    `Version: ${version.replace('-', '~')}`, // Debian sorts 1.0.0~beta.1 before 1.0.0
    'Architecture: amd64',
    'Maintainer: SiteInquisition <noreply@siteinquisition.invalid>',
    `Installed-Size: ${sizeKiB(unpacked)}`,
    'Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, libgbm1, libasound2 | libasound2t64, xdg-utils',
    'Recommends: libsecret-tools',
    'Section: devel',
    'Priority: optional',
    'Homepage: https://github.com/TTLComputer/SiteInquisition',
    'Description: Intercepting proxy and replay toolkit for unfinished websites and APIs',
    ' SiteInquisition records HTTP, WebSocket and MQTT traffic through a proxy or',
    ' its built-in browser, and lets you search, replay, edit and race requests.',
    '',
  ].join('\n');
  const postinst = `#!/bin/sh\nset -e\n# Chromium's sandbox helper must be setuid root.\nchmod 4755 /opt/${NAME}/chrome-sandbox || true\nupdate-desktop-database -q /usr/share/applications 2>/dev/null || true\n`;
  const ctrl: TarEntry[] = [
    { type: 'dir', path: './' },
    { type: 'file', path: './control', data: Buffer.from(control) },
    { type: 'file', path: './postinst', data: Buffer.from(postinst), mode: 0o755 },
  ];
  return ar(
    [
      { name: 'debian-binary', data: Buffer.from('2.0\n') },
      { name: 'control.tar.gz', data: tarGz(ctrl, mtime) },
      { name: 'data.tar.gz', data: tarGz(data, mtime) },
    ],
    mtime,
  );
}

export function packageLinux(opts: PackageOptions): PackageResult {
  const root = resolve(opts.root);
  const version = String(readJson(join(root, 'package.json')).version);
  const mtime = opts.mtime ?? Number(process.env.SOURCE_DATE_EPOCH ?? 0);
  const out = resolve(opts.out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const unpacked = join(out, 'linux-unpacked');
  layout(root, unpacked, version);
  const files: string[] = [];
  const formats = opts.formats ?? ['tar.gz', 'deb'];
  if (formats.includes('tar.gz')) {
    const base = `${NAME}-${version}-linux-x64`;
    const f = join(out, `${base}.tar.gz`);
    writeFileSync(f, tarGz([{ type: 'dir', path: `${base}/` }, ...entries(unpacked, `${base}/`)], mtime));
    files.push(f);
  }
  if (formats.includes('deb')) {
    const f = join(out, `${NAME}_${version}_amd64.deb`);
    writeFileSync(f, deb(root, unpacked, version, mtime));
    files.push(f);
  }
  for (const f of files) if (!statSync(f).size) throw new Error(`empty output ${f}`);
  return { version, unpacked, files };
}

// ---------- Windows ----------

export interface WindowsPackageOptions {
  root: string;
  /** Output folder; its win-unpacked folder and zip are replaced. */
  out: string;
  mtime?: number;
  /**
   * Electron's Windows release zip. Defaults to SIQ_ELECTRON_WIN32_ZIP, then
   * Electron's own dist on a Windows machine, then a download through
   * @electron/get (cached, checked against Electron's checksums).
   */
  electronZip?: string;
}

/** Electron's win32-x64 files, as zip entries. */
async function electronWin32(root: string, zipPath?: string): Promise<ZipEntry[]> {
  const given = zipPath ?? process.env.SIQ_ELECTRON_WIN32_ZIP;
  if (given) return unzip(readFileSync(given));
  const req = createRequire(join(root, 'packages', 'app', 'package.json'));
  const electronDir = dirname(req.resolve('electron/package.json'));
  if (process.platform === 'win32' && existsSync(join(electronDir, 'dist', 'electron.exe'))) {
    const dist = join(electronDir, 'dist');
    const out: ZipEntry[] = [];
    const walk = (abs: string) => {
      for (const name of readdirSync(abs).sort()) {
        const p = join(abs, name);
        const rel = relative(dist, p).split('\\').join('/');
        if (statSync(p).isDirectory()) {
          out.push({ path: `${rel}/` });
          walk(p);
        } else out.push({ path: rel, data: readFileSync(p) });
      }
    };
    walk(dist);
    return out;
  }
  const version = String(readJson(join(electronDir, 'package.json')).version);
  const fromElectron = createRequire(join(electronDir, 'package.json'));
  const { downloadArtifact } = fromElectron('@electron/get') as { downloadArtifact(o: Record<string, unknown>): Promise<string> };
  const file = await downloadArtifact({ version, artifactName: 'electron', platform: 'win32', arch: 'x64', checksums: fromElectron('./checksums.json') });
  return unzip(readFileSync(file));
}

const SIQ_CMD = [
  '@echo off',
  'rem The siq CLI, run by SiteInquisition.exe in Node mode.',
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=1',
  `"%~dp0..\\${PRODUCT}.exe" "%~dp0..\\resources\\app\\node_modules\\@siteinquisition\\cli\\dist\\main.js" %*`,
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

/**
 * Package for Windows x64: a portable zip that runs from any folder, and the
 * same files unpacked (for the smoke test). Works on Linux too.
 */
export async function packageWindows(opts: WindowsPackageOptions): Promise<PackageResult> {
  const root = resolve(opts.root);
  const version = String(readJson(join(root, 'package.json')).version);
  const mtime = opts.mtime ?? Number(process.env.SOURCE_DATE_EPOCH ?? 0);
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const unpacked = join(out, 'win-unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  const electron = await electronWin32(root, opts.electronZip);
  for (const e of electron) {
    let path = e.path;
    if (path === 'resources/default_app.asar') continue;
    if (path === 'electron.exe') path = `${PRODUCT}.exe`;
    const abs = join(unpacked, ...path.split('/'));
    if (!e.data) mkdirSync(abs, { recursive: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, e.data);
    }
  }
  if (!existsSync(join(unpacked, `${PRODUCT}.exe`))) throw new Error('the Electron zip has no electron.exe; is it the win32 build?');
  addApp(root, unpacked, version);
  mkdirSync(join(unpacked, 'bin'), { recursive: true });
  writeFileSync(join(unpacked, 'bin', 'siq.cmd'), SIQ_CMD);
  writeFileSync(
    join(unpacked, 'README.txt'),
    [
      `SiteInquisition ${version} for Windows (x64)`,
      '',
      'Run SiteInquisition.exe to start the app. Keep the folder together: the app needs every file in it.',
      'For the command line, add the bin folder to PATH and run: siq --help',
      'Uninstall by deleting this folder. Your data is in %APPDATA%\\SiteInquisition and your project folders;',
      'remove the CA from Windows first (certmgr.msc, Trusted Root Certification Authorities). See docs/ca-trust.md.',
      '',
    ].join('\r\n'),
  );
  const base = `${NAME}-${version}-win-x64`;
  const entries: ZipEntry[] = [{ path: `${base}/` }];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const rel = `${base}/${relative(unpacked, p).split('\\').join('/')}`;
      if (statSync(p).isDirectory()) {
        entries.push({ path: `${rel}/` });
        walk(p);
      } else entries.push({ path: rel, data: readFileSync(p) });
    }
  };
  walk(unpacked);
  const file = join(out, `${base}.zip`);
  writeFileSync(file, zip(entries, mtime));
  return { version, unpacked, files: [file] };
}
