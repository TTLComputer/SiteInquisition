import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CoreClient as Client, RegionPlan, TextRegion } from '../api';
import { adjustForEdit, adjustRegions, regionAt, regionLabel, regionsAround, regionsIn, sortRegions, spliceRegion } from '@siteinquisition/codecs/regionedit';
import { useApp } from '../state';
import { usePlacement } from './placement';
import { Highlight } from './Highlight';
import { generalizePath } from '../views/FieldCodecs';

/**
 * Decoded regions, everywhere text is shown: select part of a body, a
 * header or a message and choose Decode (or press Ctrl D), and that part
 * reads decoded in place, in a heavier tinted style. Read-only views keep
 * the regions per exchange while the app is open; editors (Replay, WS
 * Replay) keep them with the draft and encode them again on send.
 */

export interface Decoded {
  text: string;
  regions: TextRegion[];
}

/** Where a zone's text came from, so a region in a JSON body can become a saved field codec. */
export interface SaveContext {
  url: string;
  side: 'request' | 'response';
  /** Where the JSON body starts in the zone's text (0 for a body-only zone). */
  bodyStart: number;
}

/** Decode start..end of a text and mark it. Throws with a message for the user when nothing decodes. */
export async function decodeInto(client: Client, d: Decoded, start: number, end: number, chain?: string[]): Promise<Decoded & { plan: RegionPlan }> {
  const plan = await client.decodeRegion(d.text, start, end, chain);
  return { ...spliceRegion(d.text, d.regions, plan.start, plan.end, plan.display, plan.region), plan };
}

/** Put one region (and everything decoded inside it) back to its encoded form. */
export async function encodeOne(client: Client, d: Decoded, r: TextRegion): Promise<Decoded> {
  const inside = regionsIn(d.regions, r.start, r.end);
  const out = await client.encodeRegions(d.text.slice(r.start, r.end), inside);
  const others = d.regions.filter((x) => !(x.start >= r.start && x.end <= r.end));
  return { text: d.text.slice(0, r.start) + out.text + d.text.slice(r.end), regions: adjustForEdit(others, r.start, r.end, out.text.length) };
}

/**
 * The text as it should be sent: every region encoded again. Regions
 * holding {{tokens}} are left as encode blocks for the sender, which fills
 * the tokens in first.
 */
export async function encodeAll(client: Client, d: Decoded): Promise<string> {
  if (!d.regions.length) return d.text;
  return (await client.encodeRegions(d.text, d.regions, true)).text;
}

/** Save a region (and any decoded fields around it) as field codecs, so it is decoded every time. Returns the regions marked with their rules. */
export async function saveAsRule(client: Client, d: Decoded, r: TextRegion, ctx: SaveContext): Promise<{ regions: TextRegion[]; message: string }> {
  const chainOf = [...regionsAround(d.regions, r), r].filter((x) => !x.rule);
  const body = d.text.slice(ctx.bodyStart);
  const host = (() => {
    try {
      return new URL(ctx.url.replace(/^ws/, 'http')).hostname;
    } catch {
      return '*';
    }
  })();
  const add: Array<{ region: TextRegion; field: string }> = [];
  for (const x of chainOf) {
    if (x.wrap !== 'jsonstr' || x.start < ctx.bodyStart) throw new Error('Only a whole JSON field in a body can be decoded every time. Select the whole string value.');
    const path = await client.regionPath(body, x.start - ctx.bodyStart, x.end - ctx.bodyStart);
    if (!path) throw new Error('This body is not JSON around the value, so it cannot be saved as a field codec.');
    add.push({ region: x, field: generalizePath(path) });
  }
  const rules = await client.fieldCodecs();
  const fresh = add.filter((a) => !rules.some((x) => x.field === a.field && x.host === host && x.chain.join('>') === a.region.chain.join('>')));
  const saved = await client.setFieldCodecs([...rules, ...fresh.map((a) => ({ host, path: '', side: ctx.side, field: a.field, chain: a.region.chain }))]);
  const ids = new Map(add.map((a) => [a.region.id, saved.find((x) => x.field === a.field && x.host === host && x.chain.join('>') === a.region.chain.join('>'))?.id]));
  const last = add[add.length - 1]!;
  return {
    regions: d.regions.map((x) => (ids.get(x.id) ? { ...x, rule: ids.get(x.id) } : x)),
    message: `${last.field} (${regionLabel(r)}) is decoded on ${host} from now on. Edit it in Codecs, Field codecs.`,
  };
}

