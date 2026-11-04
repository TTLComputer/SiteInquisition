import { gzipSync } from 'node:zlib';

/**
 * Minimal archive writers for release packaging: POSIX ustar (with the
 * prefix field for long paths) and the `ar` format Debian packages use.
 * Entries are written in the order given, with a fixed mtime, so the same
 * input gives the same bytes.
 */

export type TarEntry =
  | { type: 'file'; path: string; data: Buffer; mode?: number }
  | { type: 'dir'; path: string; mode?: number }
  | { type: 'symlink'; path: string; target: string };

const BLOCK = 512;

function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  // ustar: prefix (155 bytes) + '/' + name (100 bytes), split at a slash.
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  throw new Error(`path too long for a tar archive: ${path}`);
}

function octal(buf: Buffer, off: number, len: number, value: number) {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

function header(e: TarEntry, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const path = e.type === 'dir' && !e.path.endsWith('/') ? `${e.path}/` : e.path;
  const { name, prefix } = splitPath(path);
  h.write(name, 0, 100, 'utf8');
  const mode = e.type === 'symlink' ? 0o777 : (e.mode ?? (e.type === 'dir' ? 0o755 : 0o644));
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0); // uid
  octal(h, 116, 8, 0); // gid
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(' ', 148, 156); // checksum placeholder
  h.write(e.type === 'file' ? '0' : e.type === 'dir' ? '5' : '2', 156, 1, 'ascii');
  if (e.type === 'symlink') h.write(e.target, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

export function tar(entries: TarEntry[], mtime = 0): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.type === 'symlink' && Buffer.byteLength(e.target) > 100) throw new Error(`symlink target too long: ${e.target}`);
    const data = e.type === 'file' ? e.data : Buffer.alloc(0);
    parts.push(header(e, data.length, mtime));
    if (data.length) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export const tarGz = (entries: TarEntry[], mtime = 0) => gzipSync(tar(entries, mtime), { level: 9 });

/** An `ar` archive (as used by .deb): global header, then 60-byte member headers. */
export function ar(members: Array<{ name: string; data: Buffer }>, mtime = 0): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'ascii')];
  for (const m of members) {
    if (m.name.length > 16) throw new Error(`ar member name too long: ${m.name}`);
    const h = Buffer.alloc(60, ' ');
    h.write(m.name, 0, 'ascii');
    h.write(String(mtime), 16, 'ascii');
    h.write('0', 28, 'ascii');
    h.write('0', 34, 'ascii');
    h.write('100644', 40, 'ascii');
    h.write(String(m.data.length), 48, 'ascii');
    h.write('`\n', 58, 'ascii');
    parts.push(h, m.data);
    if (m.data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}
