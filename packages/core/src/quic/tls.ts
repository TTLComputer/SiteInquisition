/**
 * TLS 1.3 handshake for QUIC (RFC 8446 + RFC 9001), client and server, on
 * node:crypto. QUIC carries handshake messages in CRYPTO frames, so there is
 * no record layer: this module turns handshake bytes at each encryption level
 * into replies and traffic secrets.
 *
 * Supported: X25519 and P-256 key shares (HelloRetryRequest both ways), the
 * three TLS 1.3 AEAD suites, RSA-PSS, ECDSA and Ed25519 certificates, ALPN,
 * session tickets, PSK resumption and 0-RTT early data. Not supported: client
 * certificates (an empty Certificate is sent when asked), post-handshake auth.
 */
import {
  X509Certificate,
  constants,
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { rootCertificates } from 'node:tls';
import { QuicError, Reader, TransportError, Writer } from './bytes.js';
import { SUITES, deriveSecret, hash, hkdfExpandLabel, hkdfExtract, hmac, type CipherSuite, type HashName } from './keys.js';

export type Level = 'initial' | '0rtt' | 'handshake' | '1rtt';

export const Alert = {
  unexpected_message: 10,
  bad_record_mac: 20,
  handshake_failure: 40,
  bad_certificate: 42,
  unsupported_certificate: 43,
  certificate_expired: 45,
  certificate_unknown: 46,
  illegal_parameter: 47,
  unknown_ca: 48,
  decode_error: 50,
  decrypt_error: 51,
  protocol_version: 70,
  internal_error: 80,
  missing_extension: 109,
  unsupported_extension: 110,
  no_application_protocol: 120,
} as const;

const alert = (a: number, msg: string) => new QuicError(TransportError.CRYPTO_ERROR + a, msg);

const HS = { client_hello: 1, server_hello: 2, new_session_ticket: 4, encrypted_extensions: 8, certificate: 11, certificate_request: 13, certificate_verify: 15, finished: 20 } as const;
const EXT = { server_name: 0, supported_groups: 10, signature_algorithms: 13, alpn: 16, pre_shared_key: 41, early_data: 42, supported_versions: 43, cookie: 44, psk_key_exchange_modes: 45, key_share: 51, quic_transport_parameters: 57 } as const;

export const GROUPS = { x25519: 0x001d, secp256r1: 0x0017 } as const;
export type GroupName = keyof typeof GROUPS;

const SIG = {
  ecdsa_secp256r1_sha256: 0x0403,
  ecdsa_secp384r1_sha384: 0x0503,
  rsa_pss_rsae_sha256: 0x0804,
  rsa_pss_rsae_sha384: 0x0805,
  rsa_pss_rsae_sha512: 0x0806,
  ed25519: 0x0807,
} as const;
const SIG_LIST = Object.values(SIG);

const HRR_RANDOM = hash('sha256', Buffer.from('HelloRetryRequest'));

// --- key exchange ---------------------------------------------------------

interface KeyShare {
  group: number;
  pub: Buffer;
  secret(peer: Buffer): Buffer;
}

function makeKeyShare(group: number): KeyShare {
  if (group === GROUPS.x25519) {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
    return {
      group,
      pub,
      secret(peer) {
        if (peer.length !== 32) throw alert(Alert.illegal_parameter, 'bad X25519 key share');
        const peerKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peer.toString('base64url') }, format: 'jwk' });
        return diffieHellman({ privateKey, publicKey: peerKey });
      },
    };
  }
  if (group === GROUPS.secp256r1) {
    const ecdh = createECDH('prime256v1');
    const pub = ecdh.generateKeys();
    return {
      group,
      pub,
      secret(peer) {
        if (peer.length !== 65 || peer[0] !== 4) throw alert(Alert.illegal_parameter, 'bad P-256 key share');
        try {
          return ecdh.computeSecret(peer);
        } catch {
          throw alert(Alert.illegal_parameter, 'bad P-256 key share');
        }
      },
    };
  }
  throw alert(Alert.internal_error, `unsupported group ${group}`);
}

// --- certificates ---------------------------------------------------------

function schemeFor(key: KeyObject): number[] {
  const t = key.asymmetricKeyType;
  if (t === 'rsa' || t === 'rsa-pss') return [SIG.rsa_pss_rsae_sha256, SIG.rsa_pss_rsae_sha384, SIG.rsa_pss_rsae_sha512];
  if (t === 'ed25519') return [SIG.ed25519];
  if (t === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    return curve === 'secp384r1' ? [SIG.ecdsa_secp384r1_sha384] : [SIG.ecdsa_secp256r1_sha256];
  }
  return [];
}

function sigParams(scheme: number): { alg: string | null; pss: boolean } {
  switch (scheme) {
    case SIG.rsa_pss_rsae_sha256:
      return { alg: 'sha256', pss: true };
    case SIG.rsa_pss_rsae_sha384:
      return { alg: 'sha384', pss: true };
    case SIG.rsa_pss_rsae_sha512:
      return { alg: 'sha512', pss: true };
    case SIG.ecdsa_secp256r1_sha256:
      return { alg: 'sha256', pss: false };
    case SIG.ecdsa_secp384r1_sha384:
      return { alg: 'sha384', pss: false };
    case SIG.ed25519:
      return { alg: null, pss: false };
  }
  throw alert(Alert.illegal_parameter, `unsupported signature scheme 0x${scheme.toString(16)}`);
}

