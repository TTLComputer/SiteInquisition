import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';

const decodeTime = (id: string) => [...id.slice(0, 10)].reduce((t, c) => t * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c), 0);

describe('newId', () => {
  it('makes 26-character Crockford base32 ULIDs carrying the current time', () => {
    const before = Date.now();
    const id = newId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(decodeTime(id)).toBeGreaterThanOrEqual(before);
    expect(decodeTime(id)).toBeLessThanOrEqual(Date.now());
  });

  it('is strictly increasing, also within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
