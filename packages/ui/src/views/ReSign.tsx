import { useEffect, useMemo, useState } from 'react';
import type { EvergreenStatus, KeyInfo, SignableKind } from '../api';
import { useApp } from '../state';

const KIND_LABEL: Record<SignableKind, string> = { jwt: 'JWT', flask: 'Flask session cookie' };

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { notify } = useApp();
  return (
    <button className="btn small" onClick={() => navigator.clipboard.writeText(text).then(() => notify('Copied'), () => notify(text))}>
      {label}
    </button>
  );
}

/**
 * Edit and re-sign a signed value (a JWT or a framework session cookie) with a
 * key the user holds, and optionally register it as an evergreen `{{sign:name}}`
 * token that is re-minted fresh — expiry pushed forward — on every send.
 *
 * Shared by the Cookies jar, the Codecs workbench and the Inspector's JWT panel,
 * so re-signing works the same wherever a signed value shows up.
 */
export function ReSignPanel({ value, label, cookie, onClose, onSaved }: { value: string; label?: string; cookie?: { domain: string; name: string }; onClose?: () => void; onSaved?: () => void }) {
  const { client, notify, sendToCodecs } = useApp();
  const [kind, setKind] = useState<SignableKind | null | undefined>(undefined);
  const [alg, setAlg] = useState<string | undefined>();
  const [header, setHeader] = useState<Record<string, unknown> | undefined>();
  const [payloadText, setPayloadText] = useState('');
  const [compress, setCompress] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [keyName, setKeyName] = useState('');
  const [secret, setSecret] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [bumpIat, setBumpIat] = useState(true);
  const [bumpNbf, setBumpNbf] = useState(false);

  const [output, setOutput] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('');
  const [savedToken, setSavedToken] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setKind(undefined);
    setOutput(null);
    setSavedToken(null);
    setErr(null);
    client.resignOpen(value).then(
      (o) => {
        if (!live) return;
        setKind(o.kind);
        setAlg(o.alg);
        setHeader(o.header);
        setPayloadText(JSON.stringify(o.payload ?? {}, null, 2));
        setCompress(!!o.compress);
      },
      (e: Error) => live && (setKind(null), setErr(e.message)),
    );
    client.keys().then((k) => live && (setKeys(k), setTokenName(cookie ? `${cookie.name}` : '')), () => undefined);
    return () => {
      live = false;
    };
  }, [client, value, cookie]);

  const parsedPayload = useMemo(() => {
    try {
      return { value: JSON.parse(payloadText) as unknown, error: null as string | null };
    } catch (e) {
      return { value: null, error: (e as Error).message };
    }
  }, [payloadText]);

  if (kind === undefined) return <div className="faint tech-note">Reading value…</div>;
  if (kind === null)
    return (
      <div className="tech-note faint">
        This value isn't a signed token SiteInquisition can re-mint. Re-signing works on JWTs and on framework session cookies that carry a readable payload (Flask today).{err ? ` (${err})` : ''}
        {onClose && (
          <div style={{ marginTop: 6 }}>
            <button className="btn small" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    );

  const haveKey = !!keyName || !!secret;
  const keyRef = () => (keyName ? { keyName } : { secret });

  const spec = () => ({
    kind,
    payload: parsedPayload.value,
    ...(header ? { header } : {}),
    ...(alg ? { alg } : {}),
    ttlSeconds: Math.max(0, Math.round(ttlMinutes * 60)),
    bumpIat,
    bumpNbf,
    compress,
  });

  const resignNow = async () => {
    if (parsedPayload.error) return notify(`Payload is not valid JSON: ${parsedPayload.error}`);
    try {
      setOutput(await client.resignPreview({ ...spec(), ...keyRef() }));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const keepEvergreen = async () => {
    if (!keyName) return notify('Pick a stored key for an evergreen token. Add one in Settings › Signing keys, then select it here.');
    if (!tokenName.trim()) return notify('Give the evergreen token a name.');
    if (parsedPayload.error) return notify(`Payload is not valid JSON: ${parsedPayload.error}`);
    try {
      await client.evergreenSave({
        name: tokenName.trim(),
        kind,
        keyName,
        payload: parsedPayload.value,
        ...(header ? { header } : {}),
        ...(alg ? { alg } : {}),
        ttlSeconds: Math.max(0, Math.round(ttlMinutes * 60)),
        bumpIat,
        bumpNbf,
        ...(compress ? { compress: true } : {}),
        ...(cookie ? { cookie } : {}),
        updatedAt: 0,
      });
      setSavedToken(`{{sign:${tokenName.trim()}}}`);
      notify(cookie ? `Saved. The ${cookie.name} cookie will be re-signed fresh in the jar and on proxied requests.` : `Saved. Use {{sign:${tokenName.trim()}}} in Replay, rules or macros — it is re-signed on every send.`);
      onSaved?.();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="resign-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <div className="tech-line">
        <span className="badge">{KIND_LABEL[kind]}</span>
        {alg && <span className="mono faint">{alg}</span>}
        {label && <span className="faint">{label}</span>}
        {onClose && (
          <button className="btn small" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <label className="label">{kind === 'jwt' ? 'Claims' : 'Session payload'}</label>
      <textarea className="input mono" style={{ height: 140, padding: 8, width: '100%' }} value={payloadText} onChange={(e) => setPayloadText(e.target.value)} aria-label="Payload to re-sign" />
      {parsedPayload.error && <div className="faint" style={{ color: 'var(--bad, #c00)' }}>Not valid JSON: {parsedPayload.error}</div>}

      <div className="tech-line" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="label" style={{ margin: 0 }}>Sign with</label>
        <select className="input" style={{ width: 'auto' }} value={keyName} onChange={(e) => setKeyName(e.target.value)} aria-label="Signing key">
          <option value="">a secret typed here</option>
          {keys.map((k) => (
            <option key={k.name} value={k.name}>
              {k.name} ({k.kind === 'hmac' ? 'HMAC' : 'PEM'})
            </option>
          ))}
        </select>
        {!keyName && <input className="input mono" style={{ flex: '1 1 180px' }} placeholder={kind === 'jwt' ? 'HMAC secret (for HS*)' : 'Flask secret key'} value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Signing secret" />}
      </div>

      <div className="tech-line" style={{ flexWrap: 'wrap', gap: 12 }}>
        <label className="label" style={{ margin: 0 }} title="How far ahead to set the expiry each time the token is minted">
          Keep valid for
          <input className="input" type="number" min={1} style={{ width: 70, marginLeft: 6 }} value={ttlMinutes} onChange={(e) => setTtlMinutes(Number(e.target.value) || 0)} aria-label="Minutes valid" /> min
        </label>
        {kind === 'jwt' && (
          <>
            <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={bumpIat} onChange={(e) => setBumpIat(e.target.checked)} /> refresh iat
            </label>
            <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }} title="Set nbf (not before) to now, so a token that isn't valid yet becomes usable">
              <input type="checkbox" checked={bumpNbf} onChange={(e) => setBumpNbf(e.target.checked)} /> set nbf = now
            </label>
          </>
        )}
        {kind === 'flask' && (
          <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} /> compress
          </label>
        )}
      </div>

      <div className="tech-line">
        <button className="btn small primary" onClick={() => void resignNow()} disabled={!haveKey || !!parsedPayload.error}>
          Re-sign once
        </button>
        {output && (
          <>
            <Copy text={output} />
            <button className="btn small" onClick={() => sendToCodecs(output, label ?? 're-signed')}>Open in Codecs</button>
          </>
        )}
      </div>
      {output && <textarea className="input mono" style={{ height: 64, padding: 8, width: '100%' }} readOnly value={output} aria-label="Re-signed value" onFocus={(e) => e.currentTarget.select()} />}

      <div className="settings-block" style={{ marginTop: 4 }}>
        <div className="label">Keep evergreen</div>
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
          {cookie ? `Re-sign the ${cookie.name} cookie automatically — its expiry pushed forward — so the jar and proxied requests always send a fresh one.` : 'Save as a token that is re-signed fresh — expiry pushed forward — every time it is sent. Drop {{sign:name}} into a header in Replay, a match-and-replace rule, or a login macro.'}
          {' '}Needs a stored key.
        </p>
        <div className="tech-line" style={{ flexWrap: 'wrap' }}>
          <input className="input mono" style={{ flex: '1 1 160px' }} placeholder="token name" value={tokenName} onChange={(e) => setTokenName(e.target.value)} aria-label="Evergreen token name" />
          <button className="btn small" onClick={() => void keepEvergreen()} disabled={!keyName || !tokenName.trim() || !!parsedPayload.error} title={!keyName ? 'Pick a stored key above' : ''}>
            Keep evergreen
          </button>
        </div>
        {savedToken && (
          <div className="tech-line" style={{ marginTop: 6 }}>
            <span className="faint">Token:</span>
            <code className="mono">{savedToken}</code>
            <Copy text={savedToken} label="Copy token" />
          </div>
        )}
      </div>
    </div>
  );
}

const fmtWhen = (ms: number) => new Date(ms).toLocaleString();

/** Cookies › Signed tokens: the evergreen registry, its refresh settings and the token to reuse. */
export function SignedTokens() {
  const { client, notify } = useApp();
  const [list, setList] = useState<EvergreenStatus[]>([]);
  const load = () => client.evergreenList().then(setList, (e: Error) => notify(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const remove = (name: string) => client.evergreenDelete(name).then(setList, (e: Error) => notify(e.message));
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${text}`), () => notify(text));
  const preview = async (name: string) => {
    try {
      const v = await client.evergreenRender(name);
      notify(`Fresh value minted (${v.length} chars). Copied.`);
      await navigator.clipboard.writeText(v).catch(() => undefined);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="page-pad" style={{ padding: 14, overflow: 'auto' }}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Signed tokens that are re-minted fresh on every send — their expiry pushed forward — so a captured JWT or session cookie with a known key never goes stale. Create one from a cookie's <b>Re-sign</b> button, the Codecs workbench, or the Inspector's JWT panel. Reference one anywhere with <code className="mono">{'{{sign:name}}'}</code>; a token bound to a cookie is also refreshed in the jar and on proxied requests.
      </p>
      {list.length === 0 ? (
        <div className="empty">No evergreen tokens yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Kind</th>
              <th>Key</th>
              <th>Valid for</th>
              <th>Bound cookie</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.name} data-testid="evergreen-row">
                <td>
                  <code className="mono">{`{{sign:${e.name}}}`}</code>
                </td>
                <td>{e.kind === 'jwt' ? 'JWT' : 'Flask cookie'}</td>
                <td>
                  {e.keyName}
                  {!e.canSign && (
                    <div className="faint" style={{ fontSize: 11 }} title="Add the key in Settings › Signing keys to mint this token">
                      key not loaded
                    </div>
                  )}
                </td>
                <td>{e.ttlSeconds ? `${Math.round(e.ttlSeconds / 60)} min` : '1 h'}</td>
                <td className="mono">{e.cookie ? `${e.cookie.name} @ ${e.cookie.domain}` : <span className="faint">—</span>}</td>
                <td className="faint">{e.updatedAt ? fmtWhen(e.updatedAt) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" onClick={() => copy(`{{sign:${e.name}}}`)}>Copy token</button>{' '}
                  <button className="btn small" disabled={!e.canSign} title="Mint a fresh value now and copy it" onClick={() => void preview(e.name)}>Preview</button>{' '}
                  <button className="btn small" onClick={() => void remove(e.name)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