export async function forgetRule(client: Client, d: Decoded, r: TextRegion): Promise<TextRegion[]> {
  const rules = await client.fieldCodecs();
  await client.setFieldCodecs(rules.filter((x) => x.id !== r.rule));
  return d.regions.map((x) => (x.rule === r.rule ? { ...x, rule: undefined } : x));
}

type Plain = (text: string, offset: number) => ReactNode;

/** Text with its regions as nested spans; plain stretches go through `plain` (search highlights, header colours). */
export function renderRegions(text: string, regions: TextRegion[], plain: Plain, from = 0, to = text.length): ReactNode[] {
  const out: ReactNode[] = [];
  const top = sortRegions(regions.filter((r) => r.start >= from && r.end <= to)).filter((r, _i, all) => !all.some((o) => o !== r && o.start <= r.start && o.end >= r.end && o.end - o.start > r.end - r.start));
  let at = from;
  for (const r of top) {
    if (r.start > at) out.push(<Fragment key={`p${at}`}>{plain(text.slice(at, r.start), at)}</Fragment>);
    out.push(
      <span key={r.id} className={`decoded${r.rule ? ' by-rule' : ''}`} data-region={r.id} data-chain={regionLabel(r)} title={`Decoded: ${regionLabel(r)}${r.rule ? ' (saved field codec)' : ''}. Click for options.`}>
        {renderRegions(
          text,
          regions.filter((x) => x !== r),
          plain,
          r.start,
          r.end,
        )}
      </span>,
    );
    at = r.end;
  }
  if (at < to) out.push(<Fragment key={`p${at}`}>{plain(text.slice(at, to), at)}</Fragment>);
  return out;
}

/** Offsets of the current selection within a zone's text, or null when it is not inside the zone. */
function selectionIn(root: HTMLElement): { start: number; end: number; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length, rect: range.getBoundingClientRect() };
}

/** Remembered regions of read-only views, by view key, for as long as the app is open. */
const kept = new Map<string, { base: string; d: Decoded }>();

/** Actions offered on a region: in a menu for read-only text, in a strip above an editor. */
function RegionActions({ r, d, save, onChange, editable, done }: { r: TextRegion; d: Decoded; save?: SaveContext; onChange(next: Decoded): void; editable?: boolean; done?(): void }) {
  const { client, notify, sendToCodecs } = useApp();
  const run = (f: () => Promise<void>) => () => {
    f().catch((e: Error) => notify(e.message));
    done?.();
  };
  const saveable = !!save && r.wrap === 'jsonstr' && r.start >= save.bodyStart;
  return (
    <>
      <button role="menuitem" className="btn small" onClick={run(async () => onChange(await encodeOne(client, d, r)))} title={editable ? 'Put this value back encoded in the editor, with your edits' : 'Show this value as it was sent'}>
        {editable ? 'Encode back' : 'Show encoded'}
      </button>
      {save && !r.rule && (
        <button
          role="menuitem"
          className="btn small"
          disabled={!saveable}
          title={saveable ? 'Save as a field codec: this field is decoded in the Inspector and Replay every time' : 'Only a whole JSON string field in a body can be decoded every time'}
          onClick={run(async () => {
            const out = await saveAsRule(client, d, r, save);
            onChange({ ...d, regions: out.regions });
            notify(out.message);
          })}
        >
          Always decode
        </button>
      )}
      {r.rule && (
        <button
          role="menuitem"
          className="btn small"
          title="Remove the saved field codec that decodes this field"
          onClick={run(async () => {
            onChange({ ...d, regions: await forgetRule(client, d, r) });
            notify('Field codec removed. The field is shown encoded next time.');
          })}
        >
          Stop always decoding
        </button>
      )}
      <button
        role="menuitem"
        className="btn small"
        title="Open the encoded value in Codecs, with every layer"
        onClick={run(async () => sendToCodecs(r.original.startsWith('"') && r.wrap === 'jsonstr' ? (JSON.parse(r.original) as string) : r.original, `decoded ${regionLabel(r)}`))}
      >
        Codecs
      </button>
      <button role="menuitem" className="btn small" onClick={run(() => navigator.clipboard.writeText(d.text.slice(r.start, r.end)))} title="Copy the decoded value">
        Copy
      </button>
    </>
  );
}

