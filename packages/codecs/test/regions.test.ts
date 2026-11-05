import { describe, expect, it } from '@siteinquisition/devkit/test';
import { adjustRegions, applyEncodeBlocks, encodeRegions, fieldRegions, planRegion, regionPath, spliceRegion, type TextRegion } from '@siteinquisition/codecs';

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const decodeAt = (text: string, regions: TextRegion[], start: number, end = start, chain?: string[]) => {
  const p = planRegion(text, start, end, { chain });
  return { ...spliceRegion(text, regions, p.start, p.end, p.display, p.region), plan: p };
};

describe('decoded regions', () => {
  const blob = b64({ secret: 'inner-value', level: 3 });
  const doc = JSON.stringify({ id: 7, blob, note: '{"a":1}' }, null, 2);

  it('decodes a JSON string value in place and replaces the whole string, lined up with its line', () => {
    const at = doc.indexOf(blob);
    const d = decodeAt(doc, [], at, at + blob.length);
    expect(d.plan.region).toMatchObject({ chain: ['base64', 'json'], wrap: 'jsonstr', kind: 'json', original: JSON.stringify(blob) });
    expect(d.text).toContain('"blob": {\n    "secret": "inner-value",\n    "level": 3\n  },');
    expect(JSON.parse(d.text)).toEqual({ id: 7, blob: { secret: 'inner-value', level: 3 }, note: '{"a":1}' });
    expect(d.regions).toHaveLength(1);
    expect(d.text.slice(d.regions[0]!.start, d.regions[0]!.end)).toBe(d.plan.display);
  });

  it('takes the value under the caret when nothing is selected', () => {
    const h = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuaWNrIn0.sig\nCookie: s=eyJ1c2VyIjoibmljayJ9; b=1';
    expect(planRegion(h, 30, 30).region.chain).toEqual(['jwt']);
    const c = planRegion(h, h.indexOf('eyJ1') + 3, h.indexOf('eyJ1') + 3);
    expect(c.region).toMatchObject({ chain: ['base64', 'json'], wrap: 'none', original: 'eyJ1c2VyIjoibmljayJ9' });
    // Surrounding space and a trailing ";" are not part of the value.
    const s = h.indexOf('eyJ1') - 1;
    expect(planRegion(h, s + 1, h.indexOf('; b') + 1).region.original).toBe('eyJ1c2VyIjoibmljayJ9');
  });

  it('says why when nothing decodes, or when there is nothing to do', () => {
    expect(() => planRegion('hello world', 0, 5)).toThrow(/Nothing here looks encoded/);
    expect(() => planRegion('{"a":1}', 0, 7)).toThrow(/already plain JSON/);
    expect(() => planRegion(Buffer.from([0, 1, 2, 3, 4, 5, 200, 7, 9]).toString('base64'), 0, 12, { chain: ['base64'] })).toThrow(/binary/);
  });

  it('encodes untouched regions back byte for byte, nested ones included', () => {
    const one = decodeAt(doc, [], doc.indexOf(blob), doc.indexOf(blob) + blob.length);
    const n = one.text.indexOf('{\\"a');
    const two = decodeAt(one.text, one.regions, n + 2);
    expect(two.regions).toHaveLength(2);
    expect(encodeRegions(two.text, two.regions).text).toBe(doc);
  });

  it('re-encodes an edited region, and a region decoded inside it first', () => {
    const inner = b64({ token: b64('abc-token-value') });
    const text = JSON.stringify({ payload: inner }, null, 2);
    const one = decodeAt(text, [], text.indexOf(inner) + 1);
    const tok = one.text.indexOf(b64('abc-token-value'));
    const two = decodeAt(one.text, one.regions, tok + 1);
    expect(two.text).toContain('"token": "abc-token-value"');
    const edited = two.text.replace('"abc-token-value"', '"xyz"');
    const out = encodeRegions(edited, adjustRegions(two.regions, two.text, edited)).text;
    const payload = JSON.parse(Buffer.from((JSON.parse(out) as { payload: string }).payload, 'base64').toString()) as { token: string };
    expect(Buffer.from(payload.token, 'base64').toString()).toBe('xyz');
  });

  it('keeps regions in place as text around them is edited, and drops one deleted whole', () => {
    const one = decodeAt(doc, [], doc.indexOf(blob) + 2);
    const r = one.regions[0]!;
    const before = `// note\n${one.text}`;
    const moved = adjustRegions(one.regions, one.text, before);
    expect(before.slice(moved[0]!.start, moved[0]!.end)).toBe(one.text.slice(r.start, r.end));
    // Typing over exactly the decoded value keeps it a region (the new value is encoded); deleting the field drops it.
    const over = one.text.slice(0, r.start) + '{"secret":"new"}' + one.text.slice(r.end);
    expect(adjustRegions(one.regions, one.text, over)).toHaveLength(1);
    const gone = one.text.slice(0, r.start - 8) + '"x"' + one.text.slice(r.end);
    expect(adjustRegions(one.regions, one.text, gone)).toEqual([]);
  });

  it('leaves regions holding tokens to the sender, which encodes them after the tokens are filled in', () => {
    const one = decodeAt(doc, [], doc.indexOf(blob) + 2);
    const edited = one.text.replace('inner-value', '{{var:x}}');
    const out = encodeRegions(edited, adjustRegions(one.regions, one.text, edited), { blocks: true });
    expect(out.blocks).toBe(1);
    expect(out.text).toContain('{{encode:jsonstr:json:base64>json}}');
    const sent = JSON.parse(applyEncodeBlocks(out.text.replace('{{var:x}}', 'filled'))) as { blob: string };
    expect(JSON.parse(Buffer.from(sent.blob, 'base64').toString())).toEqual({ secret: 'filled', level: 3 });
  });

  it('gives the JSONPath of a region, through regions decoded around it', () => {
    const inner = b64({ token: b64('abc-token-value') });
    const text = JSON.stringify({ items: [{ payload: inner }] }, null, 2);
    const one = decodeAt(text, [], text.indexOf(inner) + 1);
    expect(regionPath(one.text, one.regions[0]!.start, one.regions[0]!.end)).toBe('$.items[0].payload');
    const two = decodeAt(one.text, one.regions, one.text.indexOf(b64('abc-token-value')) + 1);
    const child = two.regions.find((r) => r.chain.join() === 'base64')!;
    expect(regionPath(two.text, child.start, child.end)).toBe('$.items[0].payload.token');
  });

  it('shows saved field codecs as regions, nested specs included', () => {
    const inner = b64({ token: b64('abc-token-value') });
    const f = fieldRegions(JSON.stringify({ id: 1, payload: inner }), [
      { path: '$.payload', chain: ['base64', 'json'], id: 'R1' },
      { path: '$.payload.token', chain: ['base64'], id: 'R2' },
    ])!;
    expect(JSON.parse(f.text)).toEqual({ id: 1, payload: { token: 'abc-token-value' } });
    expect(f.regions.map((r) => [r.rule, f.text.slice(r.start, r.end)])).toEqual([
      ['R1', '{\n    "token": "abc-token-value"\n  }'],
      ['R2', '"abc-token-value"'],
    ]);
    expect(encodeRegions(f.text, f.regions).text).toBe(JSON.stringify({ id: 1, payload: inner }, null, 2));
    expect(fieldRegions('not json', [{ path: '$.a', chain: ['base64'] }])).toBeNull();
  });
});
