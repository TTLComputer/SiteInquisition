import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, inferSchema, parseSpec, resolveTokens, splitPipes, type ExchangeSummary } from '@siteinquisition/core';

// A small shop: log in, list products, make a cart, add an item, create a PO.
let tmp: string;
let core: Core;
let target: Server;
let base: string;
let poCounter = 1000;
const seenBodies: string[] = [];

const json = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(v));
};

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    seenBodies.push(body);
    const authed = req.headers.authorization === 'Bearer tok-1';
    if (url.pathname === '/api/login') return json(res, 200, { access_token: 'tok-1', user: { id: 7701 } }, { 'set-cookie': 'sid=s1; Path=/' });
    if (url.pathname === '/api/products') return json(res, 200, { items: [{ sku: 'AB-100', price: 5 }, { sku: 'AB-200', price: 7 }], total: 2 });
    if (url.pathname === '/api/cart' && req.method === 'POST') return json(res, 201, { cart: { id: 'c-8812' } }, { location: '/api/cart/c-8812' });
    if (/^\/api\/cart\/[\w-]+\/items$/.test(url.pathname)) return json(res, 200, { ok: true, cart: url.pathname.split('/')[3], got: JSON.parse(body || '{}') });
    if (url.pathname === '/api/po' && req.method === 'POST') {
      if (!authed) return json(res, 401, { error: 'login' });
      return json(res, 201, { po: { number: String(++poCounter), status: 'open' } });
    }
    if (url.pathname.startsWith('/api/po/')) return json(res, 200, { number: url.pathname.split('/')[3], status: 'open' });
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(body);
    }
    json(res, 404, { error: 'nope' });
  });
};

const send = (method: string, path: string, body?: unknown, headers: Array<[string, string]> = []) =>
  core.tools.sender.send({
    method,
    url: `${base}${path}`,
    headers: body !== undefined ? [['Content-Type', 'application/json'], ...headers] : headers,
    body: body === undefined ? undefined : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  });

const resBody = (id: string) => Buffer.from(core.store.getBody(id, 'response', true) ?? new Uint8Array()).toString();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-api-'));
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

describe('values from other requests', () => {
  let cart: ExchangeSummary;
  it('catalogs fields per endpoint, ids first', async () => {
    await send('POST', '/api/login', { user: 'ada' });
    await send('GET', '/api/products');
    cart = await send('POST', '/api/cart', {});
    const fields = core.tools.values({ host: '127.0.0.1' });
    const sku = fields.find((f) => f.path === '$.items[*].sku')!;
    expect(sku.template).toBe('/api/products');
    expect(sku.samples).toEqual(['AB-100', 'AB-200']);
    expect(sku.idLike).toBe(true);
    expect(fields.findIndex((f) => f.path === '$.items[*].sku')).toBeLessThan(fields.findIndex((f) => f.path === '$.items[*].price'));
  });

  it('picks a recorded value with {{pick}} and sends once per value with {{each}}', async () => {
    const r = await send('POST', '/api/echo', '{"sku":"{{pick:GET /api/products $.items[*].sku}}","last":"{{pick:/api/products $.items[*].sku:last}}"}');
    expect(resBody(r.id)).toBe('{"sku":"AB-100","last":"AB-200"}');
    const b = await core.tools.sender.sendBatch({ method: 'POST', url: `${base}/api/echo`, headers: [], body: new TextEncoder().encode('{{each:/api/products $.items[*].sku}}') });
    expect(b.sends.map((s) => resBody(s.id)).sort()).toEqual(['AB-100', 'AB-200']);
  });

  it('traces a value back to the response that handed it out', async () => {
    const add = await send('POST', '/api/cart/c-8812/items', { sku: 'AB-200' });
    const origin = core.tools.valueOrigin('c-8812', add.id);
    expect(origin[0]!.exchangeId).toBe(cart.id);
    expect(origin[0]!.at).toBe('$.cart.id');
    const skuFrom = core.tools.valueOrigin('AB-200', add.id);
    expect(skuFrom[0]!.url).toContain('/api/products');
  });
});