const verifyContent = (server: boolean, th: Buffer) =>
  Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from(server ? 'TLS 1.3, server CertificateVerify' : 'TLS 1.3, client CertificateVerify'), Buffer.of(0), th]);

function signWith(key: KeyObject, scheme: number, data: Buffer): Buffer {
  const p = sigParams(scheme);
  return cryptoSign(p.alg, data, p.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key);
}

function verifyWith(key: KeyObject, scheme: number, data: Buffer, sig: Buffer): boolean {
  const p = sigParams(scheme);
  try {
    return cryptoVerify(p.alg, data, p.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key, sig);
  } catch {
    return false;
  }
}

let systemRoots: X509Certificate[] | undefined;
const roots = () => (systemRoots ??= rootCertificates.map((p) => new X509Certificate(p)));

/** Check a server chain the way a browser would, minus revocation. Returns an error message or null. */
export function checkChain(chain: X509Certificate[], host: string, extraCa: X509Certificate[] = [], now = new Date()): string | null {
  if (!chain.length) return 'the server sent no certificate';
  const leaf = chain[0]!;
  if (isIP(host) ? !leaf.checkIP(host) : !leaf.checkHost(host)) return `certificate is not valid for ${host}`;
  for (const c of chain) {
    if (new Date(c.validFrom) > now || new Date(c.validTo) < now) return `certificate "${c.subject.replace(/\n/g, ', ')}" is expired or not yet valid`;
  }
  const anchors = [...extraCa, ...roots()];
  let cur = leaf;
  const pool = chain.slice(1);
  for (let depth = 0; depth < 10; depth++) {
    const anchor = anchors.find((a) => cur.checkIssued(a) && cur.verify(a.publicKey));
    if (anchor) return null;
    if (anchors.some((a) => a.fingerprint256 === cur.fingerprint256)) return null;
    const next = pool.find((c) => cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!next) return 'certificate chain does not lead to a trusted root';
    cur = next;
  }
  return 'certificate chain is too long';
}

// --- session tickets ------------------------------------------------------

export interface SessionTicket {
  serverName: string;
  alpn: string;
  ticket: Buffer;
  psk: Buffer;
  suite: number;
  ageAdd: number;
  receivedAt: number;
  lifetimeSec: number;
  maxEarlyData: number;
  /** Server transport parameters remembered for 0-RTT (RFC 9000 section 7.4.1). */
  transportParams?: Buffer;
}

// --- options --------------------------------------------------------------

export interface TlsCallbacks {
  send(level: Level, data: Buffer): void;
  keys(level: Level, dir: 'read' | 'write', suite: CipherSuite, secret: Buffer): void;
  /** Called once the handshake is confirmed from this side's point of view. */
  done(): void;
  ticket?(t: SessionTicket): void;
}

export interface TlsClientOptions {
  serverName: string;
  alpn: string[];
  transportParams: Buffer;
  /** Groups to offer key shares for, in order (default x25519). Others are listed as supported only. */
  keyShares?: GroupName[];
  suites?: number[];
  rejectUnauthorized?: boolean;
  ca?: string[];
  /** Resume with this ticket; with earlyData true, 0-RTT keys are installed. */
  session?: SessionTicket;
  earlyData?: boolean;
}

export interface TlsServerOptions {
  /** PEM, chain allowed; or a function choosing by SNI. */
  cert: string | ((sni: string) => { cert: string; key: string });
  key?: string;
  alpn: string[];
  transportParams: Buffer | (() => Buffer);
  suites?: number[];
  /** Encrypts session tickets; tickets are only issued when set. */
  ticketKey?: Buffer;
  /** Accept 0-RTT from resumed clients (default false). */
  acceptEarlyData?: boolean;
  /** Force a HelloRetryRequest for this group even if the client sent a usable share (for tests). */
  forceHrr?: GroupName;
}

interface Pending {
  level: Level;
  buf: Buffer;
}

export class TlsSession {
  readonly isClient: boolean;
  alpn: string | null = null;
  serverName = '';
  peerTransportParams: Buffer | null = null;
  resumed = false;
  earlyDataOffered = false;
  earlyDataAccepted: boolean | null = null;
  helloRetry = false;
  suite: CipherSuite | null = null;
  group: number | null = null;
  peerCertificates: X509Certificate[] = [];
  certificateError: string | null = null;
  complete = false;

  private transcript: Buffer[] = [];
  private inbound: Record<Level, Buffer> = { initial: Buffer.alloc(0), '0rtt': Buffer.alloc(0), handshake: Buffer.alloc(0), '1rtt': Buffer.alloc(0) };
  private state = 'start';
  private shares: KeyShare[] = [];
  private hsSecret?: Buffer;
  private clientHsSecret?: Buffer;
  private serverHsSecret?: Buffer;
  private masterSecret?: Buffer;
  private psk?: Buffer;
  private certRequestContext?: Buffer;
  private serverKey?: KeyObject;
  private serverChain: Buffer[] = [];
  private earlySecret?: Buffer;
  private chosenTicket?: SessionTicket;

