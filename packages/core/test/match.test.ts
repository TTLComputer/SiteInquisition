import { describe, expect, it } from '@siteinquisition/devkit/test';
import { Scope, conditionsMatch, describeCondition, graphqlOperations, matchGlob, normalizeBreakpoint, normalizeMock, normalizeReplaceRule, pathMatches, requestSubject, responseSubject, type HookMessage, type RuleConditions } from '@siteinquisition/core';

const enc = (s: string) => new TextEncoder().encode(s);
const req = (url: string, headers: Array<[string, string]> = [], body = '', method = 'POST'): HookMessage => ({ method, url, headers, body: enc(body) });
const json = (url: string, value: unknown, headers: Array<[string, string]> = []) => req(url, [['content-type', 'application/json'], ...headers], JSON.stringify(value));
const ok = (c: RuleConditions, m: HookMessage) => conditionsMatch(c, requestSubject(m));

describe('path matching', () => {
  it('compares exact paths without the query string', () => {
    expect(ok({ path: '/api/users' }, req('http://a.test/api/users?x=1'))).toBe(true);
    expect(ok({ path: '/api/users' }, req('http://a.test/api/users/1'))).toBe(false);
    expect(ok({ path: '/api/users' }, req('http://a.test/api/users/'))).toBe(false);
    // the old prefix still covers everything under it
    expect(ok({ pathPrefix: '/api/users' }, req('http://a.test/api/users/1'))).toBe(true);
  });

  it('globs one segment with * and any depth with **, and fills templates', () => {
    expect(pathMatches('/api/*/items', 'glob', '/api/7/items')).toBe(true);
    expect(pathMatches('/api/*/items', 'glob', '/api/7/8/items')).toBe(false);
    expect(pathMatches('/api/**/items', 'glob', '/api/7/8/items')).toBe(true);
    expect(pathMatches('/users/{id}/orders/{orderId}', 'template', '/users/42/orders/9')).toBe(true);
    expect(pathMatches('/users/{id}', 'template', '/users/42/orders')).toBe(false);
    expect(pathMatches('^/v[0-9]+/', 'regex', '/v2/x')).toBe(true);
    expect(pathMatches('/^\\/V2$/i', 'regex', '/v2')).toBe(true);
  });

  it('accepts a list of methods', () => {
    expect(ok({ method: 'get, head' }, req('http://a.test/', [], '', 'HEAD'))).toBe(true);
    expect(ok({ method: 'GET,HEAD' }, req('http://a.test/', [], '', 'POST'))).toBe(false);
  });

  it('applies to scope rules too', () => {
    const s = new Scope({ defaultAction: 'ignore', rules: [{ action: 'include', host: 'a.test', path: '/api/*/x', pathMatch: 'glob' }] });
    expect(s.evaluate('http://a.test/api/1/x').record).toBe(true);
    expect(s.evaluate('http://a.test/api/1/y').record).toBe(false);
  });
});

describe('query, header and cookie conditions', () => {
  const m = req('http://a.test/s?id=42&tag=a&tag=b&empty=', [
    ['X-Tenant', 'acme-eu'],
    ['Cookie', 'theme=dark; session=abc123'],
    ['cookie', 'late=1'],
  ]);

  it('matches query parameters by value, any repeat, presence and absence', () => {
    expect(ok({ where: [{ in: 'query', name: 'id', value: '42' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'query', name: 'id', value: '4' }] }, m)).toBe(false);
    expect(ok({ where: [{ in: 'query', name: 'tag', value: 'b' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'query', name: 'empty', op: 'exists' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'query', name: 'debug', op: 'absent' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'query', name: 'id', op: 'gte', value: '40' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'query', name: 'tag', value: 'a', not: true }] }, m)).toBe(false);
  });

  it('matches headers ignoring name case, values exactly unless told otherwise', () => {
    expect(ok({ where: [{ in: 'header', name: 'x-tenant', value: 'acme-eu' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'header', name: 'x-tenant', value: 'ACME-EU' }] }, m)).toBe(false);
    expect(ok({ where: [{ in: 'header', name: 'x-tenant', value: 'ACME-EU', ignoreCase: true }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'header', name: 'x-tenant', op: 'regex', value: '^acme-' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'header', name: 'x-tenant', op: 'glob', value: 'acme-*' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'header', name: 'authorization', op: 'absent' }] }, m)).toBe(true);
  });

  it('reads cookies from every Cookie header, and Set-Cookie on responses', () => {
    expect(ok({ where: [{ in: 'cookie', name: 'session', value: 'abc123' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'cookie', name: 'late', value: '1' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'cookie', name: 'sess', op: 'exists' }] }, m)).toBe(false);
    const res: HookMessage = { method: 'POST', url: m.url, status: 200, headers: [['Set-Cookie', 'session=new; Path=/; HttpOnly']], body: enc('') };
    expect(conditionsMatch({ where: [{ in: 'cookie', name: 'session', value: 'new' }] }, responseSubject(m, res))).toBe(true);
    // and the request's cookie when asked for
    expect(conditionsMatch({ where: [{ in: 'cookie', name: 'session', side: 'request', value: 'abc123' }] }, responseSubject(m, res))).toBe(true);
  });
});

