import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, flowToTest, jsonDiff, jsonMutations, parseOperations, suggestionsIn, toCurl, validate, type ExchangeSummary } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let base: string;

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
};

// A small GraphQL schema, as introspection returns it.
const T = (name: string, kind = 'SCALAR') => ({ kind, name, ofType: null });
const NN = (t: unknown) => ({ kind: 'NON_NULL', name: null, ofType: t });
const L = (t: unknown) => ({ kind: 'LIST', name: null, ofType: t });
const SCHEMA = {
  queryType: { name: 'Query' },
  mutationType: { name: 'Mutation' },
  subscriptionType: null,
  types: [
    { kind: 'OBJECT', name: 'Query', fields: [{ name: 'order', args: [{ name: 'id', type: NN(T('ID')) }], type: T('Order', 'OBJECT') }, { name: 'orders', args: [], type: L(T('Order', 'OBJECT')) }] },
    { kind: 'OBJECT', name: 'Mutation', fields: [{ name: 'createOrder', args: [{ name: 'input', type: NN(T('OrderInput', 'INPUT_OBJECT')) }], type: T('Order', 'OBJECT') }] },
    { kind: 'OBJECT', name: 'Order', fields: [{ name: 'id', args: [], type: NN(T('ID')) }, { name: 'status', args: [], type: T('Status', 'ENUM') }, { name: 'total', args: [], type: T('Float') }] },
    { kind: 'INPUT_OBJECT', name: 'OrderInput', inputFields: [{ name: 'sku', type: NN(T('String')) }, { name: 'qty', type: T('Int') }] },
    { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'OPEN' }, { name: 'PAID' }] },
    { kind: 'SCALAR', name: 'ID' },
    { kind: 'SCALAR', name: 'String' },
    { kind: '__Schema', name: '__Schema' },
  ],
};

function graphql(body: string, introspection: boolean, res: ServerResponse) {
  const { query } = JSON.parse(body || '{}') as { query?: string };
  if (/__schema/.test(query ?? '')) return introspection ? json(res, 200, { data: { __schema: SCHEMA } }) : json(res, 400, { errors: [{ message: 'GraphQL introspection is not allowed' }] });
  const known: Record<string, string[]> = { Query: ['order', 'orders'], Mutation: ['createOrder'], Order: ['id', 'status', 'total'] };
  const errors: Array<{ message: string }> = [];
  const isMutation = /^\s*mutation/.test(query ?? '');
  // Pre-prod has dropped "total".
  for (const m of (query ?? '').matchAll(/(\w+)x\b/g)) {
    const type = (query ?? '').includes('{ order') || (query ?? '').includes('{ orders') ? 'Order' : isMutation ? 'Mutation' : 'Query';
    const near = known[type]!.filter((k) => m[1]!.startsWith(k.slice(0, 4)) || k.startsWith(m[1]!.slice(0, 4)));
    errors.push({ message: `Cannot query field "${m[1]}x" on type "${type}".${near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : ''}` });
  }
  if (/\btotal\b/.test(query ?? '') && !introspection) errors.push({ message: 'Cannot query field "total" on type "Order".' });
  if (errors.length) return json(res, 400, { errors });
  return json(res, 200, { data: { orders: [{ id: '1', status: 'OPEN' }] } });
}

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const user = req.headers.authorization === 'Bearer alice' ? 'alice' : req.headers.authorization === 'Bearer bob' ? 'bob' : null;
    if (url.pathname === '/beta/graphql') return graphql(body, true, res);
    if (url.pathname === '/graphql') return graphql(body, false, res);
    if (url.pathname.startsWith('/api/orders/') && req.method === 'GET') {
      if (!user) return json(res, 401, { error: 'login' });
      // Broken access control: any user can read any order.
      return json(res, 200, { id: Number(url.pathname.split('/')[3]), owner: 'alice', status: 'OPEN', total: 12.5, extra: true });
    }
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      try {
        const b = JSON.parse(body) as { sku?: unknown; qty?: unknown };
        if (b.sku === undefined) return json(res, 400, { error: 'sku is required' });
        if (typeof b.qty === 'string') throw new Error('qty.toFixed is not a function');
        return json(res, 201, { id: 9, status: 'OPEN' });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message, stack: 'at OrderService.create (orders.js:42)' });
      }
    }
    if (url.pathname === '/api/orders' && req.method === 'GET') return json(res, 200, [{ id: 1, status: 'OPEN' }]);
    if (url.pathname.startsWith('/api/orders/') && req.method === 'DELETE') return json(res, 204, {});
    json(res, 404, { error: 'nope' });
  });
};