  constructor(
    private readonly opts: (TlsClientOptions & { server?: false }) | (TlsServerOptions & { server: true }),
    private readonly cb: TlsCallbacks,
  ) {
    this.isClient = !opts.server;
  }

  private get copts() {
    return this.opts as TlsClientOptions;
  }
  private get sopts() {
    return this.opts as TlsServerOptions;
  }

  private th(): Buffer {
    return hash(this.suite?.hash ?? 'sha256', ...this.transcript);
  }

  private emit(level: Level, type: number, body: Buffer): Buffer {
    const msg = Buffer.concat([Buffer.of(type, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff), body]);
    this.transcript.push(msg);
    this.cb.send(level, msg);
    return msg;
  }

  // --- client -------------------------------------------------------------

  start(): void {
    if (!this.isClient) return;
    const groups = this.copts.keyShares?.length ? this.copts.keyShares : (['x25519'] as GroupName[]);
    this.shares = groups.map((g) => makeKeyShare(GROUPS[g]));
    this.sendClientHello();
  }

  private clientHelloBody(cookie?: Buffer): Buffer {
    const o = this.copts;
    const suites = o.suites ?? [0x1301, 0x1302, 0x1303];
    const w = new Writer(512);
    w.u16(0x0303).bytes(randomBytes(32)).vec(1, Buffer.alloc(0));
    w.nested(2, (s) => suites.forEach((x) => s.u16(x)));
    w.vec(1, Buffer.of(0));
    const exts = new Writer(512);
    const ext = (type: number, fn: (x: Writer) => void) => exts.u16(type).nested(2, fn);
    if (o.serverName && !isIP(o.serverName)) ext(EXT.server_name, (x) => x.nested(2, (l) => l.u8(0).vec(2, Buffer.from(o.serverName, 'ascii'))));
    ext(EXT.supported_groups, (x) => x.nested(2, (l) => [GROUPS.x25519, GROUPS.secp256r1].forEach((g) => l.u16(g))));
    ext(EXT.signature_algorithms, (x) => x.nested(2, (l) => SIG_LIST.forEach((g) => l.u16(g))));
    ext(EXT.alpn, (x) => x.nested(2, (l) => o.alpn.forEach((p) => l.vec(1, Buffer.from(p)))));
    ext(EXT.supported_versions, (x) => x.nested(1, (l) => l.u16(0x0304)));
    ext(EXT.key_share, (x) => x.nested(2, (l) => this.shares.forEach((k) => l.u16(k.group).vec(2, k.pub))));
    ext(EXT.quic_transport_parameters, (x) => x.bytes(o.transportParams));
    if (cookie) ext(EXT.cookie, (x) => x.vec(2, cookie));
    const t = o.session;
    const useTicket = t && t.serverName === o.serverName && SUITES[t.suite] && (this.opts.suites ?? [0x1301, 0x1302, 0x1303]).includes(t.suite) && Date.now() - t.receivedAt < t.lifetimeSec * 1000;
    if (useTicket) {
      ext(EXT.psk_key_exchange_modes, (x) => x.nested(1, (l) => l.u8(1)));
      if (o.earlyData && t.maxEarlyData > 0 && !this.helloRetry) {
        ext(EXT.early_data, () => undefined);
        this.earlyDataOffered = true;
      }
    }
    if (!useTicket) {
      w.nested(2, (x) => x.bytes(exts.finish()));
      return w.finish();
    }
    // pre_shared_key goes last; its binder covers everything before the binders list.
    const suite = SUITES[t.suite]!;
    const age = (Date.now() - t.receivedAt + t.ageAdd) >>> 0;
    const identities = new Writer().nested(2, (l) => l.vec(2, t.ticket).u32(age)).finish();
    const binderLen = suite.hashLen;
    const bindersLen = 2 + 1 + binderLen;
    exts.u16(EXT.pre_shared_key).u16(identities.length + bindersLen).bytes(identities);
    const extBytes = exts.finish();
    w.u16(extBytes.length + bindersLen).bytes(extBytes);
    const partialBody = w.finish();
    const partial = Buffer.concat([Buffer.of(HS.client_hello, 0, 0, 0), partialBody]);
    const total = partialBody.length + bindersLen;
    partial.writeUIntBE(total, 1, 3);
    this.chosenTicket = t;
    this.psk = t.psk;
    this.suite = suite;
    const early = hkdfExtract(suite.hash, Buffer.alloc(0), t.psk);
    this.earlySecret = early;
    const binderKey = deriveSecret(suite.hash, early, 'res binder', hash(suite.hash));
    const finishedKey = hkdfExpandLabel(suite.hash, binderKey, 'finished', Buffer.alloc(0), suite.hashLen);
    const binder = hmac(suite.hash, finishedKey, hash(suite.hash, ...this.transcript, partial));
    return Buffer.concat([partialBody, new Writer().nested(2, (l) => l.vec(1, binder)).finish()]);
  }

