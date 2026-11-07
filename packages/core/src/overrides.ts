import { createHash } from 'node:crypto';
import { bytesToString } from '@siteinquisition/codecs';
import { newId } from './ids.js';
import type { HookMessage, MockRule, ReplaceRule } from './rules.js';
import type { Breakpoint } from './intercept.js';
import type { Script } from './scripts.js';
import type { CaptureStore, Transform } from './store.js';

/**
 * What changes live traffic, seen as one thing: mocks, match and replace
 * rules, breakpoints and live hooks. Each keeps its own engine and editor;
 * this adds a master switch that suspends them all without touching their
 * own on/off state, named groups that turn a set on or off together, and
 * the record of what each one did to an exchange.
 */

export type OverrideKind = 'mock' | 'replace' | 'breakpoint' | 'hook';

export interface OverrideRef {
  kind: OverrideKind;
  id: string;
}

export interface OverrideGroup {
  id: string;
  name: string;
  members: OverrideRef[];
}

export interface OverrideState {
  /** True while every override is suspended. Saved with the project, so reopening it stays suspended. */
  suspended: boolean;
  suspendedAt?: number;
  groups: OverrideGroup[];
}

const META_KEY: Record<OverrideKind, string> = { mock: 'mocks', replace: 'replaceRules', breakpoint: 'breakpoints', hook: 'scripts' };

/** A short hash of a rule's definition: which version of it ran. */
export function revisionOf(rule: unknown): string {
  return createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 12);
}

const LIMIT = 400;

/** Excerpts around the first difference, so a 2 MB body change records a few hundred characters. */
export function excerpt(before: string, after: string): { before: string; after: string; truncated: boolean } {
  if (before.length <= LIMIT && after.length <= LIMIT) return { before, after, truncated: false };
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  const start = Math.max(0, i - 80);
  const cut = (s: string) => (start > 0 ? '…' : '') + s.slice(start, start + LIMIT) + (s.length > start + LIMIT ? '…' : '');
  return { before: cut(before), after: cut(after), truncated: true };
}

/** The part of a message a replace rule targets, as text. */
export function targetText(msg: HookMessage, rule: Pick<ReplaceRule, 'target' | 'header'>): string {
  switch (rule.target) {
    case 'url':
      return msg.url;
    case 'status':
      return String(msg.status ?? '');
    case 'header': {
      const name = (rule.header ?? '').toLowerCase();
      return msg.headers
        .filter(([k]) => k.toLowerCase() === name)
        .map(([, v]) => v)
        .join('\n');
    }
    default:
      return bytesToString(msg.body.subarray(0, 512 * 1024));
  }
}

export function replaceTransform(phase: 'request' | 'response', rule: ReplaceRule, before: string, after: string): Transform {
  const ex = excerpt(before, after);
  return {
    phase,
    kind: 'replace',
    ruleId: rule.id,
    name: rule.name,
    revision: revisionOf(rule),
    outcome: 'changed',
    target: rule.target === 'header' ? `header ${rule.header ?? ''}` : rule.target,
    before: ex.before,
    after: ex.after,
    ...(ex.truncated ? { truncated: true } : {}),
    at: Date.now(),
  };
}

export class OverrideControl {
  constructor(
    private readonly store: CaptureStore,
    private readonly onApplied: (kinds: OverrideKind[]) => void = () => {},
  ) {}

  state(): OverrideState {
    const s = this.store.getMeta<{ suspended?: boolean; at?: number }>('overridesSuspended') ?? {};
    return { suspended: !!s.suspended, ...(s.at ? { suspendedAt: s.at } : {}), groups: this.groups() };
  }

  get suspended(): boolean {
    return !!this.store.getMeta<{ suspended?: boolean }>('overridesSuspended')?.suspended;
  }

  /** Suspend or resume every override. Their own on/off settings are left exactly as they are. */
  setSuspended(on: boolean): OverrideState {
    this.store.setMeta('overridesSuspended', on ? { suspended: true, at: Date.now() } : { suspended: false });
    return this.state();
  }