const send = (method: string, path: string, body?: unknown, auth?: string) =>
  core.tools.sender.send({
    method,
    url: `${base}${path}`,
    headers: [...(body !== undefined ? ([['Content-Type', 'application/json']] as Array<[string, string]>) : []), ...(auth ? ([['Authorization', `Bearer ${auth}`]] as Array<[string, string]>) : [])],
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
  });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-extras-'));
  target = createServer(handler);
  const port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
});

afterAll(async () => {
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const SPEC = (port: string) => `openapi: 3.0.3
info: { title: Orders, version: "1" }
servers: [ { url: "http://127.0.0.1:${port}" } ]
paths:
  /api/orders:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [sku]
              properties:
                sku: { type: string }
                qty: { type: integer, minimum: 1 }
      responses:
        '201':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
  /api/orders/{id}:
    get:
      parameters: [ { name: id, in: path, required: true, schema: { type: integer } } ]
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '401': { description: login }
components:
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id: { type: integer }
        status: { type: string, enum: [OPEN, PAID] }
        total: { type: string }
`;

describe('contract checks', () => {
  let order: ExchangeSummary;
  it('flags wrong types, undocumented fields and statuses against the spec', async () => {
    core.tools.importSpec(SPEC(new URL(base).port));
    order = await send('GET', '/api/orders/5', undefined, 'alice');
    const r = core.tools.contractCheck(order.id)!;
    expect(r.endpoint).toBe('GET /api/orders/{id}');
    const kinds = r.issues.map((i) => `${i.kind} ${i.path}`);
    expect(kinds).toEqual(expect.arrayContaining(['type $.total', 'undocumented-field $.extra', 'undocumented-field $.owner']));
    expect(r.issues.find((i) => i.path === '$.extra')!.severity).toBe('warning');
    const created = await send('POST', '/api/orders', { sku: 'A', qty: 0 });
    const c = core.tools.contractCheck(created.id)!;
    expect(c.issues.map((i) => `${i.side} ${i.kind} ${i.path}`)).toEqual(['request range $.qty']);
    const scan = core.tools.contractScan('127.0.0.1');
    expect(scan.checked).toBeGreaterThan(1);
    expect(scan.endpoints[0]!.endpoint).toBe('GET /api/orders/{id}');
  });

  it('validates enums, required fields, oneOf and nullable', () => {
    const s = { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['x'] }, b: { oneOf: [{ type: 'integer' }, { type: 'string', format: 'uuid' }] }, c: { type: 'string', nullable: true } } };
    expect(validate(s, { a: 'x', b: 5, c: null })).toEqual([]);
    expect(validate(s, { a: 'y', b: 'nope' }).map((i) => i.kind)).toEqual(['enum', 'format']);
    expect(validate(s, {}).map((i) => i.message)).toEqual(['required field "a" is missing']);
  });
});

describe('auth matrix and negative tests', () => {
  it('replays as other identities and flags the same successful answer', async () => {
    const orig = await send('GET', '/api/orders/5', undefined, 'alice');
    core.tools.setIdentities([
      { name: 'bob', headers: [['Authorization', 'Bearer bob']] },
      { name: 'no auth', headers: [], anonymous: true },
    ]);
    const m = await core.tools.authMatrix([orig.id]);
    const row = m.rows[0]!;
    expect(row.endpoint).toBe('/api/orders/{n}');
    expect(row.cells.map((c) => `${c.identity}:${c.verdict}`)).toEqual(['bob:same', 'no auth:denied']);
    expect(row.flagged).toBe(true);
    expect(core.store.getSummary(row.cells[0]!.exchangeId!)!.tags).toContain('as:bob');
  });

  it('breaks each field in turn and reports what the server did', async () => {
    const orig = await send('POST', '/api/orders', { sku: 'A', qty: 2 });
    const r = await core.tools.negativeTests(orig.id);
    const by = (target: string, name: string) => r.results.find((x) => x.target === target && x.name === name)!;
    expect(by('$.sku', 'missing').verdict).toBe('rejected');
    expect(by('$.qty', 'text instead of number').verdict).toBe('server-error');
    expect(by('$.qty', 'text instead of number').excerpt).toContain('OrderService');
    expect(by('$.qty', 'negative').verdict).toBe('accepted');
    expect(r.results.some((x) => x.name === 'broken JSON')).toBe(true);
    const muts = jsonMutations({ status: 'OPEN' }, { type: 'object', properties: { status: { type: 'string', enum: ['OPEN'] } } });
    expect(muts.map((x) => x.name)).toContain('not one of the allowed values');
  });
});

