import { useMemo, useState } from 'react';
import type { H3PlanOptions, H3PlanResult, H2PlanOptions, H2PlanResult, LadderStep } from '../api';
import { useApp, type H3Item } from '../state';
import { Icon } from '../components/icons';
import { fmtMs as fmtMsBase, parseRawRequest, toRawRequest } from '../format';
import { bodyText } from '../actions';
import { RegionEditor } from '../components/Decoded';
import { adjustRegions } from '@siteinquisition/codecs/regionedit';

/** Sub-10 ms values keep two decimals: gate spreads are often well under a millisecond. */
const fmtMs = (n: number | null | undefined) => (n !== null && n !== undefined && n < 10 ? `${n.toFixed(2)} ms` : fmtMsBase(n));

type Protocol = 'h2' | 'h3';
type Run = H3PlanResult['runs'][number];
type Row = Run['rows'][number];
type H2Run = H2PlanResult['runs'][number];

interface ConnSettings {
  gate: 'none' | 'single-datagram';
  concurrency: number;
  repeat: number;
  scheduler: 'fifo' | 'round-robin';
  ignoreTls: boolean;
  timeoutMs: number;
  // flow control (empty = default)
  maxData: string;
  maxStreamData: string;
  autoCredit: boolean;
  // QPACK
  qpackCapacity: string;
  qpackBlocked: string;
  huffman: 'auto' | 'always' | 'never';
  dynamic: boolean;
  allowBlocking: boolean;
  // connection events
  zeroRttConnections: number;
  migrateAtMs: string;
  migrateNewCid: boolean;
  keyUpdateAtMs: string;
  closeAtMs: string;
  // HTTP/2 only
  h2Connect: 'alpn' | 'upgrade' | 'prior-knowledge';
  h2MaxConcurrent: string;
  h2InitialWindow: string;
  h2MaxFrame: string;
  h2ConnectionWindow: string;
  h2TableSize: string;
  h2GoawayAtMs: string;
}

const DEFAULTS: ConnSettings = {
  gate: 'single-datagram',
  concurrency: 0,
  repeat: 1,
  scheduler: 'fifo',
  ignoreTls: false,
  timeoutMs: 15000,
  maxData: '',
  maxStreamData: '',
  autoCredit: true,
  qpackCapacity: '',
  qpackBlocked: '',
  huffman: 'auto',
  dynamic: true,
  allowBlocking: true,
  zeroRttConnections: 1,
  migrateAtMs: '',
  migrateNewCid: true,
  keyUpdateAtMs: '',
  closeAtMs: '',
  h2Connect: 'alpn',
  h2MaxConcurrent: '',
  h2InitialWindow: '',
  h2MaxFrame: '',
  h2ConnectionWindow: '',
  h2TableSize: '',
  h2GoawayAtMs: '',
};

const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const numIn = (v: number | undefined) => (v === undefined ? '' : String(v));
const parseHeaderLines = (s: string): Array<[string, string]> =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return (i < 0 ? [l.trim().toLowerCase(), ''] : [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]) as [string, string];
    })
    .filter(([k]) => k);

const PRESETS: Array<{ id: string; label: string; hint: string; protocols?: Protocol[]; apply(items: H3Item[], c: ConnSettings): [H3Item[], ConnSettings] }> = [
  {
    id: 'gate',
    label: 'Single-packet race',
    hint: 'Hold every stream at its last byte, then release all of them together in one write.',
    apply: (items, c) => [items.map((i) => ({ ...i, hold: 'last-byte', releaseAtMs: undefined, openAtMs: undefined, after: undefined })), { ...c, gate: 'single-datagram', concurrency: 0 }],
  },
  {
    id: 'stagger',
    label: 'Stagger opens',
    hint: 'Open stream N at N × 10 ms, nothing held.',
    apply: (items, c) => [items.map((i, n) => ({ ...i, hold: undefined, openAtMs: n * 10, after: undefined })), c],
  },
  {
    id: 'serial',
    label: 'One at a time',
    hint: 'Concurrency 1: each stream opens when the one before it finishes.',
    apply: (items, c) => [items.map((i) => ({ ...i, hold: undefined, openAtMs: undefined })), { ...c, concurrency: 1 }],
  },
  {
    id: 'priority',
    label: 'Priority inversion',
    hint: 'Later rows ask for higher urgency (u=7 down to u=0): does the server reorder its responses?',
    apply: (items, c) => [items.map((i, n) => ({ ...i, priority: `u=${Math.max(0, 7 - n)}` })), c],
  },
  {
    id: 'zero-rtt',
    label: '0-RTT replay',
    hint: 'Send every row as early data on two connections with the same ticket. A safe server rejects or deduplicates the second copy.',
    protocols: ['h3'],
    apply: (items, c) => [items.map((i) => ({ ...i, earlyData: true, hold: undefined })), { ...c, zeroRttConnections: 2 }],
  },
  {
    id: 'rapid-reset',
    label: 'Rapid reset probe',
    hint: 'Hold each row at its last byte, then reset it 20 ms after release: does the server bound concurrent resets (CVE-2023-44487)?',
    protocols: ['h2'],
    apply: (items, c) => [items.map((i) => ({ ...i, hold: 'last-byte', resetAtMs: 20, releaseAtMs: undefined })), { ...c, gate: 'single-datagram' }],
  },
  {
    id: 'starve',
    label: 'Starve the server',
    hint: 'Tiny receive windows and no credit back: watch the server block and time out.',
    apply: (items, c) => [items, { ...c, maxData: '8192', maxStreamData: '4096', h2InitialWindow: '4096', h2ConnectionWindow: '8192', autoCredit: false, timeoutMs: 3000 }],
  },
];