describe('tag references', () => {
  it('reads fields of the newest tagged request, and follows the tag when it moves', async () => {
    const a = await send('POST', '/api/cart', {});
    const b = await send('GET', '/api/po/5001');
    core.tools.moveTag('my-tag', a.id);
    const ctx = core.tools.sender.tokenContext(base);
    expect(resolveTokens('{{$my-tag.id}}', ctx)).toBe('c-8812');
    expect(resolveTokens('{{$my-tag.$.cart.id}} {{tag:my-tag.@status}} {{$my-tag.header.location}}', ctx)).toBe('c-8812 201 /api/cart/c-8812');
    core.tools.moveTag('my-tag', b.id);
    expect(core.store.getSummary(a.id)!.tags).not.toContain('my-tag');
    expect(resolveTokens('{{$my-tag.number}}', ctx)).toBe('5001');
    expect(() => resolveTokens('{{$my-tag.nothing}}', ctx)).toThrow('no "nothing"');
    expect(() => resolveTokens('{{$ghost.id}}', ctx)).toThrow('no request is tagged "ghost"');
  });

  it('applies pipes to any token', () => {
    const ctx = core.tools.sender.tokenContext(base, { vars: { po: '1001' } });
    expect(resolveTokens('{{var:po | base64}} {{var:po|json}} {{$my-tag.number | url | upper}}', ctx)).toBe('MTAwMQ== "1001" 5001');
    // a | that is not a filter stays part of the argument
    expect(splitPipes('a,b|c').arg).toBe('a,b|c');
  });
});

describe('flows', () => {
  it('creates a fresh PO for every send that uses {{flow:...}}', async () => {
    core.tools.saveFlow({
      name: 'create-po',
      steps: [
        { kind: 'request', method: 'POST', url: `${base}/api/login`, headers: [['Content-Type', 'application/json']], body: '{"user":"ada"}', extract: [{ name: 'token', from: '$.access_token' }] },
        { kind: 'request', method: 'POST', url: `${base}/api/po`, headers: [['Authorization', 'Bearer {{var:token}}']], extract: [{ name: 'po', from: 'number' }], expect: '201', tag: 'latest-po' },
        { kind: 'script', code: "vars.poRef = 'PO-' + vars.po.padStart(8, '0')" },
      ] as never,
    });
    const one = await send('POST', '/api/echo', '{{flow:create-po.poRef}}');
    const two = await send('POST', '/api/echo', '{{flow:create-po.poRef}}/{{flow:create-po.po}}');
    expect(resBody(one.id)).toMatch(/^PO-0000\d{4}$/);
    const [ref2, po2] = resBody(two.id).split('/');
    expect(ref2).toBe(`PO-0000${po2}`);
    expect(resBody(one.id)).not.toBe(ref2);
    expect(core.store.getSummary(two.id)!.tags).toContain('used-flow:create-po');
    // The PO step's tag moved to the newest run.
    expect(resolveTokens('{{$latest-po.number}}', core.tools.sender.tokenContext(base))).toBe(po2!);
  });

  it('reports which step failed', async () => {
    core.tools.saveFlow({ name: 'bad-po', steps: [{ kind: 'request', method: 'POST', url: `${base}/api/po`, headers: [], expect: '2xx', extract: [{ name: 'po', from: 'number' }] }] as never });
    const r = await core.tools.runFlow('bad-po');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('status 401, expected 2xx');
    await expect(send('POST', '/api/echo', '{{flow:bad-po.po}}')).rejects.toThrow('flow "bad-po" failed');
  });

  it('runs a login flow when a send is refused, then sends again', async () => {
    core.tools.saveFlow({ name: 'login', onAuthFail: { host: '127.0.0.1' }, saveVars: true, steps: [{ kind: 'request', method: 'POST', url: `${base}/api/login`, headers: [], extract: [{ name: 'token', from: 'access_token' }] }] as never });
    core.tools.vars.set('token', 'stale');
    const r = await core.tools.sender.send({ method: 'POST', url: `${base}/api/po`, headers: [['Authorization', 'Bearer {{var:token}}']] }, { loginMacro: true });
    expect(r.status).toBe(201);
    expect(r.tags).toContain('after-login:login');
  });

  it('encodes a decoded body with a codec chain after tokens are resolved', async () => {
    const r = await core.tools.sender.send({ method: 'POST', url: `${base}/api/echo`, headers: [], body: new TextEncoder().encode('{"order":{"po":"{{$latest-po.number}}"}}') }, { bodyChain: ['base64', 'json'] });
    const decoded = JSON.parse(Buffer.from(resBody(r.id), 'base64').toString()) as { order: { po: string } };
    expect(decoded.order.po).toMatch(/^\d{4}$/);
  });

  it('makes a flow from recorded requests, wiring values from earlier responses', async () => {
    const login = await send('POST', '/api/login', { user: 'ada' });
    const products = await send('GET', '/api/products');
    const cart = await send('POST', '/api/cart', { owner: 7701, key: '3f2c1d9e-1111-4222-8333-444455556666' });
    const add = await send('POST', '/api/cart/c-8812/items', { sku: 'AB-100', qty: 1 }, [['Authorization', 'Bearer tok-1']]);
    const draft = core.tools.draftFlow([add.id, products.id, login.id, cart.id], 'add-to-cart');
    const [s0, s1, s2, s3] = draft.flow.steps;
    expect(s0!.url).toContain('/api/login');
    expect(s3!.url).toBe(`${base}/api/cart/{{var:cart_id}}/items`);
    expect(s2!.extract).toEqual(expect.arrayContaining([{ name: 'cart_id', from: '$.cart.id' }]));
    expect(s3!.headers).toEqual(expect.arrayContaining([['Authorization', 'Bearer {{var:access_token}}']]));
    expect(s3!.body).toContain('{{var:sku}}');
    expect(s1!.extract!.map((e) => e.from)).toContain('$.items[0].sku');
    // the user id from login fed the cart owner; the client-made key became {{uuid}}
    expect(s2!.body).toContain('{{var:user_id}}');
    expect(s2!.body).toContain('{{uuid}}');
    expect(draft.generated.length).toBe(1);
    // and the draft runs as a flow
    const saved = core.tools.saveFlow(draft.flow);
    const run = await core.tools.runFlow(saved.name);
    expect(run.ok).toBe(true);
    expect(run.vars.cart_id).toBe('c-8812');
  });

  it('gives scripts flows, values and tags', async () => {
    const r = await core.tools.runScript({
      id: 's',
      name: 's',
      kind: 'script',
      code: "const { po } = await siq.flows.run('create-po'); const skus = siq.pick('/api/products $.items[*].sku'); return [po.length, skus.length, siq.tagged('latest-po.number') === po]",
    });
    expect(r.error).toBeUndefined();
    expect(r.value).toContain('4');
    expect(JSON.parse(r.value!)).toEqual([4, 2, true]);
  });
});

