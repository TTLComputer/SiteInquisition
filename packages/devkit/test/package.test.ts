import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { ar, tar, tarGz, unzip, zip } from '../src/package/archive.js';

const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

describe('release archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'siq-pkg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(40)}.js`;

  it.skipIf(!has('tar'))('writes tar files that tar reads back: files, modes, folders, links, long paths', () => {
    const file = join(dir, 'x.tar.gz');
    writeFileSync(
      file,
      tarGz(
        [
          { type: 'dir', path: 'app/' },
          { type: 'file', path: 'app/run', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
          { type: 'file', path: 'app/empty', data: Buffer.alloc(0) },
          { type: 'symlink', path: 'app/link', target: 'run' },
          { type: 'file', path: `app/${long}`, data: Buffer.alloc(700, 7) },
        ],
        1_700_000_000,
      ),
    );
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync('tar', ['xzf', file, '-C', out]);
    expect(readFileSync(join(out, 'app/run'), 'utf8')).toContain('echo hi');
    expect(statSync(join(out, 'app/run')).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, 'app/empty')).size).toBe(0);
    expect(readlinkSync(join(out, 'app/link'))).toBe('run');
    expect(readFileSync(join(out, 'app', long))).toEqual(Buffer.alloc(700, 7));
    expect(statSync(join(out, 'app/run')).mtimeMs).toBe(1_700_000_000_000);
  });

  it('pads every entry to 512-byte blocks and ends with two empty blocks', () => {
    const t = tar([{ type: 'file', path: 'a', data: Buffer.from('xyz') }]);
    expect(t.length).toBe(512 * 4);
    expect(t.subarray(512 * 2).every((b) => b === 0)).toBe(true);
    expect(() => tar([{ type: 'file', path: 'x'.repeat(300), data: Buffer.alloc(0) }])).toThrow(/too long/);
  });

  it('writes ar archives with even-aligned members', () => {
    const a = ar([
      { name: 'debian-binary', data: Buffer.from('2.0\n') },
      { name: 'odd', data: Buffer.from('abc') },
      { name: 'next', data: Buffer.from('z') },
    ]);
    expect(a.subarray(0, 8).toString()).toBe('!<arch>\n');
    const second = 8 + 60 + 4;
    expect(a.subarray(second, second + 3).toString()).toBe('odd');
    // 'abc' is padded to 4 bytes, so the next header starts on an even offset.
    const third = second + 60 + 4;
    expect(a.subarray(third, third + 4).toString()).toBe('next');
    if (has('ar')) {
      const f = join(dir, 'x.ar');
      writeFileSync(f, a);
      expect(execFileSync('ar', ['t', f], { encoding: 'utf8' }).trim().split('\n')).toEqual(['debian-binary', 'odd', 'next']);
    }
  });

  it('writes zip files that it and other tools read back', () => {
    const big = Buffer.alloc(100_000, 'abc');
    const random = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251));
    const z = zip(
      [
        { path: 'app/' },
        { path: 'app/SiteInquisition.exe', data: random },
        { path: 'app/bin/siq.cmd', data: Buffer.from('@echo off\r\n') },
        { path: 'app/big.txt', data: big },
        { path: 'app/empty', data: Buffer.alloc(0) },
        { path: `app/${long}`, data: Buffer.from('deep') },
      ],
      1_700_000_000,
    );
    expect(z.length).toBeLessThan(big.length); // deflated
    const back = unzip(z);
    expect(back.map((e) => e.path)).toEqual(['app/', 'app/SiteInquisition.exe', 'app/bin/siq.cmd', 'app/big.txt', 'app/empty', `app/${long}`]);
    expect(back[1]!.data).toEqual(random);
    expect(back[3]!.data).toEqual(big);
    expect(back[4]!.data).toEqual(Buffer.alloc(0));
    expect(zip([{ path: 'a', data: Buffer.from('x') }], 1_700_000_000)).toEqual(zip([{ path: 'a', data: Buffer.from('x') }], 1_700_000_000));
    const flipped = Buffer.from(z);
    flipped[60] ^= 0xff;
    expect(() => unzip(flipped)).toThrow();
    if (has('python3')) {
      const f = join(dir, 'x.zip');
      writeFileSync(f, z);
      const r = spawnSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))', f], { encoding: 'utf8' });
      expect(r.stdout.trim().split('\n')).toEqual(['None', '6']);
    }
  });
});