/** The menu a click on a region opens. */
function RegionMenu({ at, r, d, save, onChange, onClose }: { at: { x: number; y: number }; r: TextRegion; d: Decoded; save?: SaveContext; onChange(next: Decoded): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, at, true, { gap: 4 });
  useEffect(() => {
    const off = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', off);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', off);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="region-menu" role="menu" aria-label="Decoded region">
      <div className="region-menu-head">
        Decoded <span className="mono">{regionLabel(r)}</span>
        {r.rule && <span className="badge">saved</span>}
      </div>
      <div className="region-menu-actions">
        <RegionActions r={r} d={d} save={save} onChange={onChange} done={onClose} />
      </div>
    </div>
  );
}

/** "Decode" next to a selection, with the chain it would use, "Decode as" to pick one, and Codecs. */
function DecodeChip({ rect, preview, onDecode, onCodecs, onClose }: { rect: DOMRect; preview: string | null | undefined; onDecode(chain?: string[]): void; onCodecs(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [asText, setAsText] = useState<string | null>(null);
  usePlacement(ref, rect, true, { gap: 6 });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div ref={ref} className="decode-chip" role="toolbar" aria-label="Decode selection" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      {asText === null ? (
        <>
          <button className="btn small primary" onClick={() => onDecode()} disabled={preview === null} title={preview === null ? 'Nothing here looks encoded; use Decode as' : 'Show it decoded in place (Ctrl D)'}>
            Decode{preview ? <span className="chip-chain"> {preview}</span> : null}
          </button>
          <button className="btn small" onClick={() => setAsText(preview ?? '')} title="Pick the codec chain yourself, e.g. url>base64>json">
            Decode as…
          </button>
          <button className="btn small" onClick={onCodecs} title="Open the selection in Codecs (Ctrl Shift D)">
            Codecs
          </button>
        </>
      ) : (
        <form
          className="menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            onDecode(asText.split(/\s*(?:>|,|→|›)\s*/).filter(Boolean));
          }}
        >
          <input className="input mono" autoFocus aria-label="Decode with chain" placeholder="base64>json" value={asText} onChange={(e) => setAsText(e.target.value)} />
          <button className="btn small primary" type="submit">
            Decode
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Read-only text that can have regions decoded in place. `viewKey` names
 * what is shown (exchange, side, view mode) so regions come back when the
 * same thing is shown again; `initial` seeds regions, e.g. from saved field
 * codecs.
 */
export function DecodableText({ text, viewKey, initial, plain, hl, save, label }: { text: string; viewKey: string; initial?: Decoded | null; plain?: Plain; hl?: RegExp | null; save?: SaveContext; label?: string }) {
  const { client, notify, sendToCodecs } = useApp();
  const seed = useCallback((): Decoded => {
    const k = kept.get(viewKey);
    return k && k.base === text ? k.d : (initial ?? { text, regions: [] });
  }, [viewKey, initial, text]);
  const [d, setD] = useState<Decoded>(seed);
  const [base, setBase] = useState({ viewKey, text, initial });
  if (base.viewKey !== viewKey || base.text !== text || base.initial !== initial) {
    // A different exchange or view: show what was kept for it, or start fresh.
    setBase({ viewKey, text, initial });
    setD(seed());
  }
  const change = (next: Decoded) => {
    setD(next);
    kept.set(viewKey, { base: text, d: next });
  };
  const root = useRef<HTMLSpanElement>(null);
  const [chip, setChip] = useState<{ start: number; end: number; rect: DOMRect } | null>(null);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const decode = useCallback(
    async (start: number, end: number, chain?: string[]) => {
      try {
        change(await decodeInto(client, d, start, end, chain));
        window.getSelection()?.removeAllRanges();
      } catch (e) {
        notify((e as Error).message);
      }
      setChip(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, d, notify, viewKey],
  );

  // Ctrl D on a selection in this zone (App sends the event).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => {
      const s = selectionIn(el);
      if (s && s.end > s.start) void decode(s.start, s.end);
    };
    el.addEventListener('siq-decode', on);
    return () => el.removeEventListener('siq-decode', on);
  }, [decode]);

  // Show the chip when a selection ends inside the zone.
  useEffect(() => {
    const onUp = () =>
      window.setTimeout(() => {
        const el = root.current;
        const s = el ? selectionIn(el) : null;
        setChip(s && s.end > s.start && s.end - s.start < 1_000_000 ? s : null);
      }, 0);
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setChip(null);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSel);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSel);
    };
  }, []);
  useEffect(() => {
    if (!chip) return setPreview(undefined);
    let live = true;
    client.decodeRegion(d.text, chip.start, chip.end).then(
      (p) => live && setPreview(regionLabel(p.region)),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [client, chip, d.text]);

  const plainFn: Plain = plain ?? ((t) => (hl ? <Highlight text={t} pattern={hl} /> : t));
  const r = menu ? d.regions.find((x) => x.id === menu.id) : undefined;
  return (
    <>
      <span
        ref={root}
        data-region-zone=""
        aria-label={label}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-region]');
          if (!el || !window.getSelection()?.isCollapsed) return;
          setMenu({ x: e.clientX, y: e.clientY, id: el.dataset.region! });
        }}
      >
        {d.regions.length ? renderRegions(d.text, d.regions, plainFn) : plainFn(d.text, 0)}
      </span>
      {chip && (
        <DecodeChip
          rect={chip.rect}
          preview={preview}
          onDecode={(chain) => void decode(chip.start, chip.end, chain)}
          onCodecs={() => {
            sendToCodecs(d.text.slice(chip.start, chip.end), label ?? 'selection');
            setChip(null);
          }}
          onClose={() => setChip(null)}
        />
      )}
      {menu && r && <RegionMenu at={menu} r={r} d={d} save={save} onChange={change} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * A textarea that shows decoded regions in their style. When there are
 * regions, the text is drawn by a layer behind a transparent textarea, so
 * editing works as usual. Edits move the regions with the text; a caret
 * inside one shows its actions above the editor.
 */
export function RegionEditor({
  value,
  regions,
  onChange,
  textareaRef,
  save,
  className = 'editor',
  ...rest
}: {
  value: string;
  regions: TextRegion[];
  onChange(next: Decoded): void;
  textareaRef?: RefObject<HTMLTextAreaElement | null> | ((el: HTMLTextAreaElement | null) => void);
  save?: SaveContext;
  className?: string;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const back = useRef<HTMLPreElement>(null);
  const [caret, setCaret] = useState<[number, number] | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof textareaRef === 'function') textareaRef(el);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
  };
  const sync = () => {
    if (back.current && own.current) {
      back.current.scrollTop = own.current.scrollTop;
      back.current.scrollLeft = own.current.scrollLeft;
    }
  };
  useLayoutEffect(sync);
  const track = () => own.current && setCaret([own.current.selectionStart, own.current.selectionEnd]);
  const has = regions.length > 0;
  const at = has && caret ? regionAt(regions, caret[0], caret[1]) : null;
  return (
    <div className={`region-editor${has ? ' has-regions' : ''}`}>
      {at && (
        <div className="region-strip" role="toolbar" aria-label="Decoded region">
          <span className="decoded-sample">Decoded</span> <span className="mono">{regionLabel(at)}</span>
          {at.rule && <span className="badge">saved</span>}
          <span className="faint">Edits are encoded again on send.</span>
          <span style={{ flex: 1 }} />
          <RegionActions r={at} d={{ text: value, regions }} save={save} onChange={onChange} editable />
        </div>
      )}
      <div className="region-editor-body">
        {has && (
          <pre ref={back} className={`${className} region-backdrop`} aria-hidden="true">
            {renderRegions(value, regions, (t) => t)}
            {'\n '}
          </pre>
        )}
        <textarea
          {...rest}
          ref={setRef}
          className={`${className}${has ? ' region-ta' : ''}`}
          value={value}
          onScroll={sync}
          onSelect={track}
          onKeyUp={track}
          onClick={track}
          onChange={(e) => onChange({ text: e.target.value, regions: adjustRegions(regions, value, e.target.value) })}
        />
      </div>
    </div>
  );
}
