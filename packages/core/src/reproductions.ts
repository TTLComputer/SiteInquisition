import { newId } from './ids.js';
import { statusOk, type FlowRunner, type ApiFlow } from './flows.js';
import type { MatchCondition } from './match.js';
import { conditionsMatch, responseSubject } from './rules.js';
import type { Sender, SendOptions, Macro } from './send.js';
import type { CaptureStore, HeaderList } from './store.js';
import type { WsReplays } from './wsreplay.js';
import type { WsScript } from './wsscript.js';

/**
 * Saved reproductions: a request, flow or WebSocket conversation kept by
 * name, with its inputs, assertions and the session it runs in, so it can be
 * rerun later from one place. Every save makes a new revision; a run records
 * the revision it ran, so later edits never change what an old run means.
 *
 * Flows and WebSocket scripts are not copied into a new format: a flow
 * reproduction points at the saved flow by id, and a conversation keeps the
 * same WsScript the WS Replay editor uses.
 */

export interface ReproRequest {
  method: string;
  url: string;
  headers: HeaderList;
  /** Written decoded; tokens are filled in when it runs. */
  body?: string;
}

export type ReproDefinition =
  | { kind: 'request'; request: ReproRequest; options?: Pick<SendOptions, 'refreshCookies' | 'csrf' | 'followRedirects' | 'protocol' | 'applyRules' | 'loginMacro'> }
  | { kind: 'flow'; flowId: string }
  | { kind: 'ws'; script: WsScript };

/** One check on the result. Exactly one of status, where or maxMs. */
export interface Assertion {
  id: string;
  label?: string;
  /** "2xx", "200", "200,201". */
  status?: string;
  /** A condition on the response (or, with side "request", the request sent). */
  where?: MatchCondition;
  /** Fails when the response took longer. */
  maxMs?: number;
}

export interface ReproRevision {
  revision: number;
  definition: ReproDefinition;
  inputs: Record<string, string>;
  assertions: Assertion[];
  savedAt: number;
  by: string;
}

export interface Reproduction {
  id: string;
  name: string;
  revision: number;
  definition: ReproDefinition;
  /** Default input values; a run can override each one. */
  inputs: Record<string, string>;
  assertions: Assertion[];
  /** Where it came from: the recorded exchange it was saved from. */
  source?: { exchangeId?: string };
  /** Endpoint references, "host METHOD /template". */
  endpoints: string[];
  /** Session profile to run with, unless a run picks another. */
  profile?: string;
  createdAt: number;
  updatedAt: number;
  by: string;
  /** Earlier revisions, newest last, at most 30. */
  history: ReproRevision[];
}

export type ReproInput = Omit<Reproduction, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'by' | 'history' | 'endpoints' | 'inputs' | 'assertions'> & {
  id?: string;
  endpoints?: string[];
  inputs?: Record<string, string>;
  assertions?: Array<Omit<Assertion, 'id'> & { id?: string }>;
};

export type RunState = 'running' | 'passed' | 'failed' | 'canceled' | 'interrupted';

export interface AssertionResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ReproRun {
  id: string;
  reproId: string;
  name: string;
  /** The definition revision that ran. */
  revision: number;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  exchangeIds: string[];
  assertions: AssertionResult[];
  profile?: string;
  /** Where each input came from. Values are not kept: a run is safe to share. */
  inputSources: Record<string, ValueSource>;
  notes: string[];
  error?: string;
}

/**
 * A session profile: the named values, cookie policy, setup flow and base URL
 * a run uses. Profiles hold references, not credentials: put secrets in
 * identities or signing keys (sealed with the keyring) and name them here.
 */
export interface SessionProfile {
  id: string;
  name: string;
  values: Record<string, string>;
  /** "jar": send the cookie jar's current cookies for the target. "none": send no Cookie header. Default: as written. */
  cookies?: 'jar' | 'none' | 'as-written';
  /** A flow (by name or id) or login macro (by name) run first. */
  setupFlow?: string;
  /** Send to this origin instead, e.g. https://staging.example.com. */
  baseUrl?: string;
}

