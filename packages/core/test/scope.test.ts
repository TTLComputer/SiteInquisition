import { describe, expect, it } from 'vitest';
import { Scope } from '@siteinquisition/core';

describe('Scope', () => {
  it('ignores everything by default', () => {
    expect(new Scope().evaluate('https://example.com/')).toEqual({ decrypt: false, record: false, modify: false });
  });

  it('matches host globs, first rule wins', () => {
    const s = new Scope({
      defaultAction: 'ignore',
      rules: [
        { id: 'x', action: 'exclude', host: 'login.example.com' },
        { id: 'a', action: 'include', host: '*.example.com', modify: false },
      ],
    });
    expect(s.evaluate('https://api.example.com/v1')).toMatchObject({ record: true, decrypt: true, modify: false, ruleId: 'a' });
    expect(s.evaluate('https://login.example.com/')).toMatchObject({ record: false, ruleId: 'x' });
    expect(s.evaluate('https://example.org/')).toMatchObject({ record: false });
    expect(s.evaluate('https://API.Example.com/')).toMatchObject({ record: true });
  });

  it('honours port, scheme and path prefix', () => {
    const s = new Scope({
      defaultAction: 'ignore',
      rules: [{ id: 'r', action: 'include', host: 'localhost', port: 3000, scheme: 'http', pathPrefix: '/api/' }],
    });
    expect(s.evaluate('http://localhost:3000/api/users').record).toBe(true);
    expect(s.evaluate('http://localhost:3000/static/x.js').record).toBe(false);
    expect(s.evaluate('http://localhost:4000/api/users').record).toBe(false);
    expect(s.evaluate('https://localhost:3000/api/users').record).toBe(false);
    expect(s.evaluate('ws://localhost:3000/api/socket').record).toBe(true);
  });

  it('records unmatched traffic without decrypting when defaultAction is record', () => {
    expect(new Scope({ defaultAction: 'record', rules: [] }).evaluate('http://a.test/')).toEqual({ decrypt: false, record: true, modify: false });
  });

  it('lists decrypted hosts from enabled include rules only', () => {
    const s = new Scope({
      defaultAction: 'ignore',
      rules: [
        { id: '1', action: 'include', host: '*.b.test' },
        { id: '2', action: 'include', host: 'a.test', decrypt: false },
        { id: '3', action: 'include', host: 'c.test', enabled: false },
        { id: '4', action: 'exclude', host: 'd.test' },
        { id: '5', action: 'include', host: '*.b.test', pathPrefix: '/x' },
      ],
    });
    expect(s.decryptHosts()).toEqual(['*.b.test']);
  });

  it('rejects bad rules', () => {
    expect(() => new Scope({ defaultAction: 'ignore', rules: [{ id: '1', action: 'include', host: 'a b' }] })).toThrow(/invalid host/);
    expect(() => new Scope({ defaultAction: 'ignore', rules: [{ id: '1', action: 'include', host: 'a', port: 70000 }] })).toThrow(/invalid port/);
    expect(() => new Scope({ defaultAction: 'ignore', rules: [{ id: '1', action: 'include', host: 'a', pathPrefix: 'x' }] })).toThrow(/pathPrefix/);
  });
});