const OPENAPI = `openapi: 3.0.3
info:
  title: Shop
  version: "1"
servers:
  - url: http://127.0.0.1:{port}/api
    variables:
      port:
        default: "1"
paths:
  /products:
    get:
      summary: List products
      responses:
        '200': { description: ok }
  /cart:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Cart' }
      responses:
        '201': { description: created }
  /cart/{cartId}/items:
    post:
      parameters:
        - { name: cartId, in: path, required: true, schema: { type: string } }
      security: [ { bearer: [] } ]
      responses:
        '200': { description: ok }
  /refunds:
    post:
      responses:
        '200': { description: ok }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  schemas:
    Cart:
      type: object
      properties:
        owner: { type: integer, example: 77 }
        note: { type: string }
`;

describe('API descriptions', () => {
  it('imports OpenAPI YAML and compares it with traffic', () => {
    const spec = core.tools.importSpec(OPENAPI);
    expect(spec.format).toBe('openapi3');
    expect(spec.basePath).toBe('/api');
    expect(spec.endpoints.map((e) => e.key)).toEqual(['GET /products', 'POST /cart', 'POST /cart/{cartId}/items', 'POST /refunds']);
    expect(spec.endpoints[1]!.requestBody!.example).toContain('"owner": 77');
    const cov = core.tools.specCoverage('127.0.0.1');
    const row = (k: string) => cov.documented.find((d) => d.endpoint.key === k)!;
    expect(row('GET /products').count).toBeGreaterThan(0);
    expect(row('POST /cart/{cartId}/items').count).toBeGreaterThan(0);
    expect(row('POST /refunds').count).toBe(0);
    expect(cov.undocumented).toEqual(expect.arrayContaining(['POST /api/login', 'POST /api/po']));
  });

  it('builds a request for an endpoint with path values from recorded traffic', () => {
    const spec = core.tools.specs()[0]!;
    const r = core.tools.specRequest(spec.id, 'POST /cart/{cartId}/items', { baseUrl: `${base}/api` });
    expect(r.url).toBe(`${base}/api/cart/c-8812/items`);
    expect(r.headers).toEqual(expect.arrayContaining([['Authorization', 'Bearer {{var:token}}']]));
  });

  it('reads Swagger 2 JSON and Postman collections', () => {
    const sw = parseSpec(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'Pets', version: '1' },
        host: 'pets.test',
        basePath: '/v1',
        paths: { '/pets/{id}': { get: { parameters: [{ name: 'id', in: 'path', type: 'integer' }], responses: { 200: { description: 'ok' } } } }, '/pets': { post: { parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Pet' } }], responses: {} } } },
        definitions: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'rex' }, tags: { type: 'array', items: { type: 'string' } } } } },
      }),
    );
    expect(sw.format).toBe('swagger2');
    expect(sw.hosts).toEqual(['pets.test']);
    expect(sw.endpoints[0]!.params[0]).toEqual(expect.objectContaining({ name: 'id', in: 'path', type: 'integer' }));
    expect(JSON.parse(sw.endpoints[1]!.requestBody!.example)).toEqual({ name: 'rex', tags: ['string'] });
    const pm = parseSpec(
      JSON.stringify({
        info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Orders', item: [{ name: 'Get order', request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/:orderId?x={{$guid}}' }, header: [{ key: 'X-Key', value: '{{apiKey}}' }] } }] }],
      }),
    );
    expect(pm.format).toBe('postman');
    const ep = pm.endpoints[0]!;
    expect(ep.path).toBe('/orders/{orderId}');
    expect(ep.summary).toBe('Orders / Get order');
    expect(ep.draft!.url).toBe('{{var:baseUrl}}/orders/{{var:orderId}}?x={{uuid}}');
    expect(ep.draft!.headers).toEqual([['X-Key', '{{var:apiKey}}']]);
  });

  it('exports an OpenAPI document inferred from traffic', () => {
    const doc = core.tools.exportOpenApi('127.0.0.1') as { openapi: string; paths: Record<string, Record<string, any>> };
    expect(doc.openapi).toBe('3.1.0');
    const items = doc.paths['/api/po/{id}']!.get;
    expect(items.parameters[0]).toEqual({ name: 'id', in: 'path', required: true, schema: { type: 'integer' } });
    const products = doc.paths['/api/products']!.get.responses['200'].content['application/json'].schema;
    expect(products.properties.items.items.properties.sku).toEqual({ type: 'string', example: 'AB-100' });
    expect(inferSchema([{ a: 1 }, { a: null, b: 'x' }])).toEqual({ type: 'object', properties: { a: { type: 'integer', example: 1, nullable: true }, b: { type: 'string', example: 'x' } }, required: ['a'] });
  });

  it('imports a HAR file into History', () => {
    const har = { log: { entries: [{ startedDateTime: '2026-11-04T10:00:00Z', time: 12, request: { method: 'GET', url: 'https://har.test/api/x?y=1', httpVersion: 'HTTP/2', headers: [{ name: ':authority', value: 'har.test' }, { name: 'accept', value: '*/*' }] }, response: { status: 200, statusText: 'OK', headers: [{ name: 'content-encoding', value: 'gzip' }], content: { text: '{"x":1}' } } }] } };
    const r = core.tools.importHar(JSON.stringify(har));
    expect(r.imported).toBe(1);
    const ex = core.store.getExchange(r.ids[0]!)!;
    expect(ex.source).toBe('import');
    expect(ex.requestHeaders).toEqual([['accept', '*/*']]);
    expect(resBody(ex.id)).toBe('{"x":1}');
    expect(() => core.tools.importSpec(JSON.stringify(har))).toThrow('HAR');
  });
});