export type ValueSource = 'run' | 'reproduction' | 'profile' | 'project';
export interface EffectiveValue {
  name: string;
  value: string;
  source: ValueSource;
}

/** Explicit run inputs beat reproduction defaults, which beat profile values, which beat project variables. */
export function effectiveValues(project: Record<string, string>, profile: SessionProfile | undefined, repro: Pick<Reproduction, 'inputs'>, run: Record<string, string> = {}): EffectiveValue[] {
  const out = new Map<string, EffectiveValue>();
  const layer = (vals: Record<string, string> | undefined, source: ValueSource) => {
    for (const [name, value] of Object.entries(vals ?? {})) out.set(name, { name, value, source });
  };
  layer(project, 'project');
  layer(profile?.values, 'profile');
  layer(repro.inputs, 'reproduction');
  layer(run, 'run');
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_HISTORY = 30;
const MAX_RUNS = 300;
const RUN_TIMEOUT_MS = 120_000;

export interface ReproDeps {
  store: CaptureStore;
  sender: () => Sender;
  flows: () => FlowRunner;
  ws: () => WsReplays;
  flowList: () => ApiFlow[];
  macros: () => Macro[];
  saveFlow: (f: Omit<ApiFlow, 'id'> & { id?: string }) => ApiFlow;
  projectVars: () => Record<string, string>;
}

function normalizeAssertion(a: Omit<Assertion, 'id'> & { id?: string }): Assertion {
  const kinds = [a.status !== undefined, a.where !== undefined, a.maxMs !== undefined].filter(Boolean).length;
  if (kinds !== 1) throw new Error('an assertion checks one thing: status, where or maxMs');
  if (a.status !== undefined && !/^\s*(\dxx|\d{3})(\s*,\s*(\dxx|\d{3}))*\s*$/i.test(a.status)) throw new Error(`assertion status "${a.status}" should look like 2xx, 200 or 200,201`);
  if (a.maxMs !== undefined && !(Number(a.maxMs) > 0)) throw new Error('assertion maxMs must be a positive number');
  if (a.where && (typeof a.where !== 'object' || !a.where.in)) throw new Error('assertion where needs a condition {in, name, op, value}');
  return { id: a.id ?? newId(), ...(a.label ? { label: a.label } : {}), ...(a.status !== undefined ? { status: a.status.trim() } : {}), ...(a.where ? { where: a.where } : {}), ...(a.maxMs !== undefined ? { maxMs: Number(a.maxMs) } : {}) };
}

function validateDefinition(d: ReproDefinition): ReproDefinition {
  if (!d || typeof d !== 'object') throw new Error('a reproduction needs a definition');
  if (d.kind === 'request') {
    const r = d.request;
    if (!r || typeof r.method !== 'string' || !r.method.trim() || typeof r.url !== 'string' || !Array.isArray(r.headers)) throw new Error('a request reproduction needs method, url and headers');
    return { kind: 'request', request: { method: r.method.trim().toUpperCase(), url: r.url, headers: r.headers.map(([k, v]) => [String(k), String(v)]), ...(r.body ? { body: String(r.body) } : {}) }, ...(d.options ? { options: d.options } : {}) };
  }
  if (d.kind === 'flow') {
    if (typeof d.flowId !== 'string' || !d.flowId) throw new Error('a flow reproduction needs flowId');
    return { kind: 'flow', flowId: d.flowId };
  }
  if (d.kind === 'ws') {
    if (!d.script || typeof d.script.url !== 'string' || !Array.isArray(d.script.steps)) throw new Error('a conversation reproduction needs a WebSocket script');
    return { kind: 'ws', script: d.script };
  }
  throw new Error('definition kind must be request, flow or ws');
}

export const describeAssertion = (a: Assertion): string =>
  a.label ??
  (a.status !== undefined
    ? `status is ${a.status}`
    : a.maxMs !== undefined
      ? `takes at most ${a.maxMs} ms`
      : `${a.where!.not ? 'not ' : ''}${a.where!.in}${a.where!.name ? ` ${a.where!.name}` : ''} ${a.where!.op ?? 'equals'}${a.where!.value !== undefined ? ` ${a.where!.value}` : ''}`);

export class Reproductions {
  private canceled = new Set<string>();

  constructor(private readonly d: ReproDeps) {
    // A run still marked running when the app stopped did not finish: say so instead of leaving it spinning.
    const runs = this.runs();
    if (runs.some((r) => r.state === 'running')) {
      d.store.setMeta(
        'reproductionRuns',
        runs.map((r) => (r.state === 'running' ? { ...r, state: 'interrupted', endedAt: r.endedAt ?? Date.now(), notes: [...r.notes, 'The app stopped before this run finished.'] } : r)),
      );
    }
  }

  list(): Reproduction[] {
    return this.d.store.getMeta<Reproduction[]>('reproductions') ?? [];
  }

  get(idOrName: string): Reproduction {
    const r = this.list().find((x) => x.id === idOrName) ?? this.list().find((x) => x.name === idOrName);
    if (!r) throw new Error(`no saved reproduction "${idOrName}"`);
    return r;
  }

  /**
   * Save a new reproduction, or a new revision of one. Pass the revision you
   * started from as `baseRevision`; if someone saved since, nothing is
   * written and the error says so, instead of overwriting their change.
   */
  save(input: ReproInput, baseRevision?: number): Reproduction {
    if (!input.name?.trim()) throw new Error('a reproduction needs a name');
    const definition = validateDefinition(input.definition);
    const assertions = (input.assertions ?? []).map(normalizeAssertion);
    const inputs = Object.fromEntries(Object.entries(input.inputs ?? {}).map(([k, v]) => [k, String(v)]));
    const list = this.list();
    const now = Date.now();
    const by = this.d.store.actor;
    const at = input.id ? list.findIndex((x) => x.id === input.id) : -1;
    const clash = list.find((x) => x.name === input.name.trim() && x.id !== input.id);
    if (clash) throw new Error(`a reproduction named "${clash.name}" already exists`);
    let out: Reproduction;
    if (at === -1) {
      out = { id: input.id ?? newId(), name: input.name.trim(), revision: 1, definition, inputs, assertions, ...(input.source ? { source: input.source } : {}), endpoints: input.endpoints ?? [], ...(input.profile ? { profile: input.profile } : {}), createdAt: now, updatedAt: now, by, history: [] };
      list.push(out);
    } else {
      const cur = list[at]!;
      if (baseRevision !== undefined && baseRevision !== cur.revision) throw new Error(`"${cur.name}" was saved again (revision ${cur.revision}, by ${cur.by}) since you opened revision ${baseRevision}; reopen it to see that change. Nothing was saved.`);
      const prev: ReproRevision = { revision: cur.revision, definition: cur.definition, inputs: cur.inputs, assertions: cur.assertions, savedAt: cur.updatedAt, by: cur.by };
      out = {
        ...cur,
        name: input.name.trim(),
        revision: cur.revision + 1,
        definition,
        inputs,
        assertions,
        ...(input.source ? { source: input.source } : {}),
        endpoints: input.endpoints ?? cur.endpoints,
        profile: input.profile,
        updatedAt: now,
        by,
        history: [...cur.history, prev].slice(-MAX_HISTORY),
      };
      if (!out.profile) delete out.profile;
      list[at] = out;
    }
    this.d.store.setMeta('reproductions', list);
    return out;
  }

  remove(id: string): void {
    this.d.store.setMeta('reproductions', this.list().filter((x) => x.id !== id));
  }

  /** The definition a run used, even after later edits. */
  revisionOf(id: string, revision: number): ReproRevision | undefined {
    const r = this.get(id);
    if (r.revision === revision) return { revision, definition: r.definition, inputs: r.inputs, assertions: r.assertions, savedAt: r.updatedAt, by: r.by };
    return r.history.find((h) => h.revision === revision);
  }

  /** Turn a request reproduction into a one-step flow, keeping its id, name, source and runs. */
  promoteToFlow(id: string): Reproduction {
    const r = this.get(id);
    if (r.definition.kind !== 'request') throw new Error('only a single request can be made into a flow');
    const req = r.definition.request;
    const flowName = r.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'reproduction';
    const taken = new Set(this.d.flowList().map((f) => f.name));
    let name = flowName;
    for (let i = 2; taken.has(name); i++) name = `${flowName}-${i}`;
    const flow = this.d.saveFlow({ name, description: `From the saved reproduction "${r.name}"`, steps: [{ id: newId(), name: r.name, kind: 'request', method: req.method, url: req.url, headers: req.headers, ...(req.body ? { body: req.body } : {}) }] });
    return this.save({ ...r, definition: { kind: 'flow', flowId: flow.id } }, r.revision);
  }

  // ---------- session profiles ----------

  profiles(): SessionProfile[] {
    return this.d.store.getMeta<SessionProfile[]>('sessionProfiles') ?? [];
  }

  setProfiles(list: Array<Omit<SessionProfile, 'id'> & { id?: string }>): SessionProfile[] {
    const names = new Set<string>();
    const out = list.map((p) => {
      if (!p?.name?.trim()) throw new Error('a session profile needs a name');
      if (names.has(p.name.trim())) throw new Error(`two profiles are named "${p.name}"`);
      names.add(p.name.trim());
      if (p.baseUrl) {
        try {
          new URL(p.baseUrl);
        } catch {
          throw new Error(`profile "${p.name}": base URL "${p.baseUrl}" is not a URL`);
        }
      }
      return {
        id: p.id ?? newId(),
        name: p.name.trim(),
        values: Object.fromEntries(Object.entries(p.values ?? {}).map(([k, v]) => [k, String(v)])),
        ...(p.cookies ? { cookies: p.cookies } : {}),
        ...(p.setupFlow ? { setupFlow: p.setupFlow } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl.replace(/\/$/, '') } : {}),
      };
    });
    this.d.store.setMeta('sessionProfiles', out);
    return out;
  }

  private profile(idOrName: string | undefined): SessionProfile | undefined {
    if (!idOrName) return undefined;
    const p = this.profiles().find((x) => x.id === idOrName || x.name === idOrName);
    if (!p) throw new Error(`no session profile "${idOrName}"; pick one in Project settings, Session and authentication, Profiles`);
    return p;
  }

  /** What a run would use, value by value, and where each value comes from. */
  effective(id: string, opts: { profile?: string; inputs?: Record<string, string> } = {}): { profile?: string; values: EffectiveValue[]; setupFlow?: string; target?: string } {
    const r = this.get(id);
    const p = this.profile(opts.profile ?? r.profile);
    const target = r.definition.kind === 'request' ? (p?.baseUrl ? rebase(r.definition.request.url, p.baseUrl) : r.definition.request.url) : r.definition.kind === 'ws' ? r.definition.script.url : undefined;
    return { ...(p ? { profile: p.name } : {}), values: effectiveValues(this.d.projectVars(), p, r, opts.inputs), ...(p?.setupFlow ? { setupFlow: p.setupFlow } : {}), ...(target ? { target } : {}) };
  }

  // ---------- runs ----------

  runs(reproId?: string): ReproRun[] {
    const all = this.d.store.getMeta<ReproRun[]>('reproductionRuns') ?? [];
    return reproId ? all.filter((r) => r.reproId === reproId) : all;
  }

  private writeRun(run: ReproRun): void {
    const all = this.runs().filter((r) => r.id !== run.id);
    all.push(run);
    this.d.store.setMeta('reproductionRuns', all.slice(-MAX_RUNS));
  }

  /** Ask a running run to stop. It is recorded as canceled; requests already sent stay recorded. */
  cancel(runId: string): boolean {
    const run = this.runs().find((r) => r.id === runId);
    if (!run || run.state !== 'running') return false;
    this.canceled.add(runId);
    if (run.exchangeIds[0]) {
      try {
        this.d.ws().close(run.exchangeIds[0]);
      } catch {
        // not a conversation
      }
    }
    return true;
  }

  /**
   * Run a saved reproduction with explicit inputs and session. Starts the run
   * and resolves when it ends; the run record is written first, so a crash
   * leaves it "interrupted" rather than missing.
   */
  async run(idOrName: string, opts: { inputs?: Record<string, string>; profile?: string; ignoreTlsErrors?: boolean } = {}): Promise<ReproRun> {
    const r = this.get(idOrName);
    const profile = this.profile(opts.profile ?? r.profile);
    const values = effectiveValues(this.d.projectVars(), profile, r, opts.inputs);
    const run: ReproRun = {
      id: newId(),
      reproId: r.id,
      name: r.name,
      revision: r.revision,
      state: 'running',
      startedAt: Date.now(),
      exchangeIds: [],
      assertions: [],
      ...(profile ? { profile: profile.name } : {}),
      inputSources: Object.fromEntries(values.filter((v) => v.source !== 'project').map((v) => [v.name, v.source])),
      notes: [],
    };
    this.writeRun(run);
    const vars = Object.fromEntries(values.filter((v) => v.source !== 'project').map((v) => [v.name, v.value]));
    try {
      const setup = profile?.setupFlow ? this.setupFlowName(profile.setupFlow) : undefined;
      if (setup) run.notes.push(`Setup flow ${setup} ran first.`);
      const def = r.definition;
      let target: { id: string } | undefined;
      if (def.kind === 'request') {
        let req = def.request;
        let refreshCookies = def.options?.refreshCookies;
        if (profile?.baseUrl) {
          const moved = rebase(req.url, profile.baseUrl);
          if (new URL(moved).origin !== new URL(req.url).origin) {
            // A different destination must not reuse credentials captured for another one.
            req = { ...req, url: moved, headers: req.headers.filter(([k]) => !/^(cookie|authorization)$/i.test(k)) };
            run.notes.push(`Sent to ${new URL(moved).origin} (profile ${profile.name}); the recorded Cookie and Authorization headers were left out.`);
            refreshCookies = true;
          }
        }
        if (profile?.cookies === 'jar') refreshCookies = true;
        if (profile?.cookies === 'none') req = { ...req, headers: req.headers.filter(([k]) => k.toLowerCase() !== 'cookie') };
        const ex = await this.d.sender().send(
          { method: req.method, url: req.url, headers: req.headers, ...(req.body ? { body: new TextEncoder().encode(req.body) } : {}), replayOf: r.source?.exchangeId ?? null },
          { ...def.options, ...(refreshCookies ? { refreshCookies } : {}), vars, ...(setup ? { flow: setup } : {}), ...(opts.ignoreTlsErrors ? { ignoreTlsErrors: true } : {}) },
        );
        run.exchangeIds.push(ex.id);
        target = ex;
      } else if (def.kind === 'flow') {
        const flow = this.d.flowList().find((f) => f.id === def.flowId);
        if (!flow) throw new Error('the flow this reproduction runs was deleted; edit the reproduction to pick another');
        if (setup) await this.d.flows().run(setup, vars, 0, opts);
        const out = await this.d.flows().run(flow, vars, 0, opts);
        run.exchangeIds.push(...out.steps.flatMap((s) => (s.exchangeId ? [s.exchangeId] : [])));
        if (!out.ok) run.error = out.error ?? 'a flow step failed';
        const last = [...out.steps].reverse().find((s) => s.exchangeId);
        if (last) target = { id: last.exchangeId! };
      } else {
        const ws = this.d.ws();
        const { exchangeId } = await ws.run(def.script, { refreshCookies: profile?.cookies === 'jar', ignoreTlsErrors: opts.ignoreTlsErrors, ...(setup ? { flow: setup } : {}), closeAtEnd: true });
        run.exchangeIds.push(exchangeId);
        this.writeRun(run);
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        while (ws.runState(exchangeId)?.running && Date.now() < deadline && !this.canceled.has(run.id)) await new Promise((res) => setTimeout(res, 50));
        const st = ws.runState(exchangeId);
        const bad = st?.steps.filter((s) => s.status === 'timeout' || s.status === 'error') ?? [];
        if (st?.running && !this.canceled.has(run.id)) run.error = 'the conversation did not finish in time';
        else if (st?.error) run.error = st.error;
        else if (bad.length) run.error = `step ${bad.map((s) => s.index + 1).join(', ')} ${bad[0]!.status === 'timeout' ? 'timed out' : 'failed'}`;
        target = { id: exchangeId };
      }
      run.assertions = target ? this.check(r.assertions, target.id) : r.assertions.map((a) => ({ id: a.id, label: describeAssertion(a), passed: false, detail: 'nothing was sent to check' }));
      run.state = this.canceled.has(run.id) ? 'canceled' : run.error || run.assertions.some((a) => !a.passed) ? 'failed' : 'passed';
    } catch (e) {
      run.error = (e as Error).message;
      run.state = this.canceled.has(run.id) ? 'canceled' : 'failed';
    } finally {
      this.canceled.delete(run.id);
      run.endedAt = Date.now();
      this.writeRun(run);
    }
    return run;
  }

  private setupFlowName(ref: string): string {
    const f = this.d.flowList().find((x) => x.id === ref || x.name === ref);
    if (f) return f.name;
    const m = this.d.macros().find((x) => x.name === ref || x.id === ref);
    if (m) throw new Error(`setup "${ref}" is a login macro; macros run when a send gets 401 or 403 (turn on Log in again in the reproduction's options), not as a setup flow`);
    throw new Error(`setup flow "${ref}" no longer exists; pick another in the session profile`);
  }

  /** Check assertions against a recorded exchange. */
  check(assertions: Assertion[], exchangeId: string): AssertionResult[] {
    const ex = this.d.store.getExchange(exchangeId);
    if (!ex) return assertions.map((a) => ({ id: a.id, label: describeAssertion(a), passed: false, detail: 'the exchange is gone' }));
    const req = { method: ex.method, url: ex.url, headers: ex.requestHeaders, body: this.d.store.getBody(ex.id, 'request', true) ?? new Uint8Array() };
    const res = { method: ex.method, url: ex.url, status: ex.status ?? undefined, headers: ex.responseHeaders ?? [], body: this.d.store.getBody(ex.id, 'response', true) ?? new Uint8Array() };
    return assertions.map((a) => {
      const label = describeAssertion(a);
      if (a.status !== undefined) return { id: a.id, label, passed: statusOk(a.status, ex.status), detail: `status ${ex.status ?? 'none'}` };
      if (a.maxMs !== undefined) return { id: a.id, label, passed: ex.durationMs !== null && ex.durationMs <= a.maxMs, detail: `${ex.durationMs ?? '?'} ms` };
      const passed = conditionsMatch({ where: [a.where!] }, responseSubject(req, res));
      return { id: a.id, label, passed, detail: passed ? 'matched' : 'did not match' };
    });
  }
}

/** The same path and query on another origin. */
export function rebase(url: string, base: string): string {
  const u = new URL(url);
  const b = new URL(base);
  const path = `${b.pathname.replace(/\/$/, '')}${u.pathname}`;
  return `${b.origin}${path}${u.search}`;
}
