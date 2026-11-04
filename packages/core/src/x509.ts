/**
 * Just enough X.509 to run an intercepting proxy: a self-signed root CA and
 * leaf certificates signed by it, all RSA with SHA-256. Certificates are
 * written as DER by hand and signed with node:crypto, which can parse
 * certificates (X509Certificate) but not create them.
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { createSecureContext, type SecureContext } from 'node:tls';

// --- DER ---------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.of(tag), len(body.length), body]);
};

const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const explicit = (n: number, item: Buffer) => tlv(0xa0 + n, item);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.of(unused), b);
const bool = (v: boolean) => tlv(0x01, Buffer.of(v ? 0xff : 0));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const NULL = Buffer.of(0x05, 0x00);

/** A non-negative INTEGER from big-endian bytes (or a small number). */
function int(b: Buffer | number): Buffer {
  let buf = typeof b === 'number' ? Buffer.of(b) : b;
  while (buf.length > 1 && buf[0] === 0 && !(buf[1]! & 0x80)) buf = buf.subarray(1);
  if (buf[0]! & 0x80) buf = Buffer.concat([Buffer.of(0), buf]);
  return tlv(0x02, buf);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime until 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const SIG_ALG = seq(oid(OID.sha256WithRSA), NULL);

export interface Subject {
  commonName: string;
  organizationName?: string;
}

const name = (s: Subject) =>
  seq(...[s.organizationName !== undefined ? set(seq(oid(OID.organization), utf8(s.organizationName))) : undefined, set(seq(oid(OID.commonName), utf8(s.commonName)))].filter((x): x is Buffer => !!x));

const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/** SHA-1 of the subjectPublicKey bits, the usual key identifier (RFC 5280 4.2.1.2). */
function keyId(spki: Buffer): Buffer {
  // SubjectPublicKeyInfo = SEQUENCE { AlgorithmIdentifier, BIT STRING }. Skip to the BIT STRING contents.
  const outer = readTlv(spki, 0);
  const alg = readTlv(spki, outer.start);
  const key = readTlv(spki, alg.end);
  return createHash('sha1').update(spki.subarray(key.start + 1, key.end)).digest();
}

function readTlv(buf: Buffer, at: number): { start: number; end: number } {
  let pos = at + 1;
  let n = buf[pos++]!;
  if (n & 0x80) {
    const count = n & 0x7f;
    n = 0;
    for (let i = 0; i < count; i++) n = n * 256 + buf[pos++]!;
  }
  return { start: pos, end: pos + n };
}

interface CertSpec {
  subject: Subject;
  /** Issuer as a Subject, or the issuer certificate's subject Name as DER. */
  issuer: Subject | Buffer;
  publicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}

function buildCert(spec: CertSpec): string {
  const spki = spec.publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  serial[0]! &= 0x7f; // positive
  const tbs = seq(
    explicit(0, int(2)), // v3
    int(serial),
    SIG_ALG,
    Buffer.isBuffer(spec.issuer) ? spec.issuer : name(spec.issuer),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spki,
    explicit(3, seq(...spec.extensions)),
  );
  const der = seq(tbs, SIG_ALG, bits(sign('sha256', tbs, spec.signingKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
}

const DAY = 86_400_000;

/** A new self-signed root CA. */
export function generateCA(subject: Subject, opts: { bits?: number; validDays?: number } = {}): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: opts.bits ?? 2048 });
  const now = Date.now();
  const ski = keyId(publicKey.export({ type: 'spki', format: 'der' }));
  const cert = buildCert({
    subject,
    issuer: subject,
    publicKey,
    signingKey: privateKey,
    // Backdate a little for devices whose clocks run slow.
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + (opts.validDays ?? 3650) * DAY),
    extensions: [
      ext(OID.basicConstraints, true, seq(bool(true))),
      ext(OID.keyUsage, true, bits(Buffer.of(0x06), 1)), // keyCertSign, cRLSign
      ext(OID.subjectKeyId, false, octets(ski)),
    ],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** The subject Name of a certificate as raw DER, to use as the issuer of certificates it signs. */
function subjectDer(certPem: string): { der: Buffer; organizationName?: string } {
  const der = new X509Certificate(certPem).raw;
  const tbs = readTlv(der, readTlv(der, 0).start);
  // TBSCertificate: [0] version, serial, signature alg, issuer, validity, subject.
  let at = tbs.start;
  const skip = () => {
    const t = readTlv(der, at);
    const from = at;
    at = t.end;
    return der.subarray(from, t.end);
  };
  if (der[at] === 0xa0) skip();
  skip(); // serial
  skip(); // signature algorithm
  skip(); // issuer
  skip(); // validity
  const subject = skip();
  const org = /(?:^|\n)O=([^\n]*)/.exec(new X509Certificate(certPem).subject)?.[1];
  return { der: subject, organizationName: org };
}

/**
 * Issues leaf certificates for intercepted hosts. One RSA key is shared by
 * every leaf (generating a key per host would add a noticeable pause to the
 * first request), and certificates and TLS contexts are cached per host.
 */
export class LeafIssuer {
  private readonly caKey: KeyObject;
  private readonly caSubject: { der: Buffer; organizationName?: string };
  private readonly caKeyId: Buffer;
  private leafKey?: { privateKey: KeyObject; pem: string };
  private cache = new Map<string, { cert: string; key: string; context: SecureContext; expires: number }>();

  constructor(private readonly ca: { cert: string; key: string }) {
    this.caKey = createPrivateKey(ca.key);
    this.caSubject = subjectDer(ca.cert);
    this.caKeyId = keyId(createPublicKey(this.caKey).export({ type: 'spki', format: 'der' }));
  }

  private key() {
    if (!this.leafKey) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.leafKey = { privateKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
    }
    return this.leafKey;
  }

  /** PEM cert and key for a hostname or IP address. */
  issue(host: string): { cert: string; key: string; context: SecureContext } {
    const hit = this.cache.get(host);
    if (hit && hit.expires > Date.now()) return hit;
    const leaf = this.key();
    const now = Date.now();
    const ip = isIP(host);
    const san = ip
      ? tlv(0x87, ip === 4 ? Buffer.from(host.split('.').map(Number)) : ipv6Bytes(host))
      : tlv(0x82, Buffer.from(host, 'ascii'));
    const cert = buildCert({
      subject: { commonName: host.slice(0, 64), organizationName: this.caSubject.organizationName },
      issuer: this.caSubject.der,
      publicKey: createPublicKey(leaf.privateKey),
      signingKey: this.caKey,
      notBefore: new Date(now - DAY),
      // Under the 398-day limit some clients enforce even for private roots.
      notAfter: new Date(now + 365 * DAY),
      extensions: [
        ext(OID.basicConstraints, true, seq()),
        ext(OID.keyUsage, true, bits(Buffer.of(0xa0), 5)), // digitalSignature, keyEncipherment
        ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        ext(OID.subjectAltName, false, seq(san)),
        ext(OID.authorityKeyId, false, seq(tlv(0x80, this.caKeyId))),
      ],
    });
    const out = { cert, key: leaf.pem, context: createSecureContext({ key: leaf.pem, cert: cert + this.ca.cert }), expires: now + 300 * DAY };
    this.cache.set(host, out);
    return out;
  }
}

function ipv6Bytes(addr: string): Buffer {
  const [head = '', tail = ''] = addr.split('::');
  const parse = (s: string) => (s ? s.split(':') : []);
  let h = parse(head);
  let t = parse(tail);
  const last = (t.length ? t : h).at(-1);
  const v4 = last?.includes('.') ? last.split('.').map(Number) : undefined;
  if (v4) {
    const words = [((v4[0]! << 8) | v4[1]!).toString(16), ((v4[2]! << 8) | v4[3]!).toString(16)];
    if (t.length) t = [...t.slice(0, -1), ...words];
    else h = [...h.slice(0, -1), ...words];
  }
  const fill = addr.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return Buffer.concat([...h, ...fill, ...t].map((w) => Buffer.from(w.padStart(4, '0'), 'hex')));
}