describe('insight', () => {
  it('diffs two exchanges with JSON paths', async () => {
    const a = await send('GET', '/api/orders/5?x=1', undefined, 'alice');
    const b = await send('GET', '/api/orders/6?x=2', undefined, 'bob');
    const d = core.tools.diff(a.id, b.id);
    expect(d.urlChanged).toBe(true);
    expect(d.query).toEqual([{ name: 'x', before: '1', after: '2' }]);
    expect(d.request.headers.find((h) => h.name === 'authorization')).toEqual({ name: 'authorization', before: 'Bearer alice', after: 'Bearer bob' });
    expect(d.response.json).toEqual([{ path: '$.id', kind: 'changed', before: 5, after: 6 }]);
    expect(jsonDiff({ a: [1], b: 1 }, { a: [1, 2], c: 1 }).map((c) => `${c.kind} ${c.path}`)).toEqual(['added $.a[1]', 'removed $.b', 'added $.c']);
  });

  it('maps create, read, update and delete per resource', async () => {
    await send('GET', '/api/orders');
    await send('DELETE', '/api/orders/5');
    const res = core.tools.lifecycle('127.0.0.1');
    const orders = res.find((r) => r.collection === '/api/orders')!;
    expect(orders.item).toBe('/api/orders/{n}');
    expect(orders.cells.map((c) => c.op)).toEqual(['list', 'create', 'read', 'delete']);
    expect(orders.missing).toEqual(['replace', 'update']);
    expect(orders.cells.find((c) => c.op === 'read')!.documented).toBe(true);
  });

  it('builds a glossary of fields with enums, ranges and nullability', () => {
    const g = core.tools.glossary('127.0.0.1');
    const status = g.find((x) => x.name === 'status')!;
    expect(status.types).toEqual(['string']);
    expect(status.values).toEqual(['OPEN']);
    const id = g.find((x) => x.name === 'id')!;
    expect(id.min).toBeLessThan(id.max!);
    expect(id.seenIn.some((s) => s.startsWith('GET /api/orders/{n}'))).toBe(true);
  });

  it('keeps notes on endpoints and finds them for an exchange', async () => {
    const ex = await send('GET', '/api/orders/7', undefined, 'alice');
    core.tools.setEndpointNote('127.0.0.1 GET /api/orders/{n}', 'Any logged-in user can read any order. Reported as BUG-12.', ['idor']);
    expect(core.tools.noteFor(ex.id)).toEqual(expect.objectContaining({ notes: expect.stringContaining('BUG-12'), tags: ['idor'] }));
  });
});

