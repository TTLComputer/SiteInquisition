/**
 * A passive HTTP/2 reader: it watches the bytes of a connection the proxy
 * relays untouched (an h2c upgrade the server accepted) and reports the
 * requests and responses on it, without changing a byte. One HPACK decoder
 * per direction keeps up with each side's dynamic table (RFC 7541), and the
 * frame reader follows HEADERS, CONTINUATION, DATA and RST_STREAM
 * (RFC 9113). It never writes, so a malformed stream only stops the record.
 */
import { huffmanDecode } from './quic/huffman.js';

type Field = [string, string];

/** RFC 7541 appendix A. Index 1 is the first entry. */
const STATIC: Field[] = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'], [':path', '/index.html'], [':scheme', 'http'], [':scheme', 'https'],
  [':status', '200'], [':status', '204'], [':status', '206'], [':status', '304'], [':status', '400'], [':status', '404'], [':status', '500'],
  ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'], ['accept-language', ''], ['accept-ranges', ''], ['accept', ''],
  ['access-control-allow-origin', ''], ['age', ''], ['allow', ''], ['authorization', ''], ['cache-control', ''], ['content-disposition', ''],
  ['content-encoding', ''], ['content-language', ''], ['content-length', ''], ['content-location', ''], ['content-range', ''], ['content-type', ''],
  ['cookie', ''], ['date', ''], ['etag', ''], ['expect', ''], ['expires', ''], ['from', ''], ['host', ''], ['if-match', ''], ['if-modified-since', ''],
  ['if-none-match', ''], ['if-range', ''], ['if-unmodified-since', ''], ['last-modified', ''], ['link', ''], ['location', ''], ['max-forwards', ''],
  ['proxy-authenticate', ''], ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''], ['retry-after', ''], ['server', ''],
  ['set-cookie', ''], ['strict-transport-security', ''], ['transfer-encoding', ''], ['user-agent', ''], ['vary', ''], ['via', ''], ['www-authenticate', ''],
];

/** Decodes header blocks from one side of a connection. */
export class HpackDecoder {
  private table: Field[] = [];
  private size = 0;
  private max = 4096;

  decode(block: Uint8Array): Field[] {
    const out: Field[] = [];
    let p = 0;
    const int = (prefix: number): number => {
      const mask = (1 << prefix) - 1;
      let v = block[p++]! & mask;
      if (v < mask) return v;
      let m = 0;
      let b: number;
      do {
        if (p >= block.length) throw new Error('truncated integer');
        b = block[p++]!;
        v += (b & 0x7f) * 2 ** m;
        m += 7;
      } while (b & 0x80);
      return v;
    };
    const str = (): string => {
      if (p >= block.length) throw new Error('truncated string');
      const huff = (block[p]! & 0x80) !== 0;
      const n = int(7);
      if (p + n > block.length) throw new Error('truncated string');
      const raw = block.subarray(p, p + n);
      p += n;
      return Buffer.from(huff ? huffmanDecode(raw) : raw).toString('latin1');
    };
    const entry = (i: number): Field => {
      if (i >= 1 && i <= STATIC.length) return STATIC[i - 1]!;
      const d = this.table[i - STATIC.length - 1];
      if (!d) throw new Error(`bad HPACK index ${i}`);
      return d;
    };
    while (p < block.length) {
      const b = block[p]!;
      if (b & 0x80) out.push(entry(int(7)));
      else if (b & 0x40) {
        const i = int(6);
        const f: Field = [i ? entry(i)[0] : str(), str()];
        this.insert(f);
        out.push(f);
      } else if (b & 0x20) {
        this.max = int(5);
        this.evict();
      } else {
        const i = int(4);
        out.push([i ? entry(i)[0] : str(), str()]);
      }
    }
    return out;
  }

  private insert(f: Field): void {
    this.table.unshift(f);
    this.size += f[0].length + f[1].length + 32;
    this.evict();
  }

  private evict(): void {
    while (this.size > this.max && this.table.length) {
      const f = this.table.pop()!;
      this.size -= f[0].length + f[1].length + 32;
    }
  }
}

export interface TapEvents {
  headers(stream: number, fields: Field[], endStream: boolean): void;
  data(stream: number, data: Buffer, endStream: boolean): void;
  reset(stream: number, code: number): void;
}

const PREFACE_LEN = 24;

/** Reads the frames one side sends. `client` skips the connection preface first. */
export class H2Tap {
  private buf: Buffer = Buffer.alloc(0);
  private skip: number;
  private hpack = new HpackDecoder();
  private pending?: { stream: number; endStream: boolean; parts: Buffer[]; promise?: boolean };
  private broken = false;

  constructor(
    client: boolean,
    private readonly on: TapEvents,
  ) {
    this.skip = client ? PREFACE_LEN : 0;
  }

  push(chunk: Buffer): void {
    if (this.broken) return;
    try {
      this.read(chunk);
    } catch {
      // Not HTTP/2 we can follow; the bytes still flow, only the record stops.
      this.broken = true;
      this.buf = Buffer.alloc(0);
    }
  }

  private read(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.skip) {
      const n = Math.min(this.skip, this.buf.length);
      this.buf = this.buf.subarray(n);
      this.skip -= n;
    }
    while (this.buf.length >= 9) {
      const len = this.buf.readUIntBE(0, 3);
      if (this.buf.length < 9 + len) return;
      const type = this.buf[3]!;
      const flags = this.buf[4]!;
      const stream = this.buf.readUInt32BE(5) & 0x7fffffff;
      let payload = this.buf.subarray(9, 9 + len);
      this.buf = this.buf.subarray(9 + len);
      const unpad = () => {
        if (!(flags & 0x8)) return;
        const pad = payload[0]!;
        payload = payload.subarray(1, payload.length - pad);
      };
      if (type === 0) {
        unpad();
        this.on.data(stream, Buffer.from(payload), (flags & 0x1) !== 0);
      } else if (type === 1) {
        unpad();
        if (flags & 0x20) payload = payload.subarray(5);
        this.pending = { stream, endStream: (flags & 0x1) !== 0, parts: [Buffer.from(payload)] };
        if (flags & 0x4) this.flush();
      } else if (type === 5) {
        // PUSH_PROMISE: decoded only to keep the HPACK table in step.
        unpad();
        this.pending = { stream, endStream: false, parts: [Buffer.from(payload.subarray(4))], promise: true };
        if (flags & 0x4) this.flush();
      } else if (type === 9 && this.pending?.stream === stream) {
        this.pending.parts.push(Buffer.from(payload));
        if (flags & 0x4) this.flush();
      } else if (type === 3 && payload.length >= 4) {
        this.on.reset(stream, payload.readUInt32BE(0));
      }
    }
  }

  private flush(): void {
    const p = this.pending!;
    this.pending = undefined;
    const fields = this.hpack.decode(Buffer.concat(p.parts));
    if (!p.promise) this.on.headers(p.stream, fields, p.endStream);
  }
}