  private sendClientHello(cookie?: Buffer) {
    const body = this.clientHelloBody(cookie);
    this.emit('initial', HS.client_hello, body);
    if (this.earlyDataOffered && this.earlySecret && this.suite) {
      const secret = deriveSecret(this.suite.hash, this.earlySecret, 'c e traffic', this.th());
      this.cb.keys('0rtt', 'write', this.suite, secret);
    }
    this.state = 'wait_sh';
  }

  // --- input --------------------------------------------------------------

  /** Feed in-order CRYPTO bytes received at a level. */
  receive(level: Level, data: Buffer): void {
    this.inbound[level] = Buffer.concat([this.inbound[level], data]);
    for (;;) {
      const buf = this.inbound[level];
      if (buf.length < 4) return;
      const len = buf.readUIntBE(1, 3);
      if (buf.length < 4 + len) {
        if (len > 1 << 16) throw new QuicError(TransportError.CRYPTO_BUFFER_EXCEEDED, 'handshake message too large');
        return;
      }
      const msg = Buffer.from(buf.subarray(0, 4 + len));
      this.inbound[level] = buf.subarray(4 + len);
      this.handle(level, msg[0]!, msg, new Reader(msg, 4));
    }
  }

  private expectLevel(level: Level, want: Level) {
    if (level !== want) throw alert(Alert.unexpected_message, `handshake message at the wrong encryption level (${level}, wanted ${want})`);
  }

  private handle(level: Level, type: number, msg: Buffer, r: Reader) {
    try {
      if (this.isClient) this.clientHandle(level, type, msg, r);
      else this.serverHandle(level, type, msg, r);
    } catch (e) {
      if (e instanceof QuicError && e.code >= TransportError.CRYPTO_ERROR) throw e;
      if (e instanceof QuicError) throw alert(Alert.decode_error, e.message);
      throw e;
    }
  }

  private parseExtensions(r: Reader): Map<number, Buffer> {
    const out = new Map<number, Buffer>();
    const er = new Reader(r.vec(2));
    while (er.left) {
      const t = er.u16();
      if (out.has(t)) throw alert(Alert.illegal_parameter, 'duplicate extension');
      out.set(t, Buffer.from(er.vec(2)));
    }
    return out;
  }