describe('GraphQL', () => {
  it('pulls the schema from a beta server and applies it to pre-prod', async () => {
    const spec = await core.tools.graphqlImport({ targetUrl: `${base}/graphql`, schemaUrl: `${base}/beta/graphql`, headers: [['Authorization', 'Bearer alice']] });
    expect(spec.format).toBe('graphql');
    expect(spec.endpoints.map((e) => e.key)).toEqual(['QUERY order', 'QUERY orders', 'MUTATION createOrder']);
    const create = spec.endpoints.find((e) => e.key === 'MUTATION createOrder')!;
    const body = JSON.parse(create.draft!.body!) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('mutation CreateOrder($input: OrderInput!)');
    expect(body.query).toContain('status');
    expect(body.variables).toEqual({ input: { sku: 'string', qty: 1 } });
    expect(create.draft!.url).toBe(`${base}/graphql`);
    expect(create.draft!.headers).toEqual(expect.arrayContaining([['Authorization', 'Bearer alice']]));
    // Pre-prod refuses a field the beta schema has: that is drift.
    const orders = spec.endpoints.find((e) => e.key === 'QUERY orders')!;
    await core.tools.sender.send({ method: 'POST', url: orders.draft!.url, headers: orders.draft!.headers, body: new TextEncoder().encode(orders.draft!.body!) });
    expect(core.tools.graphqlDrift(`${base}/graphql`)).toEqual([expect.objectContaining({ field: 'total', type: 'Order' })]);
  });

  it('rebuilds root fields from "Did you mean" suggestions when introspection is off', async () => {
    await expect(core.tools.graphqlImport({ targetUrl: `${base}/graphql` })).rejects.toThrow('introspection');
    const spec = await core.tools.graphqlImport({ targetUrl: `${base}/graphql`, method: 'suggestions' });
    const keys = spec.endpoints.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['QUERY order', 'QUERY orders', 'MUTATION createOrder']));
    expect(suggestionsIn('Cannot query field "ordr" on type "Query". Did you mean "order" or "orders"?')).toEqual(['order', 'orders']);
  });

  it('harvests operations the app sent, including persisted query hashes', async () => {
    await core.tools.sender.send({ method: 'POST', url: `${base}/graphql`, headers: [['Content-Type', 'application/json']], body: new TextEncoder().encode(JSON.stringify({ query: 'query Mine($id: ID!) { order(id: $id) { id status } me: orders { id } }', variables: { id: '1' } })) });
    await core.tools.sender.send({ method: 'POST', url: `${base}/graphql`, headers: [['Content-Type', 'application/json']], body: new TextEncoder().encode(JSON.stringify({ operationName: 'Cart', extensions: { persistedQuery: { version: 1, sha256Hash: 'abc123' } } })) });
    const ops = core.tools.graphqlOperations('127.0.0.1');
    expect(ops.find((o) => o.name === 'Mine')!.rootFields).toEqual(['order', 'orders']);
    expect(ops.find((o) => o.hash === 'abc123')!.name).toBe('Cart');
    expect(parseOperations('mutation { a(x: 1) { b } c }')[0]).toEqual({ kind: 'mutation', name: null, rootFields: ['a', 'c'] });
  });
});

describe('exports', () => {
  it('writes curl, HAR, Postman and a test suite for a flow', async () => {
    const ex = await send('POST', '/api/orders', { sku: "it's" }, 'alice');
    const curl = core.tools.curl(ex.id);
    expect(curl).toContain(`-X POST`);
    expect(curl).toContain(`--data-raw '{"sku":"it'\\''s"}'`);
    expect(toCurl({ method: 'GET', url: 'https://x.test/', headers: [['Host', 'x'], ['Accept', '*/*']] })).toBe("curl 'https://x.test/' \\\n  -H 'Accept: */*' \\\n  --compressed");
    const har = core.tools.exportHar([ex.id]) as { log: { entries: Array<{ request: { postData: { text: string } }; response: { status: number } }> } };
    expect(har.log.entries[0]!.request.postData.text).toBe(`{"sku":"it's"}`);
    expect(har.log.entries[0]!.response.status).toBe(201);
    // round trip: the HAR imports back
    expect(core.tools.importHar(JSON.stringify(har)).imported).toBe(1);
    core.tools.saveFlow({ name: 'new-order', steps: [{ kind: 'request', method: 'POST', url: `${base}/api/orders`, headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer {{var:token}}']], body: '{"sku":"A","key":"{{uuid}}"}', expect: '201', extract: [{ name: 'order_id', from: '$.id' }] }] as never });
    const pm = core.tools.exportPostman({ flow: 'new-order' }) as { item: Array<{ request: { header: Array<{ value: string }>; body: { raw: string } }; event: Array<{ script: { exec: string[] } }> }> };
    expect(pm.item[0]!.request.header[1]!.value).toBe('Bearer {{token}}');
    expect(pm.item[0]!.request.body.raw).toBe('{"sku":"A","key":"{{$guid}}"}');
    expect(pm.item[0]!.event[0]!.script.exec.join('\n')).toContain("pm.collectionVariables.set('order_id', String(pm.response.json().id))");
    const code = flowToTest(core.tools.flowList().find((f) => f.name === 'new-order')!);
    expect(code).toContain("expect(String(r.steps[0]?.status)).toMatch(\"^(201)$\")");
    const script = core.tools.flowToTest('new-order');
    expect(script.kind).toBe('test');
    core.tools.vars.set('token', 'alice');
    const run = await core.tools.runScript(script);
    // The server hands out the same id every time, so the freshness test catches it.
    expect(run.tests.map((t) => `${t.name}:${t.ok}`)).toEqual(['new-order runs end to end:true', 'new-order gives fresh values each run:false']);
  });
});
