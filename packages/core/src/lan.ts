import { EventEmitter } from 'node:events';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Which other machines may use the proxy and MQTT listeners when LAN access
 * is on. Loopback is always let in. A device that is not on the allow list
 * is refused, and listed as waiting so the user can allow it; the device's
 * next connection then goes through.
 */

export const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export interface LanPending {
  address: string;
  firstSeen: number;
  lastSeen: number;
  attempts: number;
  /** Which listener it tried: "proxy", "http3" or "mqtt :1883". */
  via: string;
}

interface Range {
  v6: boolean;
  base: bigint;
  bits: number;
}

function toBig(addr: string): { v6: boolean; n: bigint } | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  if (isIPv4(addr)) return { v6: false, n: addr.split('.').reduce((a, p) => (a << 8n) | BigInt(Number(p)), 0n) };
  if (!isIPv6(addr)) return undefined;
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const parts = (s: string | undefined) => (s ? s.split(':') : []);
  let h = parts(head);
  let t = parts(tail);
  // An embedded IPv4 tail counts as two groups.
  const v4 = (arr: string[]) => {
    const last = arr.at(-1);
    if (!last || !isIPv4(last)) return arr;
    const n = last.split('.').map(Number);
    return [...arr.slice(0, -1), ((n[0]! << 8) | n[1]!).toString(16), ((n[2]! << 8) | n[3]!).toString(16)];
  };
  if (tail === undefined) h = v4(h);
  else t = v4(t);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return undefined;
  return { v6: true, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || '0', 16)), 0n) };
}

/** Parse "192.168.1.20", "192.168.1.0/24" or "fd00::/8". Throws on anything else. */
export function parseRange(spec: string): Range {
  const [addr, len] = spec.trim().split('/') as [string, string | undefined];
  const ip = toBig(addr);
  if (!ip) throw new Error(`"${spec}" is not an IP address or CIDR range`);
  const max = ip.v6 ? 128 : 32;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`"${spec}" has an invalid prefix length`);
  const shift = BigInt(max - bits);
  return { v6: ip.v6, base: (ip.n >> shift) << shift, bits };
}

function inRange(addr: string, r: Range): boolean {
  const ip = toBig(addr);
  if (!ip || ip.v6 !== r.v6) return false;
  const shift = BigInt((r.v6 ? 128 : 32) - r.bits);
  return (ip.n >> shift) << shift === r.base;
}

/** Strip IPv4-mapped IPv6 so the same device shows up under one address. */
export const plainAddress = (a: string) => a.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');

export class LanGate extends EventEmitter<{ pending: [LanPending]; change: [] }> {
  private ranges: Array<{ spec: string; range: Range }> = [];
  private waiting = new Map<string, LanPending>();
  private denied = new Set<string>();

  constructor(
    /** Off: only loopback clients get in, whatever the lists say. */
    readonly enabled: boolean,
    allowed: string[] = [],
  ) {
    super();
    this.setAllowed(allowed);
  }

  get allowed(): string[] {
    return this.ranges.map((r) => r.spec);
  }

  setAllowed(specs: string[]): void {
    const next = [...new Set(specs.map((s) => s.trim()).filter(Boolean))].map((spec) => ({ spec, range: parseRange(spec) }));
    this.ranges = next;
    for (const a of [...this.waiting.keys()]) if (this.isAllowed(a)) this.waiting.delete(a);
    this.emit('change');
  }

  allow(spec: string): void {
    const s = spec.includes('/') ? spec : plainAddress(spec);
    this.denied.delete(s);
    this.setAllowed([...this.allowed, s]);
  }

  remove(spec: string): void {
    this.setAllowed(this.allowed.filter((s) => s !== spec));
  }

  /** Stop listing a waiting device for the rest of this session (it stays refused). */
  deny(address: string): void {
    const a = plainAddress(address);
    this.waiting.delete(a);
    this.denied.add(a);
    this.emit('change');
  }

  pending(): LanPending[] {
    return [...this.waiting.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  }

  private isAllowed(address: string): boolean {
    return this.ranges.some((r) => inRange(address, r.range));
  }

  /** Decide on a new connection. Loopback always passes; others need LAN on and an allow entry. */
  accept(remoteAddress: string | undefined, via: string): boolean {
    const raw = remoteAddress ?? '';
    if (LOOPBACK.test(raw)) return true;
    if (!this.enabled) return false;
    const address = plainAddress(raw);
    if (this.isAllowed(address)) return true;
    if (this.denied.has(address) || !address) return false;
    const now = Date.now();
    const seen = this.waiting.get(address);
    if (seen) {
      seen.lastSeen = now;
      seen.attempts++;
    } else {
      if (this.waiting.size >= 100) return false; // a scan; do not grow without bound
      const p: LanPending = { address, firstSeen: now, lastSeen: now, attempts: 1, via };
      this.waiting.set(address, p);
      this.emit('pending', p);
      this.emit('change');
    }
    return false;
  }
}