  private clientHandle(level: Level, type: number, msg: Buffer, r: Reader) {
    switch (this.state) {
      case 'wait_sh': {
        if (type !== HS.server_hello) throw alert(Alert.unexpected_message, 'expected ServerHello');
        this.expectLevel(level, 'initial');
        r.u16();
        const random = r.bytes(32);
        r.vec(1);
        const suiteId = r.u16();
        r.u8();
        const ext = this.parseExtensions(r);
        const sv = ext.get(EXT.supported_versions);
        if (!sv || sv.readUInt16BE(0) !== 0x0304) throw alert(Alert.protocol_version, 'server did not negotiate TLS 1.3');
        const suite = SUITES[suiteId];
        if (!suite || !(this.copts.suites ?? [0x1301, 0x1302, 0x1303]).includes(suiteId)) throw alert(Alert.illegal_parameter, 'server chose a cipher suite we did not offer');
        if (random.equals(HRR_RANDOM)) {
          if (this.helloRetry) throw alert(Alert.unexpected_message, 'second HelloRetryRequest');
          this.helloRetry = true;
          const ks = ext.get(EXT.key_share);
          if (!ks) throw alert(Alert.illegal_parameter, 'HelloRetryRequest without a key share group');
          const group = ks.readUInt16BE(0);
          if (group !== GROUPS.x25519 && group !== GROUPS.secp256r1) throw alert(Alert.illegal_parameter, 'HelloRetryRequest for a group we do not support');
          if (this.shares.some((s) => s.group === group)) throw alert(Alert.illegal_parameter, 'HelloRetryRequest for a group we already sent');
          // Transcript restarts with a synthetic message_hash of ClientHello1.
          this.suite = suite;
          const ch1 = hash(suite.hash, this.transcript[0]!);
          this.transcript = [Buffer.concat([Buffer.of(254, 0, 0, ch1.length), ch1]), msg];
          this.shares = [makeKeyShare(group)];
          this.earlyDataOffered = false;
          // sendClientHello pushes ClientHello2 onto the restarted transcript.
          this.sendClientHello(ext.get(EXT.cookie)?.subarray(2));
          return;
        }
        if (this.suite && this.psk && this.suite.id !== suiteId && !this.helloRetry) this.psk = undefined;
        this.suite = suite;
        this.transcript.push(msg);
        const ks = ext.get(EXT.key_share);
        if (!ks) throw alert(Alert.missing_extension, 'ServerHello without a key share');
        const kr = new Reader(ks);
        const group = kr.u16();
        const share = this.shares.find((s) => s.group === group);
        if (!share) throw alert(Alert.illegal_parameter, 'server key share for a group we did not offer');
        this.group = group;
        const dhe = share.secret(Buffer.from(kr.vec(2)));
        const psk = ext.get(EXT.pre_shared_key);
        if (psk) {
          if (!this.psk || psk.readUInt16BE(0) !== 0) throw alert(Alert.illegal_parameter, 'server selected a PSK we did not offer');
          this.resumed = true;
        } else this.psk = undefined;
        this.handshakeKeys(dhe);
        this.state = 'wait_ee';
        return;
      }
      case 'wait_ee': {
        if (type !== HS.encrypted_extensions) throw alert(Alert.unexpected_message, 'expected EncryptedExtensions');
        this.expectLevel(level, 'handshake');
        this.transcript.push(msg);
        const ext = this.parseExtensions(r);
        const alpn = ext.get(EXT.alpn);
        if (alpn) {
          const ar = new Reader(alpn);
          const list = new Reader(ar.vec(2));
          const p = list.vec(1).toString();
          if (!this.copts.alpn.includes(p)) throw alert(Alert.illegal_parameter, 'server chose an ALPN we did not offer');
          this.alpn = p;
        } else throw alert(Alert.no_application_protocol, 'server did not negotiate ALPN');
        const tp = ext.get(EXT.quic_transport_parameters);
        if (!tp) throw alert(Alert.missing_extension, 'server sent no QUIC transport parameters');
        this.peerTransportParams = tp;
        if (this.earlyDataOffered) this.earlyDataAccepted = ext.has(EXT.early_data) && this.resumed;
        this.state = this.resumed ? 'wait_fin' : 'wait_cert';
        return;
      }
      case 'wait_cert': {
        this.expectLevel(level, 'handshake');
        if (type === HS.certificate_request) {
          this.transcript.push(msg);
          this.certRequestContext = Buffer.from(r.vec(1));
          return;
        }
        if (type !== HS.certificate) throw alert(Alert.unexpected_message, 'expected Certificate');
        this.transcript.push(msg);
        r.vec(1);
        const list = new Reader(r.vec(3));
        const chain: X509Certificate[] = [];
        while (list.left) {
          const der = Buffer.from(list.vec(3));
          list.vec(2);
          try {
            chain.push(new X509Certificate(der));
          } catch {
            throw alert(Alert.bad_certificate, 'unparseable certificate');
          }
        }
        if (!chain.length) throw alert(Alert.decode_error, 'empty server certificate');
        this.peerCertificates = chain;
        const ca = (this.copts.ca ?? []).map((p) => new X509Certificate(p));
        this.certificateError = checkChain(chain, this.copts.serverName, ca);
        if (this.certificateError && this.copts.rejectUnauthorized !== false) throw alert(Alert.bad_certificate, this.certificateError);
        this.state = 'wait_cv';
        return;
      }
      case 'wait_cv': {
        if (type !== HS.certificate_verify) throw alert(Alert.unexpected_message, 'expected CertificateVerify');
        this.expectLevel(level, 'handshake');
        const scheme = r.u16();
        const sig = Buffer.from(r.vec(2));
        if (!SIG_LIST.includes(scheme as never)) throw alert(Alert.illegal_parameter, 'server used a signature scheme we did not offer');
        const ok = verifyWith(this.peerCertificates[0]!.publicKey, scheme, verifyContent(true, this.th()), sig);
        if (!ok) throw alert(Alert.decrypt_error, 'server CertificateVerify signature is invalid');
        this.transcript.push(msg);
        this.state = 'wait_fin';
        return;
      }
      case 'wait_fin': {
        if (type !== HS.finished) throw alert(Alert.unexpected_message, 'expected Finished');
        this.expectLevel(level, 'handshake');
        const s = this.suite!;
        const expected = hmac(s.hash, hkdfExpandLabel(s.hash, this.serverHsSecret!, 'finished', Buffer.alloc(0), s.hashLen), this.th());
        if (!expected.equals(r.rest())) throw alert(Alert.decrypt_error, 'server Finished does not verify');
        this.transcript.push(msg);
        this.appKeys();
        if (this.certRequestContext) this.emit('handshake', HS.certificate, new Writer().vec(1, this.certRequestContext).vec(3, Buffer.alloc(0)).finish());
        const fin = hmac(s.hash, hkdfExpandLabel(s.hash, this.clientHsSecret!, 'finished', Buffer.alloc(0), s.hashLen), this.th());
        this.emit('handshake', HS.finished, fin);
        this.resumptionMaster = deriveSecret(s.hash, this.masterSecret!, 'res master', this.th());
        this.complete = true;
        this.state = 'connected';
        this.cb.done();
        return;
      }
      case 'connected': {
        if (type !== HS.new_session_ticket) throw alert(Alert.unexpected_message, 'unexpected post-handshake message');
        this.expectLevel(level, '1rtt');
        const lifetimeSec = r.u32();
        const ageAdd = r.u32();
        const nonce = r.vec(1);
        const ticket = Buffer.from(r.vec(2));
        const ext = this.parseExtensions(r);
        const ed = ext.get(EXT.early_data);
        const s = this.suite!;
        this.cb.ticket?.({
          serverName: this.copts.serverName,
          alpn: this.alpn ?? '',
          ticket,
          psk: hkdfExpandLabel(s.hash, this.resumptionMaster!, 'resumption', nonce, s.hashLen),
          suite: s.id,
          ageAdd,
          receivedAt: Date.now(),
          lifetimeSec: Math.min(lifetimeSec, 7 * 86400),
          maxEarlyData: ed ? ed.readUInt32BE(0) : 0,
          transportParams: this.peerTransportParams ?? undefined,
        });
        return;
      }
      default:
        throw alert(Alert.unexpected_message, `unexpected handshake message ${type}`);
    }
  }