describe('JSON and body conditions', () => {
  const m = json('http://a.test/api', { user: { role: 'admin', id: 7, flags: ['x', 'y'] }, items: [{ qty: 1 }, { qty: 5 }] });

  it('compares JSONPath values, with numbers and booleans by their JSON text', () => {
    expect(ok({ where: [{ in: 'json', name: '$.user.role', value: 'admin' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'json', name: '$.user.id', value: '7' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'json', name: '$.items[*].qty', op: 'gt', value: '3' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'json', name: '$.user.flags', op: 'contains', value: '"y"' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'json', name: '$.user.email', op: 'exists' }] }, m)).toBe(false);
    expect(ok({ where: [{ in: 'json', name: '$.user.email', op: 'absent' }] }, m)).toBe(true);
  });

  it('treats a body that is not JSON as having no values', () => {
    expect(ok({ where: [{ in: 'json', name: '$.a', op: 'exists' }] }, req('http://a.test/', [], 'not json'))).toBe(false);
    expect(ok({ where: [{ in: 'json', name: '$.a', op: 'absent' }] }, req('http://a.test/', [], 'not json'))).toBe(true);
  });

  it('matches response JSON on response rules by default', () => {
    const res: HookMessage = { method: 'POST', url: m.url, status: 200, headers: [], body: enc('{"ok":false}') };
    expect(conditionsMatch({ where: [{ in: 'json', name: '$.ok', value: 'false' }] }, responseSubject(m, res))).toBe(true);
    expect(conditionsMatch({ where: [{ in: 'json', name: '$.user.role', side: 'request', value: 'admin' }] }, responseSubject(m, res))).toBe(true);
  });

  it('searches body text', () => {
    expect(ok({ where: [{ in: 'body', op: 'contains', value: '"qty":5' }] }, m)).toBe(true);
  });
});

describe('GraphQL conditions', () => {
  const doc = 'query GetUser($id: ID!) { user(id: $id) { name } }  mutation SaveUser { save { ok } }';

  it('finds the operation that runs in a JSON body', () => {
    const m = json('http://a.test/graphql', { query: doc, operationName: 'SaveUser' });
    expect(graphqlOperations(new URL(m.url), m.headers, m.body)).toEqual([{ name: 'SaveUser', type: 'mutation', fields: ['save'] }]);
    expect(ok({ where: [{ in: 'graphql', value: 'SaveUser' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'graphql', value: 'GetUser' }] }, m)).toBe(false);
    expect(ok({ where: [{ in: 'graphql', name: 'type', value: 'mutation' }] }, m)).toBe(true);
    expect(ok({ where: [{ in: 'graphql', name: 'field', value: 'save' }] }, m)).toBe(true);
  });

  it('reads batches, GET requests, application/graphql bodies and persisted queries', () => {
    const batch = json('http://a.test/graphql', [{ query: 'query A { a }' }, { query: 'query B { b }' }]);
    expect(ok({ where: [{ in: 'graphql', value: 'B' }] }, batch)).toBe(true);
    const get = req(`http://a.test/graphql?query=${encodeURIComponent('query Feed { feed { id } }')}`, [], '', 'GET');
    expect(ok({ where: [{ in: 'graphql', value: 'Feed' }] }, get)).toBe(true);
    const raw = req('http://a.test/graphql', [['content-type', 'application/graphql']], 'mutation Like { like }');
    expect(ok({ where: [{ in: 'graphql', name: 'type', value: 'mutation' }] }, raw)).toBe(true);
    const pq = json('http://a.test/graphql', { operationName: 'Cart', extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } });
    expect(ok({ where: [{ in: 'graphql', value: 'Cart' }] }, pq)).toBe(true);
    expect(ok({ where: [{ in: 'graphql', name: 'hash', value: 'abc' }] }, pq)).toBe(true);
  });

  it('does not match a request that is not GraphQL', () => {
    expect(ok({ where: [{ in: 'graphql', op: 'exists' }] }, json('http://a.test/x', { a: 1 }))).toBe(false);
  });
});

describe('unknown parts and validation', () => {
  it('lets conditions on parts not known yet pass when lenient, and fail otherwise', () => {
    const c: RuleConditions = { where: [{ in: 'json', name: '$.ok', side: 'response', value: 'true' }] };
    const s = { method: 'GET', url: 'http://a.test/', status: 200, phase: 'response' as const };
    expect(conditionsMatch(c, s, { lenient: true })).toBe(true);
    expect(conditionsMatch(c, s)).toBe(false);
  });

  it('rejects mistakes when a rule is saved', () => {
    expect(() => normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', where: [{ in: 'header', value: 'x' }] })).toThrow(/needs a name/);
    expect(() => normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', where: [{ in: 'json', name: 'user.role' }] })).toThrow(/JSONPath/);
    expect(() => normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', where: [{ in: 'query', name: 'a', op: 'regex', value: '(' }] })).toThrow();
    expect(() => normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', where: [{ in: 'query', name: 'a', op: 'gt', value: 'x' }] })).toThrow(/numbers/);
    expect(() => normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', where: [{ in: 'nope' as never }] })).toThrow(/source/);
    expect(() => normalizeMock({ name: 'm', status: 200, headers: [], body: '', path: 'api' })).toThrow(/start with/);
    expect(() => normalizeBreakpoint({ phase: 'request', where: [{ in: 'graphql', name: 'kind' }] })).toThrow(/graphql/);
    const r = normalizeReplaceRule({ name: 'r', phase: 'request', target: 'url', path: '', pathMatch: 'glob', where: [] });
    expect(r.path).toBeUndefined();
    expect(r.where).toBeUndefined();
  });

  it('describes conditions in one line', () => {
    expect(describeCondition({ in: 'header', name: 'x-tenant', op: 'regex', value: '^acme' })).toBe('header x-tenant ~ "^acme"');
    expect(describeCondition({ in: 'graphql', value: 'GetUser', not: true })).toBe('not graphql operation = "GetUser"');
    expect(matchGlob('a*c', 'abbc')).toBe(true);
  });
});
