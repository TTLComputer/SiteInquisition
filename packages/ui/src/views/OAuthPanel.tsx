import { useCallback, useEffect, useState } from 'react';
import type { OAuthGrant, OAuthProfile, OAuthProfileView } from '../api';
import { useApp } from '../state';
import { browserFocus } from './Browser';

const GRANTS: Array<[OAuthGrant, string]> = [
  ['authorization_code', 'Authorization code (+ PKCE)'],
  ['client_credentials', 'Client credentials'],
  ['password', 'Password'],
  ['refresh_token', 'Refresh token only'],
];

const blank = (): OAuthProfile => ({ name: '', grant: 'authorization_code', tokenUrl: '', clientId: '', pkce: true, pkceMethod: 'S256', clientAuth: 'basic', redirectUri: 'http://localhost:8765/callback' });

function expiresIn(t: NonNullable<OAuthProfileView['token']>): string {
  if (t.expiresAt === undefined) return 'no expiry given';
  const s = Math.round((t.expiresAt - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  return s < 120 ? `expires in ${s} s` : s < 7200 ? `expires in ${Math.round(s / 60)} min` : `expires in ${Math.round(s / 3600)} h`;
}

/**
 * OAuth 2.0 profiles for the Auth tab: pick one to send as
 * Authorization: Bearer {{oauth:name}}, set one up, and get its token.
 */
export function OAuthPanel({ selected, onSelect }: { selected: string; onSelect(name: string): void }) {
  const { client, notify, setView } = useApp();
  const [list, setList] = useState<OAuthProfileView[]>([]);
  const [edit, setEdit] = useState<{ profile: OAuthProfile; previous?: string } | null>(null);
  const [issuer, setIssuer] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [pkce, setPkce] = useState<{ verifier: string; challenge: string; method: string } | null>(null);

  const load = useCallback(() => client.oauthProfiles().then(setList, (e: Error) => notify(e.message)), [client, notify]);
  useEffect(() => {
    void load();
    return client.onChange((c) => {
      if (c.kind === 'oauth.updated') void load();
    });
  }, [client, load]);

  const cur = list.find((p) => p.name === selected);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // No profiles at all yet: open the form for the first one, once.
    if (loaded) return;
    void client.oauthProfiles().then((l) => {
      setLoaded(true);
      if (!l.length && !selected) setEdit((e) => e ?? { profile: blank() });
    }, () => setLoaded(true));
  }, [client, loaded, selected]);

  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    f()
      .catch((e: Error) => notify(e.message))
      .finally(() => setBusy(false));
  };

  const getToken = (p: OAuthProfileView) =>
    run(async () => {
      if (p.grant !== 'authorization_code') {
        await client.fetchOAuth(p.name);
        notify(`Got a token for ${p.name}`);
        return;
      }
      const { url } = await client.beginOAuth(p.name);
      const bridge = window.siq?.browser;
      if (bridge) {
        browserFocus.id = await bridge.create(url);
        setView('browser');
        notify('Sign in in the browser tab; the token is picked up when it sends you back.');
      } else {
        window.open(url, '_blank', 'noopener');
        notify('Sign in in the new window, then paste the address it sends you back to.');
      }
    });

  // Tell the user when a browser sign-in finishes, wherever they are.
  const [wasWaiting, setWasWaiting] = useState<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(list.filter((p) => p.waiting).map((p) => p.name));
    for (const n of wasWaiting) {
      const p = list.find((x) => x.name === n);
      if (!now.has(n) && p?.token && Date.now() - p.token.obtainedAt < 60_000) notify(`Signed in: ${n} has a token`);
    }
    if ([...now].join() !== [...wasWaiting].join()) setWasWaiting(now);
  }, [list, wasWaiting, notify]);

  const save = () => {
    if (!edit) return;
    run(async () => {
      const v = await client.saveOAuth(edit.profile, edit.previous);
      setEdit(null);
      await load();
      onSelect(v.name);
    });
  };

  const field = (k: keyof OAuthProfile, label: string, placeholder = '', type = 'text') =>
    edit && (
      <label className="rb-field">
        <span className="label">{label}</span>
        <input
          className="input mono"
          type={type}
          aria-label={`OAuth ${label}`}
          placeholder={placeholder}
          value={(edit.profile[k] as string | undefined) ?? ''}
          onChange={(e) => setEdit({ ...edit, profile: { ...edit.profile, [k]: e.target.value } })}
          spellCheck={false}
        />
      </label>
    );

  return (
    <div className="oauth" aria-label="OAuth 2.0">
      <div className="rb-row">
        <label className="check">
          Profile
          <select className="input" aria-label="OAuth profile" value={cur ? selected : ''} onChange={(e) => e.target.value && onSelect(e.target.value)}>
            <option value="">{list.length ? 'pick one' : 'none yet'}</option>
            {list.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" onClick={() => setEdit({ profile: blank() })}>
          New profile
        </button>
        {cur && (
          <button className="btn small" onClick={() => setEdit({ profile: { ...cur }, previous: cur.name })}>
            Edit
          </button>
        )}
        <span className="faint rb-note">
          Sent as <span className="mono">Authorization: Bearer {`{{oauth:${selected || 'name'}}}`}</span>; refreshed before a send once it expires.
        </span>
      </div>

      {cur && !edit && (
        <div className="oauth-status" aria-label="OAuth token">
          {cur.token ? (
            <span className={cur.token.expired ? 'expired' : undefined}>
              <span className="mono">{cur.token.preview}</span> · {cur.token.tokenType ?? 'Bearer'} · {expiresIn(cur.token)}
              {cur.token.scope ? ` · scope ${cur.token.scope}` : ''}
              {cur.token.hasRefresh ? ' · has a refresh token' : ''}
              {cur.token.hasIdToken ? ' · ID token ({{oauth:' + cur.name + '.id_token}})' : ''}
            </span>
          ) : (
            <span className="muted">No token yet.</span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn small primary" disabled={busy} onClick={() => getToken(cur)}>
            {cur.grant === 'authorization_code' ? 'Get token (sign in)' : 'Get token'}
          </button>
          {cur.token?.hasRefresh && (
            <button className="btn small" disabled={busy} onClick={() => run(() => client.fetchOAuth(cur.name, true).then(() => notify('Refreshed')))}>
              Refresh
            </button>
          )}
          {cur.token && (
            <>
              <button className="btn small" onClick={() => run(() => client.oauthToken(cur.name).then((t) => navigator.clipboard.writeText(t)).then(() => notify('Copied the access token')))}>
                Copy token
              </button>
              <button className="btn small" onClick={() => run(() => client.clearOAuth(cur.name))}>
                Forget token
              </button>
            </>
          )}
        </div>
      )}
      {cur?.waiting && !edit && (
        <div className="banner" role="status">
          <span>
            Waiting for the sign-in. When the server sends the built-in browser back to <span className="mono">{cur.redirectUri}</span>, SiteInquisition answers it and gets the token. Signing in somewhere else? Paste the address you were sent back to:
          </span>
          <input className="input mono" style={{ flex: '1 1 260px' }} aria-label="Address you were sent back to" placeholder={`${cur.redirectUri ?? ''}?code=...&state=...`} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button
            className="btn small"
            disabled={!pasted || busy}
            onClick={() =>
              run(async () => {
                await client.completeOAuth(cur.name, pasted);
                setPasted('');
                notify(`Signed in: ${cur.name} has a token`);
              })
            }
          >
            Finish sign-in
          </button>
          <button className="btn small" onClick={() => run(() => client.cancelOAuth(cur.name))}>
            Cancel
          </button>
        </div>
      )}

      {edit && (
        <div className="oauth-form card" aria-label="OAuth profile settings">
          <div className="rb-grid">
            {field('name', 'Name', 'api')}
            <label className="rb-field">
              <span className="label">Grant</span>
              <select className="input" aria-label="OAuth Grant" value={edit.profile.grant} onChange={(e) => setEdit({ ...edit, profile: { ...edit.profile, grant: e.target.value as OAuthGrant } })}>
                {GRANTS.map(([g, l]) => (
                  <option key={g} value={g}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="rb-row">
            <input className="input mono" style={{ flex: '1 1 260px' }} aria-label="Issuer to discover" placeholder="Issuer, e.g. https://login.example.com/realms/dev" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
            <button
              className="btn small"
              disabled={!issuer || busy}
              onClick={() =>
                run(async () => {
                  const d = await client.discoverOAuth(issuer);
                  setEdit((x) => x && { ...x, profile: { ...x.profile, issuer: d.issuer, authUrl: d.authUrl ?? x.profile.authUrl, tokenUrl: d.tokenUrl ?? x.profile.tokenUrl } });
                  notify(`Found ${[d.authUrl && 'the authorization endpoint', d.tokenUrl && 'the token endpoint'].filter(Boolean).join(' and ') || 'no endpoints'}${d.pkceMethods?.length ? `; PKCE ${d.pkceMethods.join(', ')}` : ''}`);
                })
              }
            >
              Discover endpoints
            </button>
          </div>
          <div className="rb-grid">
            {edit.profile.grant === 'authorization_code' && field('authUrl', 'Authorization URL', 'https://.../authorize')}
            {field('tokenUrl', 'Token URL', 'https://.../token')}
            {field('clientId', 'Client ID')}
            {field('clientSecret', 'Client secret', 'none for a public client', 'password')}
            {field('scope', 'Scope', 'openid profile api:read')}
            {field('audience', 'Audience', 'optional')}
            {edit.profile.grant === 'authorization_code' && field('redirectUri', 'Redirect URI', 'registered with the server')}
            {edit.profile.grant === 'password' && field('username', 'Username')}
            {(edit.profile.grant === 'password' || edit.profile.grant === 'refresh_token') && field('password', edit.profile.grant === 'password' ? 'Password' : 'Refresh token', '', 'password')}
            {edit.profile.grant === 'authorization_code' && field('extraAuthParams', 'Extra sign-in parameters', 'prompt=login&acr_values=...')}
            {field('extraTokenParams', 'Extra token parameters', 'resource=...')}
          </div>
          <div className="rb-row">
            {edit.profile.grant === 'authorization_code' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={edit.profile.pkce !== false} onChange={(e) => setEdit({ ...edit, profile: { ...edit.profile, pkce: e.target.checked } })} /> PKCE
                </label>
                <select className="input" aria-label="PKCE method" value={edit.profile.pkceMethod ?? 'S256'} onChange={(e) => setEdit({ ...edit, profile: { ...edit.profile, pkceMethod: e.target.value as 'S256' | 'plain' } })}>
                  <option value="S256">S256</option>
                  <option value="plain">plain</option>
                </select>
              </>
            )}
            <label className="check">
              Client secret goes
              <select className="input" aria-label="Client authentication" value={edit.profile.clientAuth ?? 'basic'} onChange={(e) => setEdit({ ...edit, profile: { ...edit.profile, clientAuth: e.target.value as 'basic' | 'body' } })}>
                <option value="basic">in a Basic header</option>
                <option value="body">in the form body</option>
              </select>
            </label>
            <span style={{ flex: 1 }} />
            <button className="btn small primary" disabled={busy || !edit.profile.name} onClick={save}>
              Save profile
            </button>
            {edit.previous && (
              <button
                className="btn small"
                onClick={() =>
                  run(async () => {
                    await client.deleteOAuth(edit.previous!);
                    setEdit(null);
                    await load();
                  })
                }
              >
                Delete
              </button>
            )}
            <button className="btn small" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
          <div className="faint rb-note">Secrets and tokens are saved encrypted with the OS keyring when there is one. The redirect back from the sign-in is answered by SiteInquisition only while a sign-in waits, and only for its own state.</div>
        </div>
      )}

      <div className="rb-row">
        <button className="btn small" onClick={() => void client.pkce().then(setPkce, (e: Error) => notify(e.message))}>
          New PKCE pair
        </button>
        {pkce && (
          <span className="mono rb-note" style={{ userSelect: 'all' }} aria-label="PKCE pair">
            verifier {pkce.verifier} · challenge ({pkce.method}) {pkce.challenge}
          </span>
        )}
      </div>
    </div>
  );
}