  private resumptionMaster?: Buffer;

  private handshakeKeys(dhe: Buffer) {
    const s = this.suite!;
    const early = this.psk ? hkdfExtract(s.hash, Buffer.alloc(0), this.psk) : hkdfExtract(s.hash, Buffer.alloc(0), Buffer.alloc(s.hashLen));
    this.hsSecret = hkdfExtract(s.hash, deriveSecret(s.hash, early, 'derived', hash(s.hash)), dhe);
    const th = this.th();
    this.clientHsSecret = deriveSecret(s.hash, this.hsSecret, 'c hs traffic', th);
    this.serverHsSecret = deriveSecret(s.hash, this.hsSecret, 's hs traffic', th);
    this.masterSecret = hkdfExtract(s.hash, deriveSecret(s.hash, this.hsSecret, 'derived', hash(s.hash)), Buffer.alloc(s.hashLen));
    this.cb.keys('handshake', this.isClient ? 'write' : 'read', s, this.clientHsSecret);
    this.cb.keys('handshake', this.isClient ? 'read' : 'write', s, this.serverHsSecret);
  }

  /** 1-RTT secrets after the server Finished is in the transcript. */
  private appKeys() {
    const s = this.suite!;
    const th = this.th();
    const c = deriveSecret(s.hash, this.masterSecret!, 'c ap traffic', th);
    const sv = deriveSecret(s.hash, this.masterSecret!, 's ap traffic', th);
    this.appSecrets = { client: c, server: sv };
    if (this.isClient) {
      this.cb.keys('1rtt', 'read', s, sv);
      this.cb.keys('1rtt', 'write', s, c);
    } else {
      this.cb.keys('1rtt', 'write', s, sv);
    }
  }

  appSecrets?: { client: Buffer; server: Buffer };

  // --- server -------------------------------------------------------------

  private serverHandle(level: Level, type: number, msg: Buffer, r: Reader) {
    switch (this.state) {
      case 'start':
      case 'wait_ch2': {
        if (type !== HS.client_hello) throw alert(Alert.unexpected_message, 'expected ClientHello');
        this.expectLevel(level, 'initial');
        this.serverClientHello(msg, r);
        return;
      }
      case 'wait_client_fin': {
        this.expectLevel(level, 'handshake');
        if (type === HS.certificate) {
          // We never request client certificates; tolerate an empty one.
          this.transcript.push(msg);
          return;
        }
        if (type !== HS.finished) throw alert(Alert.unexpected_message, 'expected client Finished');
        const s = this.suite!;
        const expected = hmac(s.hash, hkdfExpandLabel(s.hash, this.clientHsSecret!, 'finished', Buffer.alloc(0), s.hashLen), this.th());
        if (!expected.equals(r.rest())) throw alert(Alert.decrypt_error, 'client Finished does not verify');
        this.transcript.push(msg);
        this.cb.keys('1rtt', 'read', s, this.appSecrets!.client);
        this.resumptionMaster = deriveSecret(s.hash, this.masterSecret!, 'res master', this.th());
        this.complete = true;
        this.state = 'connected';
        this.cb.done();
        return;
      }
      default:
        throw alert(Alert.unexpected_message, `unexpected handshake message ${type}`);
    }
  }

