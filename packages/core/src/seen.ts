/**
 * Hosts that sent traffic through SiteInquisition without being recorded, so
 * the UI can offer "add to scope" in one click. Kept in memory only: it is a
 * live connection log, not project data.
 */
export interface SeenHost {
  host: string;
  /** How the traffic arrived: plain HTTP, a TLS tunnel we did not decrypt, or MQTT. */
  kinds: Array<'http' | 'tls' | 'mqtt'>;
  count: number;
  lastAt: number;
}

export class SeenHosts {
  private hosts = new Map<string, SeenHost>();

  constructor(private readonly max = 500) {}

  add(host: string | undefined, kind: SeenHost['kinds'][number]): void {
    if (!host) return;
    const key = host.toLowerCase();
    const now = Date.now();
    const cur = this.hosts.get(key);
    if (cur) {
      cur.count++;
      cur.lastAt = now;
      if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
      return;
    }
    if (this.hosts.size >= this.max) {
      const oldest = [...this.hosts.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) this.hosts.delete(oldest.host);
    }
    this.hosts.set(key, { host: key, kinds: [kind], count: 1, lastAt: now });
  }

  list(): SeenHost[] {
    return [...this.hosts.values()].sort((a, b) => b.lastAt - a.lastAt).map((h) => ({ ...h, kinds: [...h.kinds] }));
  }

  forget(host: string): void {
    this.hosts.delete(host.toLowerCase());
  }
}