/**
 * The protocol lab: a stream plan for one HTTP/2 or HTTP/3 connection. Each
 * row is a request with timing and stream controls; the connection settings
 * cover flow control, the header compressor, SETTINGS and connection events.
 * HTTP/2 and HTTP/3 share the row shape, so both read the same way.
 */
export function H3Lab() {
  const { client, h3Items, setH3Items, raceItems, selectedId, notify, select, setView, setQuery } = useApp();
  const [protocol, setProtocol] = useState<Protocol>('h2');
  const [c, setC] = useState<ConnSettings>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<H3PlanResult | null>(null);
  const [h2Result, setH2Result] = useState<H2PlanResult | null>(null);
  const [ladder, setLadder] = useState<{ url: string; steps: LadderStep[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showConn, setShowConn] = useState(false);
  const [logFilter, setLogFilter] = useState('');

  const patch = (key: string, p: Partial<H3Item>) => setH3Items(h3Items.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const set = <K extends keyof ConnSettings>(k: K, v: ConnSettings[K]) => setC({ ...c, [k]: v });
  const h2 = protocol === 'h2';
  const defaultScheme = h2 ? 'https' : 'https';

  const addSelected = async () => {
    if (!selectedId) return notify('Select a request in History first.');
    const ex = await client.get(selectedId);
    const body = ex.reqBodySize ? await bodyText(client, ex.id, 'request').catch(() => '') : '';
    const url = ex.url.replace(/^http:/, `${defaultScheme}:`);
    setH3Items([...h3Items, { key: `${Date.now()}`, raw: toRawRequest(ex.method, url, ex.requestHeaders.filter(([k]) => !k.startsWith(':')), body), replayOf: ex.id }]);
  };

  const copies = (item: H3Item, n: number) => setH3Items([...h3Items, ...Array.from({ length: n }, (_, i) => ({ ...item, key: `${item.key}-c${Date.now()}-${i}` }))]);

  const h3options = (): H3PlanOptions => {
    const transport: Record<string, number> = {};
    if (num(c.maxData) !== undefined) transport.initialMaxData = num(c.maxData)!;
    if (num(c.maxStreamData) !== undefined) transport.initialMaxStreamDataBidiLocal = num(c.maxStreamData)!;
    return {
      gate: c.gate,
      concurrency: c.concurrency || undefined,
      repeat: c.repeat,
      scheduler: c.scheduler,
      ignoreTlsErrors: c.ignoreTls,
      timeoutMs: c.timeoutMs,
      transport: Object.keys(transport).length ? transport : undefined,
      autoCredit: c.autoCredit,
      settings: {
        ...(num(c.qpackCapacity) !== undefined ? { qpackMaxTableCapacity: num(c.qpackCapacity) } : {}),
        ...(num(c.qpackBlocked) !== undefined ? { qpackBlockedStreams: num(c.qpackBlocked) } : {}),
      },
      qpack: { huffman: c.huffman === 'auto' ? 'auto' : c.huffman === 'always', dynamic: c.dynamic, allowBlocking: c.allowBlocking },
      zeroRttConnections: c.zeroRttConnections,
      migrateAtMs: num(c.migrateAtMs),
      migrateNewCid: c.migrateNewCid,
      keyUpdateAtMs: num(c.keyUpdateAtMs),
      closeAtMs: num(c.closeAtMs),
    };
  };

  const h2options = (): H2PlanOptions => {
    const settings: Record<string, number> = {};
    if (num(c.h2MaxConcurrent) !== undefined) settings.maxConcurrentStreams = num(c.h2MaxConcurrent)!;
    if (num(c.h2InitialWindow) !== undefined) settings.initialWindowSize = num(c.h2InitialWindow)!;
    if (num(c.h2MaxFrame) !== undefined) settings.maxFrameSize = num(c.h2MaxFrame)!;
    if (num(c.h2TableSize) !== undefined) settings.headerTableSize = num(c.h2TableSize)!;
    return {
      connect: c.h2Connect,
      gate: c.gate === 'none' ? 'none' : 'single-packet',
      concurrency: c.concurrency || undefined,
      repeat: c.repeat,
      ignoreTlsErrors: c.ignoreTls,
      timeoutMs: c.timeoutMs,
      autoCredit: c.autoCredit,
      settings: Object.keys(settings).length ? (settings as H2PlanOptions['settings']) : undefined,
      connectionWindow: num(c.h2ConnectionWindow),
      goawayAtMs: num(c.h2GoawayAtMs),
      closeAtMs: num(c.closeAtMs),
    };
  };

  // Encode any inline-decoded regions back to wire text before parsing.
  const rows = async () =>
    Promise.all(
      h3Items.map(async (i) => {
        const raw = i.regions?.length ? (await client.encodeRegions(i.raw, i.regions)).text : i.raw;
        const p = parseRawRequest(raw);
        return {
          p,
          item: i,
          base: {
            method: p.method,
            url: p.url,
            headers: p.headers,
            body: p.body ? new TextEncoder().encode(p.body) : undefined,
            replayOf: i.replayOf ?? null,
            openAtMs: i.openAtMs,
            after: i.after,
            hold: i.hold,
            releaseAtMs: i.releaseAtMs,
            chunkSize: i.chunkSize,
            chunkGapMs: i.chunkGapMs,
            resetAfterBytes: i.resetAfterBytes,
            resetAtMs: i.resetAtMs,
            resetCode: i.resetCode,
            priority: i.priority || undefined,
          },
        };
      }),
    );

  const run = async () => {
    setRunning(true);
    try {
      const built = await rows();
      if (h2) {
        const requests = built.map(({ base, item }) => ({
          ...base,
          hold: base.hold === 'fin' ? ('fin' as const) : base.hold === 'last-byte' ? ('last-byte' as const) : undefined,
          stopReadingAfterBytes: item.stopSendingAfterBytes,
          continuationSize: item.continuationSize,
          padding: item.padding,
          trailers: item.trailers ? parseHeaderLines(item.trailers) : undefined,
        }));
        setResult(null);
        setH2Result(await client.h2Run(requests, h2options()));
      } else {
        const requests = built.map(({ base, item }) => ({
          ...base,
          stopSendingAfterBytes: item.stopSendingAfterBytes,
          priorityUpdates: item.priorityUpdateAtMs !== undefined && item.priorityUpdateValue ? [{ atMs: item.priorityUpdateAtMs, value: item.priorityUpdateValue }] : undefined,
          earlyData: item.earlyData,
        }));
        setH2Result(null);
        setResult(await client.h3Run(requests, h3options()));
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const runLadder = async () => {
    const first = h3Items[0];
    if (!first) return notify('Add a request first: the ladder probes its host.');
    let url: string;
    try {
      url = parseRawRequest(first.raw).url;
    } catch (e) {
      return notify((e as Error).message);
    }
    setRunning(true);
    try {
      setLadder({ url, steps: await client.protocolLadder(url, c.ignoreTls) });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const fromRace = () => {
    if (!raceItems.length) return notify('Nothing in Race to copy.');
    setH3Items([...h3Items, ...raceItems.map((r, n) => {
      const raw = r.raw.replace(/^(\w+ )http:/, `$1${defaultScheme}:`);
      return { key: `${Date.now()}-r${n}`, raw, regions: r.regions && adjustRegions(r.regions, r.raw, raw), replayOf: r.replayOf, openAtMs: r.offsetMs || undefined };
    })]);
  };

  const numField = (label: string, value: number | undefined, onChange: (v: number | undefined) => void, title: string, width = 72) => (
    <label className="check" title={title}>
      {label}
      <input className="input mono" type="number" min={0} value={numIn(value)} placeholder="-" onChange={(e) => onChange(num(e.target.value))} style={{ width }} aria-label={label} />
    </label>
  );

  const presets = PRESETS.filter((p) => !p.protocols || p.protocols.includes(protocol));

  return (
    <div className="page race h3lab">
      <div className="replay-bar">
        <span className="panel-title">Protocol lab</span>
        <div className="segmented" role="group" aria-label="Protocol">
          <button className="seg" aria-pressed={protocol === 'h2'} title="One HTTP/2 connection (TCP, ALPN / h2c upgrade / prior knowledge)" onClick={() => setProtocol('h2')}>
            HTTP/2
          </button>
          <button className="seg" aria-pressed={protocol === 'h3'} title="One HTTP/3 connection (QUIC over UDP)" onClick={() => setProtocol('h3')}>
            HTTP/3
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Gate">
          <button className="seg" aria-pressed={c.gate === 'single-datagram'} title={h2 ? 'Held rows release their last bytes together in one TCP write' : 'Held rows release their last bytes together, in as few UDP datagrams as possible'} onClick={() => set('gate', 'single-datagram')}>
            {h2 ? 'Single-packet gate' : 'Single-datagram gate'}
          </button>
          <button className="seg" aria-pressed={c.gate === 'none'} title="Held rows release one after another" onClick={() => set('gate', 'none')}>
            No gate
          </button>
        </div>
        <label className="check" title="At most this many of our streams open at once; 0 means no limit">
          Concurrency
          <input className="input mono" type="number" min={0} max={200} value={c.concurrency} onChange={(e) => set('concurrency', Math.max(0, Number(e.target.value) || 0))} style={{ width: 56 }} aria-label="Concurrency" />
        </label>
        <label className="check">
          Runs
          <input className="input mono" type="number" min={1} max={20} value={c.repeat} onChange={(e) => set('repeat', Math.max(1, Math.min(20, Number(e.target.value) || 1)))} style={{ width: 56 }} aria-label="Runs" />
        </label>
        <label className="check">
          <input type="checkbox" checked={c.ignoreTls} onChange={(e) => set('ignoreTls', e.target.checked)} /> Ignore TLS errors
        </label>
        <button className="btn small" onClick={() => setShowConn(!showConn)} aria-expanded={showConn}>
          Connection settings
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void runLadder()} disabled={running || !h3Items.length} title="Probe the first row's host: which ways of getting HTTP/2 and HTTP/3 does it accept?">
          Ladder test
        </button>
        <button className="btn small" onClick={() => void addSelected()} disabled={!selectedId} title="Add the request selected in History">
          Add selected request
        </button>
        <button className="btn small" onClick={fromRace} disabled={!raceItems.length} title="Copy the requests lined up in Race">
          Copy from Race
        </button>
        <button className="btn primary" onClick={() => void run()} disabled={running || h3Items.length === 0}>
          <Icon name={h2 ? 'send' : 'h3'} size={13} /> {running ? 'Running...' : `Run ${h3Items.length} ${h3Items.length === 1 ? 'stream' : 'streams'}`}
        </button>
      </div>
      <div className="h3-presets" role="group" aria-label="Presets">
        <span className="faint">Presets</span>
        {presets.map((p) => (
          <button
            key={p.id}
            className="btn small"
            title={p.hint}
            disabled={!h3Items.length}
            onClick={() => {
              const [items, conn] = p.apply(h3Items, c);
              setH3Items(items);
              setC(conn);
              notify(p.hint);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {ladder && (
        <div className="card h3-conn" aria-label="Ladder test">
          <fieldset>
            <legend>Ladder test · {ladder.url}</legend>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Way in</th>
                  <th>Accepted</th>
                  <th>What the server did</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {ladder.steps.map((s) => (
                  <tr key={s.method}>
                    <td className="mono">{s.method}</td>
                    <td className={`mono ${s.ok ? 's-2' : 's-err'}`}>{s.ok ? 'yes' : 'no'}</td>
                    <td className="mono">{s.detail}</td>
                    <td className="mono">{fmtMs(s.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn small" onClick={() => setLadder(null)}>
              Hide
            </button>
          </fieldset>
        </div>
      )}
      {showConn && h2 && (
        <div className="card h3-conn" aria-label="HTTP/2 connection settings">
          <fieldset>
            <legend>Connection</legend>
            <label className="check" title="How to get HTTP/2 from the server. The server decides: ALPN picks h2 at the TLS handshake, upgrade asks an HTTP/1.1 server to switch (cleartext only), prior knowledge sends the preface straight away.">
              Way in
              <select className="input" value={c.h2Connect} onChange={(e) => set('h2Connect', e.target.value as ConnSettings['h2Connect'])} aria-label="Connect method">
                <option value="alpn">ALPN (TLS)</option>
                <option value="upgrade">h2c upgrade (cleartext)</option>
                <option value="prior-knowledge">Prior knowledge</option>
              </select>
            </label>
            <label className="check" title="Close the whole connection at this time">
              Close at ms
              <input className="input mono" value={c.closeAtMs} placeholder="-" onChange={(e) => set('closeAtMs', e.target.value)} style={{ width: 64 }} aria-label="Close at" />
            </label>
            <label className="check" title="Send a GOAWAY to the server at this time">
              GOAWAY at ms
              <input className="input mono" value={c.h2GoawayAtMs} placeholder="-" onChange={(e) => set('h2GoawayAtMs', e.target.value)} style={{ width: 64 }} aria-label="GOAWAY at" />
            </label>
            <label className="check">
              Timeout ms
              <input className="input mono" type="number" min={100} value={c.timeoutMs} onChange={(e) => set('timeoutMs', Math.max(100, Number(e.target.value) || 15000))} style={{ width: 72 }} aria-label="Timeout" />
            </label>
          </fieldset>
          <fieldset>
            <legend>SETTINGS we advertise</legend>
            <label className="check" title="SETTINGS_MAX_CONCURRENT_STREAMS: how many streams we let the server open on us (push)">
              Max concurrent
              <input className="input mono" value={c.h2MaxConcurrent} placeholder="default" onChange={(e) => set('h2MaxConcurrent', e.target.value)} style={{ width: 72 }} aria-label="Max concurrent streams" />
            </label>
            <label className="check" title="SETTINGS_INITIAL_WINDOW_SIZE: response bytes per stream before we grant more">
              Stream window
              <input className="input mono" value={c.h2InitialWindow} placeholder="65535" onChange={(e) => set('h2InitialWindow', e.target.value)} style={{ width: 80 }} aria-label="Initial window size" />
            </label>
            <label className="check" title="Our connection-level WINDOW_UPDATE target: response bytes across all streams before we grant more">
              Connection window
              <input className="input mono" value={c.h2ConnectionWindow} placeholder="65535" onChange={(e) => set('h2ConnectionWindow', e.target.value)} style={{ width: 80 }} aria-label="Connection window" />
            </label>
            <label className="check" title="SETTINGS_MAX_FRAME_SIZE: the largest frame we accept (16384 to 16777215)">
              Max frame
              <input className="input mono" value={c.h2MaxFrame} placeholder="16384" onChange={(e) => set('h2MaxFrame', e.target.value)} style={{ width: 80 }} aria-label="Max frame size" />
            </label>
            <label className="check" title="SETTINGS_HEADER_TABLE_SIZE: our HPACK dynamic table capacity (0 forbids the server's dynamic table)">
              HPACK table
              <input className="input mono" value={c.h2TableSize} placeholder="4096" onChange={(e) => set('h2TableSize', e.target.value)} style={{ width: 72 }} aria-label="HPACK table size" />
            </label>
            <label className="check" title="Off: we never send WINDOW_UPDATE, so the server stalls once the windows fill">
              <input type="checkbox" checked={c.autoCredit} onChange={(e) => set('autoCredit', e.target.checked)} /> Give credit back
            </label>
          </fieldset>
        </div>
      )}
      {showConn && !h2 && (
        <div className="card h3-conn" aria-label="HTTP/3 connection settings">
          <fieldset>
            <legend>Flow control</legend>
            <label className="check" title="Our initial_max_data: how much the server may send on the whole connection before we grant more">
              Connection window
              <input className="input mono" value={c.maxData} placeholder="4194304" onChange={(e) => set('maxData', e.target.value)} style={{ width: 96 }} aria-label="Connection window" />
            </label>
            <label className="check" title="Our initial_max_stream_data_bidi_local: response bytes per stream before we grant more">
              Stream window
              <input className="input mono" value={c.maxStreamData} placeholder="1048576" onChange={(e) => set('maxStreamData', e.target.value)} style={{ width: 96 }} aria-label="Stream window" />
            </label>
            <label className="check" title="Off: we never send MAX_DATA or MAX_STREAM_DATA, so the server stalls once the windows fill">
              <input type="checkbox" checked={c.autoCredit} onChange={(e) => set('autoCredit', e.target.checked)} /> Give credit back
            </label>
            <label className="check" title="How our queued stream data shares packets">
              Scheduler
              <select className="input" value={c.scheduler} onChange={(e) => set('scheduler', e.target.value as ConnSettings['scheduler'])} aria-label="Scheduler">
                <option value="fifo">In write order</option>
                <option value="round-robin">Round robin</option>
              </select>
            </label>
          </fieldset>
          <fieldset>
            <legend>QPACK</legend>
            <label className="check" title="SETTINGS_QPACK_MAX_TABLE_CAPACITY we advertise (0 forbids the server's dynamic table)">
              Our table
              <input className="input mono" value={c.qpackCapacity} placeholder="4096" onChange={(e) => set('qpackCapacity', e.target.value)} style={{ width: 72 }} aria-label="QPACK table capacity" />
            </label>
            <label className="check" title="SETTINGS_QPACK_BLOCKED_STREAMS we advertise">
              Blocked streams
              <input className="input mono" value={c.qpackBlocked} placeholder="16" onChange={(e) => set('qpackBlocked', e.target.value)} style={{ width: 56 }} aria-label="QPACK blocked streams" />
            </label>
            <label className="check">
              Huffman
              <select className="input" value={c.huffman} onChange={(e) => set('huffman', e.target.value as ConnSettings['huffman'])} aria-label="Huffman">
                <option value="auto">When shorter</option>
                <option value="always">Always</option>
                <option value="never">Never</option>
              </select>
            </label>
            <label className="check" title="Insert our headers into the server's dynamic table">
              <input type="checkbox" checked={c.dynamic} onChange={(e) => set('dynamic', e.target.checked)} /> Use dynamic table
            </label>
            <label className="check" title="Reference entries before the server acknowledges them, which blocks the request stream until the insert arrives">
              <input type="checkbox" checked={c.allowBlocking} onChange={(e) => set('allowBlocking', e.target.checked)} /> Allow blocking
            </label>
          </fieldset>
          <fieldset>
            <legend>Connection events</legend>
            <label className="check" title="With 0-RTT rows: open this many connections with the same ticket and send the early rows on each">
              0-RTT connections
              <input className="input mono" type="number" min={1} max={10} value={c.zeroRttConnections} onChange={(e) => set('zeroRttConnections', Math.max(1, Math.min(10, Number(e.target.value) || 1)))} style={{ width: 56 }} aria-label="0-RTT connections" />
            </label>
            <label className="check" title="Move to a new local UDP port at this time, like a phone switching networks">
              Migrate at ms
              <input className="input mono" value={c.migrateAtMs} placeholder="-" onChange={(e) => set('migrateAtMs', e.target.value)} style={{ width: 64 }} aria-label="Migrate at" />
            </label>
            <label className="check">
              <input type="checkbox" checked={c.migrateNewCid} onChange={(e) => set('migrateNewCid', e.target.checked)} /> New connection ID
            </label>
            <label className="check" title="Start a TLS key update at this time">
              Key update at ms
              <input className="input mono" value={c.keyUpdateAtMs} placeholder="-" onChange={(e) => set('keyUpdateAtMs', e.target.value)} style={{ width: 64 }} aria-label="Key update at" />
            </label>
            <label className="check" title="Close the whole connection at this time">
              Close at ms
              <input className="input mono" value={c.closeAtMs} placeholder="-" onChange={(e) => set('closeAtMs', e.target.value)} style={{ width: 64 }} aria-label="Close at" />
            </label>
            <label className="check">
              Timeout ms
              <input className="input mono" type="number" min={100} value={c.timeoutMs} onChange={(e) => set('timeoutMs', Math.max(100, Number(e.target.value) || 15000))} style={{ width: 72 }} aria-label="Timeout" />
            </label>
            <button
              className="btn small"
              onClick={() =>
                void client.h3ClearTickets().then(() => notify('Forgot all session tickets: the next run does a full handshake.'))
              }
            >
              Forget tickets
            </button>
          </fieldset>
        </div>
      )}
      {h3Items.length === 0 ? (
        <div className="empty">
          <div className="panel-title">No streams planned</div>
          <div style={{ maxWidth: 560 }}>
            Select a request in History and press Add selected request, or copy what is lined up in Race. Every row becomes a stream on one {h2 ? 'HTTP/2' : 'QUIC'} connection, so all rows must share a host and port. Then set when each stream opens, what it holds back, and when it resets.
          </div>
        </div>
      ) : (
        <div className="race-items">
          {h3Items.map((it, i) => {
            let line = '';
            try {
              const p = parseRawRequest(it.raw);
              line = `${p.method} ${p.url}`;
            } catch (e) {
              line = (e as Error).message;
            }
            const expanded = open === it.key;
            return (
              <div key={it.key} className="card race-item h3-item" data-row={i + 1}>
                <div className="race-item-head">
                  <span className="mono faint">#{i + 1}</span>
                  <span className="mono" style={{ flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={line}>
                    {line}
                  </span>
                  {numField('Open at ms', it.openAtMs, (v) => patch(it.key, { openAtMs: v }), 'Open this stream this many ms after the plan starts')}
                  <label className="check" title="Keep part of the request back until release">
                    Hold
                    <select className="input" value={it.hold ?? ''} onChange={(e) => patch(it.key, { hold: (e.target.value || undefined) as H3Item['hold'] })} aria-label={`Hold for row ${i + 1}`}>
                      <option value="">Nothing</option>
                      <option value="last-byte">Last byte</option>
                      <option value="fin">End of stream</option>
                    </select>
                  </label>
                  {it.hold && numField('Release at ms', it.releaseAtMs, (v) => patch(it.key, { releaseAtMs: v }), 'Empty: release with every other held row once all are open')}
                  {!h2 && (
                    <label className="check" title="Send in 0-RTT early data, using a ticket from an earlier connection">
                      <input type="checkbox" checked={!!it.earlyData} onChange={(e) => patch(it.key, { earlyData: e.target.checked || undefined })} /> 0-RTT
                    </label>
                  )}
                  <button className="btn small" onClick={() => setOpen(expanded ? null : it.key)} aria-expanded={expanded}>
                    More
                  </button>
                  <button className="btn small" onClick={() => copies(it, 1)}>
                    Duplicate
                  </button>
                  <button className="btn small" onClick={() => copies(it, 9)} title="Add 9 more copies (10 in all)">
                    ×10
                  </button>
                  <button className="icon-btn" aria-label={`Remove row ${i + 1}`} onClick={() => setH3Items(h3Items.filter((x) => x.key !== it.key))}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {expanded && (
                  <div className="h3-item-more">
                    <div className="h3-fields">
                      <label className="check" title="Wait for another row before opening this one">
                        After row
                        <select
                          className="input"
                          value={it.after ? `${it.after.row}:${it.after.event}` : ''}
                          onChange={(e) => {
                            const [r, ev] = e.target.value.split(':');
                            patch(it.key, { after: e.target.value ? { row: Number(r), event: ev as 'headers' | 'end' } : undefined });
                          }}
                          aria-label={`After for row ${i + 1}`}
                        >
                          <option value="">-</option>
                          {h3Items.map((_, n) =>
                            n === i ? null : (
                              <optgroup key={n} label={`Row ${n + 1}`}>
                                <option value={`${n}:headers`}>#{n + 1} response headers</option>
                                <option value={`${n}:end`}>#{n + 1} finished</option>
                              </optgroup>
                            ),
                          )}
                        </select>
                      </label>
                      {numField('Chunk bytes', it.chunkSize, (v) => patch(it.key, { chunkSize: v }), 'Split the body into DATA frames of this size')}
                      {numField('Gap ms', it.chunkGapMs, (v) => patch(it.key, { chunkGapMs: v }), 'Pause between body chunks')}
                      {numField('Reset after bytes', it.resetAfterBytes, (v) => patch(it.key, { resetAfterBytes: v }), 'Send RST_STREAM / RESET_STREAM once this many body bytes are written')}
                      {numField('Reset at ms', it.resetAtMs, (v) => patch(it.key, { resetAtMs: v }), 'Reset the stream at this time')}
                      <label className="check" title={h2 ? 'Error code for the reset (default CANCEL 0x8)' : 'Application error code for the reset (default H3_REQUEST_CANCELLED 0x10c)'}>
                        Code
                        <input className="input mono" value={it.resetCode === undefined ? '' : `0x${it.resetCode.toString(16)}`} placeholder={h2 ? '0x8' : '0x10c'} onChange={(e) => patch(it.key, { resetCode: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 64 }} aria-label={`Reset code for row ${i + 1}`} />
                      </label>
                      {numField('Stop response after bytes', it.stopSendingAfterBytes, (v) => patch(it.key, { stopSendingAfterBytes: v }), h2 ? 'Stop granting credit once this many response bytes arrive: the server stalls on this stream' : 'Send STOP_SENDING once this many response bytes arrived')}
                      <label className="check" title="RFC 9218 priority header, e.g. u=0, i">
                        Priority
                        <input className="input mono" value={it.priority ?? ''} placeholder="u=3" onChange={(e) => patch(it.key, { priority: e.target.value || undefined })} style={{ width: 72 }} aria-label={`Priority for row ${i + 1}`} />
                      </label>
                      {!h2 && numField('Update priority at ms', it.priorityUpdateAtMs, (v) => patch(it.key, { priorityUpdateAtMs: v }), 'Send a PRIORITY_UPDATE frame for this stream at this time')}
                      {!h2 && (
                        <label className="check">
                          to
                          <input className="input mono" value={it.priorityUpdateValue ?? ''} placeholder="u=0" onChange={(e) => patch(it.key, { priorityUpdateValue: e.target.value || undefined })} style={{ width: 72 }} aria-label={`Priority update for row ${i + 1}`} />
                        </label>
                      )}
                      {h2 && numField('Split headers over bytes', it.continuationSize, (v) => patch(it.key, { continuationSize: v }), 'Break the header block into CONTINUATION frames of this size')}
                      {h2 && numField('Pad frames to bytes', it.padding, (v) => patch(it.key, { padding: v }), 'Add this many padding bytes to HEADERS and DATA frames')}
                    </div>
                    {h2 && (
                      <label className="check" style={{ alignItems: 'flex-start' }} title="Trailers sent after the body, as HEADERS with END_STREAM: one name: value per line">
                        Trailers
                        <textarea className="editor" style={{ height: 48, width: 240 }} spellCheck={false} value={it.trailers ?? ''} placeholder="grpc-status: 0" onChange={(e) => patch(it.key, { trailers: e.target.value || undefined })} aria-label={`Trailers for row ${i + 1}`} />
                      </label>
                    )}
                    <RegionEditor
                      className="editor"
                      style={{ height: 160 }}
                      spellCheck={false}
                      value={it.raw}
                      regions={it.regions ?? []}
                      onChange={(d) => patch(it.key, { raw: d.text, regions: d.regions })}
                      aria-label={`Raw request ${i + 1}`}
                      title="Ctrl D shows a selected value decoded in place; it is encoded again when sent."
                    />
                  </div>
                )}
              </div>
            );
          })}
          <div>
            <button className="btn small" onClick={() => setH3Items([])}>
              Clear all
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="race-results" aria-label="HTTP/3 results">
          <div className="replay-bar">
            <span className="panel-title">Results</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {result.runs.length} {result.runs.length === 1 ? 'run' : 'runs'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="btn small"
              onClick={() => {
                setQuery(`tag:h3plan:${result.id}`);
                setView('history');
              }}
            >
              All streams in History
            </button>
          </div>
          {result.runs.map((r) => (
            <RunCard key={r.run} run={r} onInspect={(id) => (select(id), setView('history'))} logFilter={logFilter} setLogFilter={setLogFilter} />
          ))}
        </div>
      )}
      {h2Result && (
        <div className="race-results" aria-label="HTTP/2 results">
          <div className="replay-bar">
            <span className="panel-title">Results</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {h2Result.runs.length} {h2Result.runs.length === 1 ? 'run' : 'runs'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="btn small"
              onClick={() => {
                setQuery(`tag:lab:${h2Result.id}`);
                setView('history');
              }}
            >
              All streams in History
            </button>
          </div>
          {h2Result.runs.map((r) => (
            <H2RunCard key={r.run} run={r} onInspect={(id) => (select(id), setView('history'))} logFilter={logFilter} setLogFilter={setLogFilter} />
          ))}
        </div>
      )}
    </div>
  );
}

function RowsTable({ rows, multi, onInspect }: { rows: Row[]; multi: boolean; onInspect(id: string): void }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Stream</th>
          <th>Opened</th>
          <th>Released</th>
          <th>First byte</th>
          <th>Done</th>
          <th>Order</th>
          <th>Status</th>
          <th>Bytes</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.connection}-${r.index}`}>
            <td className="mono">
              {r.index + 1}
              {multi ? `/${r.connection + 1}` : ''}
              {r.early ? ' 0-RTT' : ''}
            </td>
            <td className="mono">{r.streamId ?? ''}</td>
            <td className="mono">{fmtMs(r.timings.opened)}</td>
            <td className="mono">{fmtMs(r.timings.released ?? r.timings.finSent)}</td>
            <td className="mono">{fmtMs(r.timings.firstByte)}</td>
            <td className="mono">{fmtMs(r.timings.complete ?? r.timings.resetReceived)}</td>
            <td className="mono">{r.completedOrder === null ? '' : r.completedOrder + 1}</td>
            <td className={`mono ${r.status === null ? 's-err' : r.status >= 400 ? 's-4' : 's-2'}`} title={r.error}>
              {r.status ?? r.resetByServer ?? r.error ?? 'failed'}
            </td>
            <td className="mono">{r.bodyBytes}</td>
            <td>
              <button className="btn small" onClick={() => onInspect(r.exchangeId)}>
                Inspect
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunCard({ run, onInspect, logFilter, setLogFilter }: { run: Run; onInspect(id: string): void; logFilter: string; setLogFilter(s: string): void }) {
  const [showLog, setShowLog] = useState(false);
  const end = Math.max(1, ...run.rows.flatMap((r) => Object.values(r.timings).filter((x): x is number => typeof x === 'number')));
  const pct = (t: number | undefined) => `${((t ?? 0) / end) * 100}%`;
  const statuses = [...new Set(run.rows.map((r) => r.status))];
  const conn = run.connections[0];
  const packets = useMemo(() => {
    const f = logFilter.toLowerCase();
    return (conn?.packets ?? []).filter((p) => !f || `${p.type} ${p.frames.join(' ')}`.toLowerCase().includes(f)).slice(-400);
  }, [conn, logFilter]);
  return (
    <div className="card" style={{ margin: '8px 12px' }}>
      <div className="sec-head" style={{ flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--text)' }}>Run {run.run + 1}</b>
        <span>spread {fmtMs(run.spreadMs)}</span>
        {conn?.gateDatagrams !== undefined && <span>gate released in {conn.gateDatagrams} {conn.gateDatagrams === 1 ? 'datagram' : 'datagrams'}</span>}
        <span className={run.reordered ? 's-4' : ''}>{run.reordered ? 'answered out of order' : 'answered in order'}</span>
        <span className={statuses.length > 1 ? 's-4' : ''}>{statuses.length > 1 ? `different outcomes: ${statuses.map((s) => s ?? 'error').join(', ')}` : `all ${statuses[0] ?? 'failed'}`}</span>
      </div>
      <div className="h3-conn-summary">
        {run.connections.map((cn) => (
          <span key={cn.index} className="mono" title={`Server settings ${JSON.stringify(cn.serverSettings)}`}>
            conn {cn.index + 1}: {cn.alpn ?? 'no ALPN'} · rtt {fmtMs(cn.rttMs)}
            {cn.resumed ? ' · resumed' : ''}
            {cn.earlyDataAccepted === true ? ' · 0-RTT accepted' : cn.earlyDataAccepted === false ? ' · 0-RTT rejected' : ''}
            {cn.localPorts.length > 1 ? ` · ports ${cn.localPorts.join(' → ')}` : ''}
            {cn.closed ? ` · closed (${cn.closed})` : ''}
          </span>
        ))}
      </div>
      <div className="h3-lanes" aria-label={`Stream lanes for run ${run.run + 1}`}>
        {run.rows.map((row) => (
          <Lane key={`${row.connection}-${row.index}`} row={row} pct={pct} multi={run.connections.length > 1} />
        ))}
        <div className="h3-legend faint">
          <span><i className="mk open" /> opened</span>
          <span><i className="mk held" /> released</span>
          <span><i className="mk first" /> first byte</span>
          <span><i className="mk reset" /> reset</span>
          <span>{fmtMs(end)} total</span>
        </div>
      </div>
      <RowsTable rows={run.rows} multi={run.connections.length > 1} onInspect={onInspect} />
      <div className="sec-head">
        <button className="btn small" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
          Packet log ({conn?.packets.length ?? 0})
        </button>
        {conn && (
          <span>
            QPACK sent {String((conn.qpack.encoder as { inserted?: number }).inserted ?? 0)} inserts, received {String((conn.qpack.decoder as { inserted?: number }).inserted ?? 0)}
          </span>
        )}
        {showLog && <input className="input" placeholder="Filter, e.g. STREAM id=0 or RESET" value={logFilter} onChange={(e) => setLogFilter(e.target.value)} aria-label="Filter packets" style={{ width: 240 }} />}
      </div>
      {showLog && (
        <div className="h3-log mono" aria-label="Packet log">
          {packets.map((p, n) => (
            <div key={n} className={p.dir === 'in' ? 'in' : 'out'}>
              <span className="faint">{fmtMs(p.t)}</span> <span>{p.dir === 'in' ? '←' : '→'}</span> <span>{p.type}</span> <span className="faint">#{p.pn}</span> <span className="faint">{p.size}B</span> {p.frames.join(' · ')}
            </div>
          ))}
          {conn?.control.map((cf, n) => (
            <div key={`c${n}`} className="ctl">
              <span className="faint">{fmtMs(cf.t)}</span> control {cf.dir === 'in' ? '←' : '→'} 0x{cf.type.toString(16)} {cf.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function H2RunCard({ run, onInspect, logFilter, setLogFilter }: { run: H2Run; onInspect(id: string): void; logFilter: string; setLogFilter(s: string): void }) {
  const [showLog, setShowLog] = useState(false);
  const end = Math.max(1, ...run.rows.flatMap((r) => Object.values(r.timings).filter((x): x is number => typeof x === 'number')));
  const pct = (t: number | undefined) => `${((t ?? 0) / end) * 100}%`;
  const statuses = [...new Set(run.rows.map((r) => r.status))];
  const conn = run.connections[0];
  const frames = useMemo(() => {
    const f = logFilter.toLowerCase();
    return (conn?.frames ?? [])
      .filter((fr) => !f || `${fr.type} ${fr.stream} ${fr.detail}`.toLowerCase().includes(f))
      .slice(-800);
  }, [conn, logFilter]);
  return (
    <div className="card" style={{ margin: '8px 12px' }}>
      <div className="sec-head" style={{ flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--text)' }}>Run {run.run + 1}</b>
        <span>spread {fmtMs(run.spreadMs)}</span>
        {conn?.gateBytes !== undefined && <span>gate wrote {conn.gateBytes} B in one packet</span>}
        <span className={run.reordered ? 's-4' : ''}>{run.reordered ? 'answered out of order' : 'answered in order'}</span>
        <span className={statuses.length > 1 ? 's-4' : ''}>{statuses.length > 1 ? `different outcomes: ${statuses.map((s) => s ?? 'error').join(', ')}` : `all ${statuses[0] ?? 'failed'}`}</span>
      </div>
      <div className="h3-conn-summary">
        {run.connections.map((cn) => (
          <span key={cn.index} className="mono" title={`Server SETTINGS ${JSON.stringify(cn.serverSettings)}`}>
            {cn.method}
            {cn.alpn ? ` · ALPN ${cn.alpn}` : cn.alpn === null ? ' · no ALPN' : ''}
            {cn.pingRttMs.length ? ` · ping ${cn.pingRttMs.map((x) => fmtMs(x)).join(', ')}` : ''}
            {cn.goaway ? ` · GOAWAY ${cn.goaway.code} (last stream ${cn.goaway.lastStream})` : ''}
            {cn.closed ? ` · ${cn.closed}` : ''}
          </span>
        ))}
        {conn && <span className="mono faint" title="The server's SETTINGS">SETTINGS {Object.entries(conn.serverSettings).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}</span>}
        {conn?.upgradeHead && <span className="mono faint" title={conn.upgradeHead}>upgraded: {conn.upgradeHead.split('\r\n')[0]}</span>}
      </div>
      <div className="h3-lanes" aria-label={`Stream lanes for run ${run.run + 1}`}>
        {run.rows.map((row) => (
          <Lane key={`${row.connection}-${row.index}`} row={row} pct={pct} multi={false} />
        ))}
        <div className="h3-legend faint">
          <span><i className="mk open" /> opened</span>
          <span><i className="mk held" /> released</span>
          <span><i className="mk first" /> first byte</span>
          <span><i className="mk reset" /> reset</span>
          <span>{fmtMs(end)} total</span>
        </div>
      </div>
      <RowsTable rows={run.rows} multi={false} onInspect={onInspect} />
      <div className="sec-head">
        <button className="btn small" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
          Frame log ({conn?.frames.length ?? 0})
        </button>
        {showLog && <input className="input" placeholder="Filter, e.g. HEADERS or stream 3 or RST" value={logFilter} onChange={(e) => setLogFilter(e.target.value)} aria-label="Filter frames" style={{ width: 240 }} />}
      </div>
      {showLog && (
        <div className="h3-log mono" aria-label="Frame log">
          {frames.map((fr, n) => (
            <div key={n} className={fr.dir === 'in' ? 'in' : 'out'}>
              <span className="faint">{fmtMs(fr.t)}</span> <span>{fr.dir === 'in' ? '←' : '→'}</span> <span>{fr.type}</span> <span className="faint">stream {fr.stream}</span> <span className="faint">{fr.length}B</span> {fr.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Lane({ row, pct, multi }: { row: Row; pct: (t: number | undefined) => string; multi: boolean }) {
  const t = row.timings;
  const start = t.opened ?? 0;
  const stop = t.complete ?? t.resetReceived ?? t.resetSent ?? t.firstByte ?? t.finSent ?? start;
  const width = `calc(${pct(stop)} - ${pct(start)})`;
  return (
    <div className="h3-lane" title={row.error ?? `${row.label}: ${row.status}`}>
      <span className="mono faint lane-label">
        #{row.index + 1}
        {multi ? `/${row.connection + 1}` : ''} {row.label}
      </span>
      <div className="lane-track">
        <span className={`lane-bar ${row.status === null ? 'err' : ''}`} style={{ left: pct(start), width }} />
        <i className="mk open" style={{ left: pct(t.opened) }} />
        {t.released !== undefined && <i className="mk held" style={{ left: pct(t.released) }} />}
        {t.firstByte !== undefined && <i className="mk first" style={{ left: pct(t.firstByte) }} />}
        {(t.resetSent ?? t.resetReceived) !== undefined && <i className="mk reset" style={{ left: pct(t.resetSent ?? t.resetReceived) }} />}
      </div>
    </div>
  );
}