  private serverClientHello(msg: Buffer, r: Reader) {
    const o = this.sopts;
    r.u16();
    r.bytes(32);
    const sessionId = Buffer.from(r.vec(1));
    const suitesR = new Reader(r.vec(2));
    const offered: number[] = [];
    while (suitesR.left) offered.push(suitesR.u16());
    r.vec(1);
    // Extensions, keeping the offset of the PSK binders for verification.
    const extLen = r.u16();
    const extEnd = r.pos + extLen;
    const ext = new Map<number, Buffer>();
    let lastType = -1;
    let bindersOffset = -1;
    while (r.pos < extEnd) {
      const t = r.u16();
      const len = r.u16();
      const start = r.pos;
      const body = Buffer.from(r.bytes(len));
      if (ext.has(t)) throw alert(Alert.illegal_parameter, 'duplicate extension');
      ext.set(t, body);
      lastType = t;
      if (t === EXT.pre_shared_key) {
        const pr = new Reader(body);
        pr.vec(2);
        bindersOffset = start + pr.pos;
      }
    }
    if (ext.has(EXT.pre_shared_key) && lastType !== EXT.pre_shared_key) throw alert(Alert.illegal_parameter, 'pre_shared_key is not the last extension');

    const sv = ext.get(EXT.supported_versions);
    if (!sv || !(() => {
      const vr = new Reader(sv);
      const l = new Reader(vr.vec(1));
      while (l.left) if (l.u16() === 0x0304) return true;
      return false;
    })())
      throw alert(Alert.protocol_version, 'client does not offer TLS 1.3');
    const mine = o.suites ?? [0x1301, 0x1302, 0x1303];
    const suiteId = offered.find((x) => mine.includes(x));
    if (suiteId === undefined) throw alert(Alert.handshake_failure, 'no cipher suite in common');
    if (this.state === 'wait_ch2' && suiteId !== this.suite!.id) throw alert(Alert.illegal_parameter, 'cipher suite changed after HelloRetryRequest');
    const suite = SUITES[suiteId]!;

    const sni = ext.get(EXT.server_name);
    if (sni) {
      const sr = new Reader(new Reader(sni).vec(2));
      sr.u8();
      this.serverName = sr.vec(2).toString('ascii');
    }
    const alpnExt = ext.get(EXT.alpn);
    if (!alpnExt) throw alert(Alert.no_application_protocol, 'client did not offer ALPN');
    const al = new Reader(new Reader(alpnExt).vec(2));
    const theirs: string[] = [];
    while (al.left) theirs.push(al.vec(1).toString());
    const proto = theirs.find((p) => o.alpn.includes(p));
    if (!proto) throw alert(Alert.no_application_protocol, `no ALPN in common (client offered ${theirs.join(', ')})`);
    this.alpn = proto;
    const tp = ext.get(EXT.quic_transport_parameters);
    if (!tp) throw alert(Alert.missing_extension, 'client sent no QUIC transport parameters');
    this.peerTransportParams = tp;

    // Key share: pick a group we support from the client's shares, or ask for one.
    const groupsExt = ext.get(EXT.supported_groups);
    const theirGroups: number[] = [];
    if (groupsExt) {
      const gr = new Reader(new Reader(groupsExt).vec(2));
      while (gr.left) theirGroups.push(gr.u16());
    }
    const shares = new Map<number, Buffer>();
    const ksExt = ext.get(EXT.key_share);
    if (ksExt) {
      const kr = new Reader(new Reader(ksExt).vec(2));
      while (kr.left) {
        const g = kr.u16();
        shares.set(g, Buffer.from(kr.vec(2)));
      }
    }
    const forced = this.state === 'start' && o.forceHrr ? GROUPS[o.forceHrr] : undefined;
    let group = forced && !shares.has(forced) ? undefined : [GROUPS.x25519, GROUPS.secp256r1].find((g) => shares.has(g) && (!forced || g === forced));
    if (group === undefined) {
      const want = forced ?? [GROUPS.x25519, GROUPS.secp256r1].find((g) => theirGroups.includes(g));
      if (want === undefined || this.state === 'wait_ch2') throw alert(Alert.handshake_failure, 'no key share group in common');
      this.suite = suite;
      const ch1 = hash(suite.hash, msg);
      this.transcript = [Buffer.concat([Buffer.of(254, 0, 0, ch1.length), ch1])];
      const hrr = new Writer().u16(0x0303).bytes(HRR_RANDOM).vec(1, sessionId).u16(suiteId).u8(0);
      hrr.nested(2, (x) => {
        x.u16(EXT.supported_versions).nested(2, (y) => y.u16(0x0304));
        x.u16(EXT.key_share).nested(2, (y) => y.u16(want));
      });
      this.emit('initial', HS.server_hello, hrr.finish());
      this.helloRetry = true;
      this.state = 'wait_ch2';
      return;
    }
    this.group = group;
    this.suite = suite;

    // PSK resumption.
    let pskIndex = -1;
    const pskExt = ext.get(EXT.pre_shared_key);
    const modes = ext.get(EXT.psk_key_exchange_modes);
    let ticketState: TicketState | undefined;
    if (pskExt && modes && modes.includes(1) && o.ticketKey) {
      const pr = new Reader(pskExt);
      const ids = new Reader(pr.vec(2));
      const identity = Buffer.from(ids.vec(2));
      const obfAge = ids.u32();
      const st = openTicket(o.ticketKey, identity);
      if (st && st.suite === suiteId && st.alpn === proto && Date.now() - st.issued < 86400_000 * 7) {
        const binders = new Reader(pr.vec(2));
        const binder = binders.vec(1);
        // Binder covers the ClientHello up to the binders list.
        const truncated = msg.subarray(0, bindersOffset);
        const early = hkdfExtract(suite.hash, Buffer.alloc(0), st.psk);
        const binderKey = deriveSecret(suite.hash, early, 'res binder', hash(suite.hash));
        const fk = hkdfExpandLabel(suite.hash, binderKey, 'finished', Buffer.alloc(0), suite.hashLen);
        const expect = hmac(suite.hash, fk, hash(suite.hash, ...this.transcript, truncated));
        if (!expect.equals(binder)) throw alert(Alert.decrypt_error, 'PSK binder does not verify');
        pskIndex = 0;
        ticketState = st;
        this.psk = st.psk;
        this.earlySecret = early;
        void obfAge;
      }
    }
    this.resumed = pskIndex === 0;
    this.transcript.push(msg);

    if (ext.has(EXT.early_data)) {
      this.earlyDataOffered = true;
      this.earlyDataAccepted = !!(this.resumed && o.acceptEarlyData && ticketState?.maxEarlyData && this.state === 'start');
      if (this.earlyDataAccepted) this.cb.keys('0rtt', 'read', suite, deriveSecret(suite.hash, this.earlySecret!, 'c e traffic', this.th()));
    }

    const share = makeKeyShare(group);
    const dhe = share.secret(shares.get(group)!);
    const sh = new Writer().u16(0x0303).bytes(randomBytes(32)).vec(1, sessionId).u16(suiteId).u8(0);
    sh.nested(2, (x) => {
      x.u16(EXT.supported_versions).nested(2, (y) => y.u16(0x0304));
      x.u16(EXT.key_share).nested(2, (y) => y.u16(group).vec(2, share.pub));
      if (this.resumed) x.u16(EXT.pre_shared_key).nested(2, (y) => y.u16(0));
    });
    this.emit('initial', HS.server_hello, sh.finish());
    this.handshakeKeys(dhe);

    const ee = new Writer();
    ee.nested(2, (x) => {
      x.u16(EXT.alpn).nested(2, (y) => y.nested(2, (z) => z.vec(1, Buffer.from(proto))));
      const params = typeof o.transportParams === 'function' ? o.transportParams() : o.transportParams;
      x.u16(EXT.quic_transport_parameters).vec(2, params);
      if (this.earlyDataAccepted) x.u16(EXT.early_data).u16(0);
    });
    this.emit('handshake', HS.encrypted_extensions, ee.finish());

    if (!this.resumed) {
      const pair = typeof o.cert === 'function' ? o.cert(this.serverName) : { cert: o.cert, key: o.key! };
      this.serverKey = createPrivateKeyCached(pair.key);
      this.serverChain = pemChain(pair.cert);
      const cert = new Writer().vec(1, Buffer.alloc(0));
      cert.nested(3, (l) => this.serverChain.forEach((der) => l.vec(3, der).u16(0)));
      this.emit('handshake', HS.certificate, cert.finish());
      const theirSigs: number[] = [];
      const sa = ext.get(EXT.signature_algorithms);
      if (sa) {
        const sr = new Reader(new Reader(sa).vec(2));
        while (sr.left) theirSigs.push(sr.u16());
      }
      const scheme = schemeFor(this.serverKey).find((x) => theirSigs.includes(x));
      if (scheme === undefined) throw alert(Alert.handshake_failure, 'no signature scheme in common');
      const sig = signWith(this.serverKey, scheme, verifyContent(true, this.th()));
      this.emit('handshake', HS.certificate_verify, new Writer().u16(scheme).vec(2, sig).finish());
    }
    const fin = hmac(suite.hash, hkdfExpandLabel(suite.hash, this.serverHsSecret!, 'finished', Buffer.alloc(0), suite.hashLen), this.th());
    this.emit('handshake', HS.finished, fin);
    this.appKeys();
    this.state = 'wait_client_fin';
  }

