/**
 * Decoded regions: a stretch of text shown decoded in place (a base64 blob in
 * a JSON body, a JWT in a header) that goes back to its encoded form on send.
 * This module only keeps the bookkeeping: where each region sits as the text
 * around it changes. It has no Node imports, so the renderer can use it.
 */

/**
 * How the decoded value sits in the text around it.
 * - none: the region is the encoded value itself.
 * - jsonstr: the region replaced a whole JSON string literal ("eyJ..."); its text is JSON.
 * - jsonesc: the region is part of a JSON string's content, written with JSON escapes.
 */
export type RegionWrap = 'none' | 'jsonstr' | 'jsonesc';

export interface TextRegion {
  id: string;
  /** Offsets in the text as shown, end exclusive. */
  start: number;
  end: number;
  /** Codec ids, outermost first, e.g. ["base64", "json"]. */
  chain: string[];
  wrap: RegionWrap;
  /** json: the region holds a JSON value (the chain ends in json, jwt, form...). text: it holds plain text. */
  kind: 'json' | 'text';
  /** The encoded text the region replaced, exactly, so an untouched region goes back byte for byte. */
  original: string;
  /** What it decoded to (compact JSON for kind json), to tell whether it was edited. */
  decoded: string;
  /** The saved field codec that made it, when one did. */
  rule?: string;
}

let seq = 0;
export const regionId = (): string => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/** "base64 › json"; "JSON escapes › ..." when the value is part of a JSON string written with escapes. */
export const regionLabel = (r: Pick<TextRegion, 'chain' | 'wrap'>): string => [...(r.wrap === 'jsonesc' ? ['JSON escapes'] : []), ...r.chain].join(' › ');

const textLike = (r: TextRegion, text: string) => !/[}\]"]$/.test(text.slice(r.start, r.end));

/**
 * Move regions for one edit: text from a to b (old offsets) was replaced by
 * `inserted` characters. Edits inside a region grow or shrink it; a region
 * the edit swallowed whole is dropped; one it cut into is clipped to what is
 * left. Typing right after a plain-text region extends it, since that reads
 * as adding to the value; after a JSON value it does not.
 */
export function adjustForEdit(regions: TextRegion[], a: number, b: number, inserted: number, text?: string): TextRegion[] {
  const delta = inserted - (b - a);
  const out: TextRegion[] = [];
  for (const r of regions) {
    let { start, end } = r;
    if (b < start || (b === start && a < b) || (a === b && a === start)) {
      start += delta;
      end += delta;
    } else if (a > end || (a === end && (a < b || !text || !textLike(r, text)))) {
      // after the region: unchanged
    } else if (a >= start && b <= end) {
      end += delta;
    } else if (a <= start && b >= end) {
      continue; // swallowed
    } else if (a < start) {
      // cut into the start
      start = a + inserted;
      end += delta;
    } else {
      // cut into the end
      end = a;
    }
    if (end > start) out.push({ ...r, start, end });
  }
  return out;
}

/** Move regions from one version of the text to the next, finding the edit by common prefix and suffix. */
export function adjustRegions(regions: TextRegion[], before: string, after: string): TextRegion[] {
  if (!regions.length || before === after) return regions;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return adjustForEdit(regions, p, before.length - s, after.length - s - p, before);
}

/** Replace start..end with a decoded value and add a region for it. */
export function spliceRegion(text: string, regions: TextRegion[], start: number, end: number, display: string, region: Omit<TextRegion, 'start' | 'end' | 'id'> & { id?: string }): { text: string; regions: TextRegion[] } {
  // Regions inside the replaced text are gone; ones around it grow.
  const moved = adjustForEdit(regions.filter((r) => !(r.start >= start && r.end <= end)), start, end, display.length);
  const next: TextRegion = { ...region, id: region.id ?? regionId(), start, end: start + display.length };
  return { text: text.slice(0, start) + display + text.slice(end), regions: sortRegions([...moved, next]) };
}

/** Outer regions before inner ones, then by position. */
export const sortRegions = (rs: TextRegion[]): TextRegion[] => [...rs].sort((x, y) => x.start - y.start || y.end - x.end);

/** The regions inside r (not r itself). */
export const regionsWithin = (regions: TextRegion[], r: TextRegion): TextRegion[] => regions.filter((x) => x.id !== r.id && x.start >= r.start && x.end <= r.end);

/** The regions that contain r, outermost first. */
export const regionsAround = (regions: TextRegion[], r: TextRegion): TextRegion[] => sortRegions(regions.filter((x) => x.id !== r.id && x.start <= r.start && x.end >= r.end));

/** The innermost region holding an offset (or the whole of start..end). */
export function regionAt(regions: TextRegion[], start: number, end = start): TextRegion | null {
  let best: TextRegion | null = null;
  for (const r of regions) if (r.start <= start && r.end >= end && (!best || r.end - r.start < best.end - best.start)) best = r;
  return best;
}

/** Regions that fall within a slice of the text, with offsets relative to it. */
export const regionsIn = (regions: TextRegion[], from: number, to: number): TextRegion[] =>
  regions.filter((r) => r.start >= from && r.end <= to).map((r) => ({ ...r, start: r.start - from, end: r.end - from }));

/** Shift regions by an offset (the inverse of regionsIn). */
export const shiftRegions = (regions: TextRegion[], by: number): TextRegion[] => regions.map((r) => ({ ...r, start: r.start + by, end: r.end + by }));