  groups(): OverrideGroup[] {
    return this.store.getMeta<OverrideGroup[]>('overrideGroups') ?? [];
  }

  setGroups(list: Array<Omit<OverrideGroup, 'id'> & { id?: string }>): OverrideGroup[] {
    const out = list.map((g) => {
      if (!g || typeof g.name !== 'string' || !g.name.trim()) throw new Error('a group needs a name');
      if (!Array.isArray(g.members)) throw new Error(`group "${g.name}" needs a members list`);
      const members = g.members.map((m) => {
        if (!m || !(m.kind in META_KEY) || typeof m.id !== 'string') throw new Error(`group "${g.name}": members are {kind, id} with kind mock, replace, breakpoint or hook`);
        return { kind: m.kind, id: m.id };
      });
      return { id: g.id ?? newId(), name: g.name.trim(), members };
    });
    this.store.setMeta('overrideGroups', out);
    return out;
  }

  private lists() {
    return {
      mock: this.store.getMeta<MockRule[]>('mocks') ?? [],
      replace: this.store.getMeta<ReplaceRule[]>('replaceRules') ?? [],
      breakpoint: this.store.getMeta<Breakpoint[]>('breakpoints') ?? [],
      hook: this.store.getMeta<Script[]>('scripts') ?? [],
    };
  }

  /**
   * Turn a group's members on or off together. All or nothing: a member that
   * no longer exists stops the whole change, and nothing is written. With
   * `dryRun` it only reports what would change, and which members are also in
   * other groups (turning them off here turns them off there too).
   */
  applyGroup(id: string, on: boolean, opts: { dryRun?: boolean } = {}): { changed: OverrideRef[]; unchanged: OverrideRef[]; shared: Array<OverrideRef & { groups: string[] }> } {
    const group = this.groups().find((g) => g.id === id);
    if (!group) throw new Error('no such override group');
    const lists = this.lists();
    const missing = group.members.filter((m) => !(lists[m.kind] as Array<{ id: string }>).some((x) => x.id === m.id));
    if (missing.length) throw new Error(`group "${group.name}" names ${missing.length} override${missing.length === 1 ? '' : 's'} that no longer exist (${missing.map((m) => `${m.kind} ${m.id}`).join(', ')}); edit the group first. Nothing was changed.`);
    const changed: OverrideRef[] = [];
    const unchanged: OverrideRef[] = [];
    for (const m of group.members) {
      const item = (lists[m.kind] as Array<{ id: string; enabled?: boolean }>).find((x) => x.id === m.id)!;
      if ((item.enabled !== false) === on) unchanged.push(m);
      else changed.push(m);
    }
    const shared = group.members
      .map((m) => ({ ...m, groups: this.groups().filter((g) => g.id !== id && g.members.some((x) => x.kind === m.kind && x.id === m.id)).map((g) => g.name) }))
      .filter((m) => m.groups.length);
    if (opts.dryRun || !changed.length) return { changed, unchanged, shared };
    const next = { ...lists };
    for (const kind of Object.keys(next) as OverrideKind[]) {
      const ids = new Set(changed.filter((c) => c.kind === kind).map((c) => c.id));
      if (!ids.size) continue;
      (next as Record<OverrideKind, Array<{ id: string; enabled?: boolean }>>)[kind] = (next[kind] as Array<{ id: string; enabled?: boolean }>).map((x) => (ids.has(x.id) ? { ...x, enabled: on } : x));
    }
    // One transaction: either every member changes, or none does.
    this.store.tx(() => {
      for (const kind of Object.keys(next) as OverrideKind[]) if (changed.some((c) => c.kind === kind)) this.store.setMeta(META_KEY[kind], next[kind]);
    });
    this.onApplied([...new Set(changed.map((c) => c.kind))]);
    return { changed, unchanged, shared };
  }
}