  /** Server: issue a session ticket (call after the handshake completes). */
  issueTicket(opts: { maxEarlyData?: number; transportParams?: Buffer } = {}): void {
    const key = this.sopts.ticketKey;
    if (this.isClient || !key || !this.complete) return;
    const s = this.suite!;
    const nonce = randomBytes(8);
    const psk = hkdfExpandLabel(s.hash, this.resumptionMaster!, 'resumption', nonce, s.hashLen);
    const maxEarlyData = this.sopts.acceptEarlyData ? (opts.maxEarlyData ?? 0xffffffff) : 0;
    const ticket = sealTicket(key, { psk, suite: s.id, alpn: this.alpn ?? '', issued: Date.now(), maxEarlyData });
    const w = new Writer().u32(86400).u32(randomBytes(4).readUInt32BE(0)).vec(1, nonce).vec(2, ticket);
    w.nested(2, (x) => {
      if (maxEarlyData) x.u16(EXT.early_data).nested(2, (y) => y.u32(maxEarlyData));
    });
    const body = w.finish();
    const msg = Buffer.concat([Buffer.of(HS.new_session_ticket, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff), body]);
    this.cb.send('1rtt', msg);
  }
}

// --- helpers --------------------------------------------------------------

interface TicketState {
  psk: Buffer;
  suite: number;
  alpn: string;
  issued: number;
  maxEarlyData: number;
}

function sealTicket(key: Buffer, st: TicketState): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.from(JSON.stringify({ ...st, psk: st.psk.toString('base64') }));
  return Buffer.concat([iv, c.update(body), c.final(), c.getAuthTag()]);
}

function openTicket(key: Buffer, t: Buffer): TicketState | null {
  if (t.length < 29) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, t.subarray(0, 12));
    d.setAuthTag(t.subarray(t.length - 16));
    const body = JSON.parse(Buffer.concat([d.update(t.subarray(12, t.length - 16)), d.final()]).toString()) as TicketState & { psk: string };
    return { ...body, psk: Buffer.from(body.psk as unknown as string, 'base64') };
  } catch {
    return null;
  }
}

function pemChain(pem: string): Buffer[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'));
}

const keyCache = new Map<string, KeyObject>();
function createPrivateKeyCached(pem: string): KeyObject {
  let k = keyCache.get(pem);
  if (!k) {
    k = createPrivateKeyFromPem(pem);
    keyCache.set(pem, k);
  }
  return k;
}

const createPrivateKeyFromPem = (pem: string) => createPrivateKey(pem);

export type { HashName };
