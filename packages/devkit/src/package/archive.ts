import { crc32, deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib';

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

// ---------- zip (Windows packages) ----------

export interface ZipEntry {
  /** Forward slashes; folders end with '/'. */
  path: string;
  data?: Buffer;
}

/** MS-DOS date and time, as zip stores them (local time has no meaning in a reproducible build, so UTC). */
function dosTime(epochSeconds: number): { time: number; date: number } {
  const d = new Date(Math.max(epochSeconds, 315_532_800) * 1000); // zip cannot go before 1980
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Write a zip archive (deflate, or stored when that is smaller). No ZIP64:
 * it throws past 4 GB or 65535 entries, far beyond an app package. Same
 * input, same bytes.
 */
export function zip(entries: ZipEntry[], mtime = 0): Buffer {
  const { time, date } = dosTime(mtime);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const raw = e.data ?? Buffer.alloc(0);
    const crc = crc32(raw);
    const deflated = raw.length ? deflateRawSync(raw, { level: 9 }) : raw;
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    const dir = e.path.endsWith('/');
    if (body.length > 0xfffffffe || raw.length > 0xfffffffe || offset > 0xfffffffe) throw new Error(`zip entry too large: ${e.path}`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by: MS-DOS, so Windows tools apply no Unix modes
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(dir ? 0x10 : 0x20, 38); // DOS attributes: directory or archive
    c.writeUInt32LE(offset, 42);
    chunks.push(local, name, body);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  if (entries.length > 0xfffe || offset > 0xfffffffe) throw new Error('zip too large; split the package');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/** Read a zip archive (stored and deflate entries; what Electron's own release zips use). */
export function unzip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = buf.readUInt32LE(eocd - 20) === 0x07064b50 ? Number(buf.readBigUInt64LE(eocd - 12)) : -1;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x06064b50) throw new Error('bad ZIP64 records');
    count = Number(buf.readBigUInt64LE(loc + 32));
    cdOffset = Number(buf.readBigUInt64LE(loc + 48));
  }
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const path = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra field: the sizes and offset that did not fit, in this order.
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const id = buf.readUInt16LE(x);
      const size = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let y = x + 4;
        if (usize === 0xffffffff) ((usize = Number(buf.readBigUInt64LE(y))), (y += 8));
        if (csize === 0xffffffff) ((csize = Number(buf.readBigUInt64LE(y))), (y += 8));
        if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(y));
      }
      x += 4 + size;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad zip entry ${path}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    if (path.endsWith('/')) {
      out.push({ path });
      continue;
    }
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${path} uses compression method ${method}`);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (data.length !== usize || crc32(data) !== buf.readUInt32LE(p - (46 + nameLen + extraLen + commentLen) + 16)) throw new Error(`zip entry ${path} is corrupt`);
    out.push({ path, data });
  }
  return out;
}
