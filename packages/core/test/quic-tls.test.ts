import { randomBytes } from 'node:crypto';
import { describe, expect, it } from '@siteinquisition/devkit/test';
import { TlsSession, type Level, type SessionTicket, type TlsClientOptions, type TlsServerOptions } from '../src/quic/tls.js';
import { generateCA, LeafIssuer } from '../src/x509.js';

const ca = generateCA({ commonName: 'SiteInquisition test CA' });
const issuer = new LeafIssuer(ca);

interface Side {
  tls: TlsSession;
  keys: Array<`${Level}:${'read' | 'write'}`>;
  secrets: Map<string, string>;
  done: boolean;
  tickets: SessionTicket[];
  out: Array<[Level, Buffer]>;
}

function side(opts: ConstructorParameters<typeof TlsSession>[0]): Side {
  const s: Side = { keys: [], secrets: new Map(), done: false, tickets: [], out: [], tls: undefined as never };
  s.tls = new TlsSession(opts, {
    send: (level, data) => s.out.push([level, data]),
    keys: (level, dir, _suite, secret) => {
      s.keys.push(`${level}:${dir}`);
      s.secrets.set(`${level}:${dir}`, secret.toString('hex'));
    },
    done: () => (s.done = true),
    ticket: (t) => s.tickets.push(t),
  });
  return s;
}

/** Shuttle messages until neither side has anything to say. */
function pump(a: Side, b: Side) {
  for (let i = 0; i < 20 && (a.out.length || b.out.length); i++) {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const msgs = from.out.splice(0);
      for (const [level, data] of msgs) to.tls.receive(level, data);
    }
  }
}

const serverOpts = (o: Partial<TlsServerOptions> = {}): TlsServerOptions & { server: true } => ({
  server: true,
  cert: (sni) => {
    const leaf = issuer.issue(sni || 'localhost');
    return { cert: leaf.cert, key: leaf.key };
  },
  alpn: ['h3'],
  transportParams: Buffer.from('server-tp'),
  ticketKey: randomBytes(32),
  ...o,
});

const clientOpts = (o: Partial<TlsClientOptions> = {}): TlsClientOptions => ({ serverName: 'example.test', alpn: ['h3'], transportParams: Buffer.from('client-tp'), ca: [ca.cert], ...o });

describe('TLS 1.3 for QUIC', () => {
  it('completes a full handshake with matching secrets', () => {
    const s = side(serverOpts());
    const c = side(clientOpts());
    c.tls.start();
    pump(c, s);
    expect(c.done && s.done).toBe(true);
    expect(c.tls.alpn).toBe('h3');
    expect(s.tls.serverName).toBe('example.test');
    expect(c.tls.peerTransportParams?.toString()).toBe('server-tp');
    expect(s.tls.peerTransportParams?.toString()).toBe('client-tp');
    expect(c.tls.certificateError).toBeNull();
    for (const k of ['handshake', '1rtt']) {
      expect(c.secrets.get(`${k}:write`)).toBe(s.secrets.get(`${k}:read`));
      expect(c.secrets.get(`${k}:read`)).toBe(s.secrets.get(`${k}:write`));
    }
  });

  it('rejects an untrusted certificate unless told not to', () => {
    const s = side(serverOpts());
    const c = side(clientOpts({ ca: [] }));
    c.tls.start();
    expect(() => pump(c, s)).toThrow(/trusted root/);

    const s2 = side(serverOpts());
    const c2 = side(clientOpts({ ca: [], rejectUnauthorized: false }));
    c2.tls.start();
    pump(c2, s2);
    expect(c2.done).toBe(true);
    expect(c2.tls.certificateError).toMatch(/trusted root/);
  });

  it('negotiates each cipher suite and P-256 via HelloRetryRequest', () => {
    for (const suite of [0x1301, 0x1302, 0x1303]) {
      const s = side(serverOpts({ forceHrr: 'secp256r1' }));
      const c = side(clientOpts({ suites: [suite] }));
      c.tls.start();
      pump(c, s);
      expect(c.done && s.done).toBe(true);
      expect(c.tls.helloRetry).toBe(true);
      expect(c.tls.suite?.id).toBe(suite);
      expect(c.secrets.get('1rtt:write')).toBe(s.secrets.get('1rtt:read'));
    }
  });

  it('fails without a common ALPN', () => {
    const s = side(serverOpts());
    const c = side(clientOpts({ alpn: ['h3-29'] }));
    c.tls.start();
    expect(() => pump(c, s)).toThrow(/ALPN/);
  });

  it('resumes with a ticket and sends 0-RTT', () => {
    const ticketKey = randomBytes(32);
    const s = side(serverOpts({ ticketKey, acceptEarlyData: true }));
    const c = side(clientOpts());
    c.tls.start();
    pump(c, s);
    s.tls.issueTicket();
    pump(c, s);
    expect(c.tickets).toHaveLength(1);

    const s2 = side(serverOpts({ ticketKey, acceptEarlyData: true }));
    const c2 = side(clientOpts({ session: c.tickets[0], earlyData: true }));
    c2.tls.start();
    expect(c2.keys).toContain('0rtt:write');
    pump(c2, s2);
    expect(c2.done && s2.done).toBe(true);
    expect(c2.tls.resumed && s2.tls.resumed).toBe(true);
    expect(c2.tls.earlyDataAccepted).toBe(true);
    expect(c2.secrets.get('0rtt:write')).toBe(s2.secrets.get('0rtt:read'));
    expect(c2.secrets.get('1rtt:write')).toBe(s2.secrets.get('1rtt:read'));

    // A server that refuses early data still resumes.
    const s3 = side(serverOpts({ ticketKey, acceptEarlyData: false }));
    const c3 = side(clientOpts({ session: c.tickets[0], earlyData: true }));
    c3.tls.start();
    pump(c3, s3);
    expect(c3.tls.resumed).toBe(true);
    expect(c3.tls.earlyDataAccepted).toBe(false);
  });
});
