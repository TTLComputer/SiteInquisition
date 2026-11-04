import { newId } from './ids.js';

const DEFAULT_PORTS: Record<string, number> = { http: 80, ws: 80, https: 443, wss: 443, mqtt: 1883, mqtts: 8883 };

/**
 * Scope decides, per request, whether SiteInquisition decrypts, records or
 * modifies traffic. Rules are evaluated in order and the first match wins.
 * Traffic that matches nothing gets the default decision, which for a new
 * project is "leave it alone".
 */
export interface ScopeRule {
  id: string;
  action: 'include' | 'exclude';
  /** Host glob, case-insensitive. `*` matches any run of characters, so `*.example.com` matches every subdomain. */
  host: string;
  port?: number;
  scheme?: 'http' | 'https';
  /** Only match paths starting with this prefix. */
  pathPrefix?: string;
  /** Include rules only: intercept TLS for this host. Defaults to true. */
  decrypt?: boolean;
  /** Include rules only: write matching exchanges to the capture database. Defaults to true. */
  record?: boolean;
  /** Include rules only: allow match/replace rules and scripts to change matching traffic. Defaults to true. */
  modify?: boolean;
  enabled?: boolean;
}

export interface ScopeConfig {
  rules: ScopeRule[];
  /** What to do with traffic no rule matches. */
  defaultAction: 'ignore' | 'record';
}

export interface ScopeDecision {
  decrypt: boolean;
  record: boolean;
  modify: boolean;
  ruleId?: string;
}

export const DEFAULT_SCOPE: ScopeConfig = { rules: [], defaultAction: 'ignore' };

const IGNORE: ScopeDecision = { decrypt: false, record: false, modify: false };

export type ScopeRuleInput = Omit<ScopeRule, 'id'> & { id?: string };

export const globToRegExp = (glob: string): RegExp => {
  const body = glob
    .trim()
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
};

const VALID_HOST_GLOB = /^[a-z0-9*.\-:[\]]+$/i;

export function normalizeRule(input: ScopeRuleInput): ScopeRule {
  const host = input.host.trim().toLowerCase();
  if (!host || !VALID_HOST_GLOB.test(host)) throw new Error(`invalid host pattern "${input.host}"`);
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new Error(`invalid port ${input.port}`);
  }
  if (input.pathPrefix !== undefined && !input.pathPrefix.startsWith('/')) {
    throw new Error(`pathPrefix must start with "/"`);
  }
  return { ...input, host, id: input.id ?? newId() };
}

export class Scope {
  private config: ScopeConfig;
  private compiled: Array<{ rule: ScopeRule; host: RegExp }> = [];

  constructor(config: ScopeConfig = DEFAULT_SCOPE) {
    this.config = DEFAULT_SCOPE;
    this.set(config);
  }

  get(): ScopeConfig {
    return structuredClone(this.config);
  }

  set(config: ScopeConfig): void {
    const rules = config.rules.map(normalizeRule);
    this.config = { defaultAction: config.defaultAction ?? 'ignore', rules };
    this.compiled = rules.map((rule) => ({ rule, host: globToRegExp(rule.host) }));
  }

  evaluate(target: URL | string): ScopeDecision {
    const url = typeof target === 'string' ? new URL(target) : target;
    const scheme = url.protocol.replace(/:$/, '');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : (DEFAULT_PORTS[scheme] ?? 80);
    // Rules name http or https; WebSocket and MQTT traffic matches by whether it is encrypted.
    const httpScheme = scheme === 'wss' || scheme === 'mqtts' ? 'https' : scheme === 'ws' || scheme === 'mqtt' ? 'http' : scheme;

    for (const { rule, host: re } of this.compiled) {
      if (rule.enabled === false) continue;
      if (!re.test(host)) continue;
      if (rule.port !== undefined && rule.port !== port) continue;
      if (rule.scheme !== undefined && rule.scheme !== httpScheme) continue;
      if (rule.pathPrefix !== undefined && !url.pathname.startsWith(rule.pathPrefix)) continue;
      if (rule.action === 'exclude') return { ...IGNORE, ruleId: rule.id };
      return {
        decrypt: rule.decrypt ?? true,
        record: rule.record ?? true,
        modify: rule.modify ?? true,
        ruleId: rule.id,
      };
    }
    return this.config.defaultAction === 'record' ? { decrypt: false, record: true, modify: false } : IGNORE;
  }

  /**
   * Host patterns whose TLS should be intercepted. TLS is decided per
   * connection, before any path is known, so a host is decrypted when any
   * enabled include rule for it asks for decryption. Exclude rules still stop
   * recording and modification for matching requests on that connection.
   */
  decryptHosts(): string[] {
    const hosts = new Set<string>();
    for (const { rule } of this.compiled) {
      if (rule.enabled === false || rule.action !== 'include' || rule.decrypt === false) continue;
      hosts.add(rule.host);
    }
    return [...hosts].sort();
  }
}
