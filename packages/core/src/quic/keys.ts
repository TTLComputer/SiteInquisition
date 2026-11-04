/**
 * TLS 1.3 key schedule helpers and QUIC packet protection (RFC 8446 section 7,
 * RFC 9001 section 5), all on node:crypto.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

export type HashName = 'sha256' | 'sha384';

export interface CipherSuite {
  id: number;
  name: string;
  hash: HashName;
  hashLen: number;
  keyLen: number;
  aead: 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305';
  hp: 'aes-128-ecb' | 'aes-256-ecb' | 'chacha20';
}

export const SUITES: Record<number, CipherSuite> = {
  0x1301: { id: 0x1301, name: 'TLS_AES_128_GCM_SHA256', hash: 'sha256', hashLen: 32, keyLen: 16, aead: 'aes-128-gcm', hp: 'aes-128-ecb' },
  0x1302: { id: 0x1302, name: 'TLS_AES_256_GCM_SHA384', hash: 'sha384', hashLen: 48, keyLen: 32, aead: 'aes-256-gcm', hp: 'aes-256-ecb' },
  0x1303: { id: 0x1303, name: 'TLS_CHACHA20_POLY1305_SHA256', hash: 'sha256', hashLen: 32, keyLen: 32, aead: 'chacha20-poly1305', hp: 'chacha20' },
};

export const hash = (h: HashName, ...data: Uint8Array[]): Buffer => {
  const x = createHash(h);
  for (const d of data) x.update(d);
  return x.digest();
};

export const hmac = (h: HashName, key: Uint8Array, ...data: Uint8Array[]): Buffer => {
  const x = createHmac(h, key);
  for (const d of data) x.update(d);
  return x.digest();
};

export const hkdfExtract = (h: HashName, salt: Uint8Array, ikm: Uint8Array): Buffer => hmac(h, salt.length ? salt : Buffer.alloc(h === 'sha256' ? 32 : 48), ikm);

export function hkdfExpand(h: HashName, prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const out: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  let n = 0;
  for (let i = 1; n < length; i++) {
    t = hmac(h, prk, t, info, Buffer.of(i));
    out.push(t);
    n += t.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

export function hkdfExpandLabel(h: HashName, secret: Uint8Array, label: string, context: Uint8Array, length: number): Buffer {
  const full = Buffer.from(`tls13 ${label}`, 'ascii');
  const info = Buffer.concat([Buffer.of(length >> 8, length & 0xff, full.length), full, Buffer.of(context.length), context]);
  return hkdfExpand(h, secret, info, length);
}

export const deriveSecret = (h: HashName, secret: Uint8Array, label: string, transcriptHash: Uint8Array): Buffer =>
  hkdfExpandLabel(h, secret, label, transcriptHash, h === 'sha256' ? 32 : 48);

// --- QUIC packet protection --------------------------------------------

export const QUIC_V1 = 0x00000001;
export const INITIAL_SALT_V1 = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');

export class PacketKeys {
  readonly key: Buffer;
  readonly iv: Buffer;
  readonly hp: Buffer;
  /** Packets sealed or opened with this key, for AEAD limits and the UI. */
  uses = 0;
  constructor(
    readonly suite: CipherSuite,
    readonly secret: Buffer,
    hpKey?: Buffer,
  ) {
    this.key = hkdfExpandLabel(suite.hash, secret, 'quic key', Buffer.alloc(0), suite.keyLen);
    this.iv = hkdfExpandLabel(suite.hash, secret, 'quic iv', Buffer.alloc(0), 12);
    // Header protection keys do not change on key update (RFC 9001 section 6).
    this.hp = hpKey ?? hkdfExpandLabel(suite.hash, secret, 'quic hp', Buffer.alloc(0), suite.keyLen);
  }

  /** Keys for the next key phase. */
  next(): PacketKeys {
    return new PacketKeys(this.suite, hkdfExpandLabel(this.suite.hash, this.secret, 'quic ku', Buffer.alloc(0), this.suite.hashLen), this.hp);
  }

  private nonce(pn: number): Buffer {
    const n = Buffer.from(this.iv);
    let x = pn;
    for (let i = 11; i >= 4 && x > 0; i--) {
      n[i]! ^= x % 256;
      x = Math.floor(x / 256);
    }
    return n;
  }

  seal(pn: number, header: Uint8Array, payload: Uint8Array): Buffer {
    this.uses++;
    const c = createCipheriv(this.suite.aead as 'aes-128-gcm', this.key, this.nonce(pn), { authTagLength: 16 } as never);
    c.setAAD(header);
    return Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
  }

  /** Returns null when authentication fails. */
  open(pn: number, header: Uint8Array, sealed: Uint8Array): Buffer | null {
    if (sealed.length < 16) return null;
    try {
      const d = createDecipheriv(this.suite.aead as 'aes-128-gcm', this.key, this.nonce(pn), { authTagLength: 16 } as never);
      d.setAAD(header);
      d.setAuthTag(sealed.subarray(sealed.length - 16));
      const out = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
      this.uses++;
      return out;
    } catch {
      return null;
    }
  }

  /** The 5-byte header protection mask for a 16-byte ciphertext sample. */
  mask(sample: Uint8Array): Buffer {
    if (this.suite.hp === 'chacha20') {
      // The sample's first 4 bytes are the block counter (little endian), the rest the nonce.
      const c = createCipheriv('chacha20', this.hp, sample);
      return c.update(Buffer.alloc(5));
    }
    const c = createCipheriv(this.suite.hp, this.hp, null);
    c.setAutoPadding(false);
    return c.update(sample).subarray(0, 5);
  }
}

export function initialKeys(dcid: Uint8Array): { client: PacketKeys; server: PacketKeys } {
  const suite = SUITES[0x1301]!;
  const initial = hkdfExtract('sha256', INITIAL_SALT_V1, dcid);
  return {
    client: new PacketKeys(suite, hkdfExpandLabel('sha256', initial, 'client in', Buffer.alloc(0), 32)),
    server: new PacketKeys(suite, hkdfExpandLabel('sha256', initial, 'server in', Buffer.alloc(0), 32)),
  };
}

/** Retry integrity tag key and nonce for QUIC v1 (RFC 9001 section 5.8). */
export const RETRY_KEY = Buffer.from('be0c690b9f66575a1d766b54e368c84e', 'hex');
export const RETRY_NONCE = Buffer.from('461599d35d632bf2239825bb', 'hex');

export function retryTag(odcid: Uint8Array, retryPacketWithoutTag: Uint8Array): Buffer {
  const pseudo = Buffer.concat([Buffer.of(odcid.length), odcid, retryPacketWithoutTag]);
  const c = createCipheriv('aes-128-gcm', RETRY_KEY, RETRY_NONCE);
  c.setAAD(pseudo);
  c.final();
  return c.getAuthTag();
}
