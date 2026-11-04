# SiteInquisition UI design

Status: draft for review (2026-11-04), with Nick's first round of feedback applied. This is the plan for milestone 2 (main UI) and the screens milestone 3 and 4 features will plug into.

Clickable mockups of every screen are on the design canvas: <https://claude.ai/artifact/QJcBw4vBWTVWNdYk8BXi7j>. The product spec is at <https://claude.ai/artifact/HyHcJe2h7r7iCqLT3PmyEM>.

## Principles

1. **One selection, many views.** Selecting an exchange anywhere (History, Timeline, Browser feed, Race results) makes it the current exchange. The inspector, "Send to replay", "Add to race" and "Make rule" all act on it.
2. **Everything is a core API call.** The renderer holds no traffic state of its own. Views query the core and redraw from the `change` event stream. That is also what makes 2 to 3 person sharing cheap later: another person's actions arrive as the same events.
3. **Raw first, decoded on top.** Every body view shows a codec layer breadcrumb (`body › json .cart › base64 › json`). Editing an inner layer re-encodes outward. Rules, replays and scripts address the same layers.
4. **Replay is always one action away.** See [Sending to replay](#sending-to-replay).
5. **Keyboard first.** Ctrl K palette, Ctrl R send to replay, Ctrl Enter send, Ctrl Shift Enter resend without opening the editor, Ctrl Shift R add to race, Ctrl D decode selection, F8 forward a paused request.
6. **Dense but legible.** The theme follows the system setting by default (dark and light can be forced in Settings), 13px Inter for UI, 12px JetBrains Mono for anything that is traffic. Colour is never the only signal: status codes also show the number, methods show the verb.

## App shell

```
┌ Title bar ─────────────────────────────────────────────────────────────────┐
│ logo · project ▾ · ● 127.0.0.1:8080 Recording · Scope: 3 hosts · [Ctrl K]  │
│                                          · agent approval chip · people    │
├ Nav rail ─┬ Workspace tabs (History | Replay: apply-coupon | Race | …) ────┤
│ Browser   │                                                                │
│ History   │  Active view                                                   │
│ Timeline  │                                                                │
│ Replay    │                                                                │
│ Race      ├ Inspector (History only, resizable) ──────────────────────────┤
│ Rules     │  Request and response · Decoded layers · Timings ·           │
│ Codecs    │  Rules applied · Notes and tags                               │
│ Cookies   │                                                                │
│ Streams   │                                                                │
│ Scripts   │                                                                │
│ Settings  │                                                                │
│ ──────    │                                                                │
│ Saved     │                                                                │
│ views     │                                                                │
└───────────┴────────────────────────────────────────────────────────────────┘
```

- **Title bar**: project switcher, recording toggle with listener address, scope summary (links to Rules › Scope), command palette, the pending-agent-approval chip (only when something is waiting), and people present (after v1; for now just you plus "Invite" disabled or hidden).
- **Nav rail**: 11 destinations with counts, saved views (named filters) under them, and a small capture summary at the bottom.
- **Workspace tabs**: History, Replay and Race documents open as tabs so several replays can sit side by side. Browser tabs are separate (they live inside the Browser view).
- Below 900px wide the nav rail stacks above the workspace and split panes stack vertically. This is mostly for small laptop windows; there is no phone target.

## Screens

| Screen | Mockup board | Key parts | Core API it needs |
| --- | --- | --- | --- |
| History and inspector | History and inspector | Filter bar using the existing search syntax, quick chips (All, HTML, XHR, WebSocket, Errors, Replays), live-follow toggle, site map tree, virtualised table (source, method, host, path, status, size, time, tags; redirect hop marker), inspector tabs | `traffic.search`, `traffic.get`, `traffic.body`, `traffic.flow`, `traffic.tag`, `traffic.notes`, `events.subscribe` |
| Built-in browser | Built-in browser and intercept | Chromium tabs, address bar with scope badge (in scope / decrypting / recording), breakpoint bar with Forward, Forward and pause response, Drop, Forward all, editable paused body, per-tab live feed with Replay links, hint for out-of-scope hosts | new: `intercept.list`, `intercept.resolve`; browser session proxy set by the app process |
| Timeline | Timeline | Group by host, flow or connection; zoom 1s to 1h; bars coloured by status class, redirect hops linked, replay and race sends dashed, WebSocket frames and MQTT packets as ticks on their connection lane; drag a range to filter History | `traffic.search` with time range, `traffic.streamMessages` |
| Replay | Replay editor | Target and protocol, Send with history (send N of N), cookies "keep as captured" vs "refresh from jar", login macro on 401, apply rules, follow redirects, SigV4 state; editor modes Raw, Fields, Decoded body (JSON tree); placeholders like `{{var:csrf}}` highlighted; response and diff with original or previous send | new: `replay.send`, `replay.history` |
| Race | Race-timed replay | Sync method (single packet HTTP/2, last-byte HTTP/1.1, none), repeat and jitter, per-request offset lane with draggable marker and ms input, presets, results summary, planned vs actual table, run strip highlighting anomalous runs | new: `race.run`, `race.results` |
| Rules and scope | Rules and scope | Scope: ordered include/exclude list with decrypt, record, modify flags, "seen but not in scope" list with one-click add, certificate pinning warning with pass-through. Match and replace: rule list with switches and hit counts, editor (conditions, codec layer, action), live test against the selected exchange. Mocks and breakpoints tabs | `scope.get`, `scope.set`, `tls.failures`; new: `rules.*`, `mocks.*`, `breakpoints.*` |
| Codec workbench | Codec workbench and JSON editor | Find and replace (regex, match case, keys too) scoped to this layer, all layers or the whole request, with a live match count; a Token button on JSON values that opens a picker of cookie jar values, variables and generators; input, auto-detected chain, step list with per-step preview, save or bind a chain to a host and parameter, re-encoded output; JSON tree or text with JSONPath bulk operations (set, increment, swap type, flip booleans, append) | `codecs` package runs in the renderer directly; new: `codecs.saveChain` |
| Cookies and auth | Cookie jar and auth | Domain list, cookie table with decoded-chain hint, expiry highlighting, link to the exchange that set it; login macros with trigger conditions and run log; token extraction variables; AWS SigV4 credentials (named profile or encrypted key) and parsed signature of the selected request | new: `cookies.*`, `macros.*`, `vars.*`, `aws.*` |
| WebSocket and MQTT | WebSocket and MQTT | Connection list (kind, state, client), message table (direction, time, opcode or packet type, topic/QoS/retain, size, preview), decoded payload, composer: WS frame to server or client, MQTT publish as the original client with topic, QoS, retain | `traffic.streamMessages`; new: `stream.send`, `mqtt.publish` |
| Scripts and console | Scripts and console | Script list (live hooks with enabled dot, test suites, one-off scripts), editor with budget stats, console REPL against the SDK, test results | new: `scripts.*`, `console.eval` |
| Settings | Settings: MCP, proxy, sharing | MCP: pending approval card (approve once, approve for 10 min, deny, open in replay first), write-action setting (ask each time is the default, or allow), stdio and HTTP connection details, agent activity log. Proxy and TLS: port, LAN, proxy modes, CA install page. Work together (after v1). Appearance and keys; links to Keys and certificates | new: `mcp.settings`, `mcp.approvals`, `mcp.decide`; `core.info` |
| Keys and certificates | Settings: keys and certificates | Key store (CAs, certificates, private keys, HMAC secrets) with owner and chain view; generator for root, intermediate, leaf, CSR, key-only and HMAC; "where keys are used" bindings with per-person overrides; team CA with KDF-derived per-person keys | new: `keys.*`, `bindings.*`, `kdf.derive` (see below) |

## Visual tokens

| Token | Value | Use |
| --- | --- | --- |
| `bg/app` | `#0E1014` | Workspace ground |
| `bg/panel` | `#11141A` | Side panels, inspector, toolbars |
| `bg/raised` | `#1C2029` | Inputs, chips |
| `bg/selected` | `#1E2A44` with `#34476F` ring | Selected row, active tab or segment |
| `line` | `#2A2F3A` | Borders and dividers |
| `text` | `#E7E9EE` | Primary text |
| `text/muted` | `#A0A8B6` | Secondary text |
| `text/faint` | `#8A93A2` | Small labels (passes 4.5:1 on panel) |
| `accent` | `#7AA2F7` | Primary actions, GET, focus ring |
| `warn` | `#F2A65A` | POST, 4xx, breakpoints, approvals |
| `ok` | `#7BD88F` | 2xx, enabled |
| `error` | `#F28B82` | 5xx, failures, deletions in diffs |
| `stream` | `#6FD3D0` | 3xx, WebSocket and MQTT |
| `script` | `#C3A6FF` / `#D8C6FF` | Tags, variables, scripts, MCP source |

The light theme maps every token to a light value (for example `bg/app` `#F6F7F9`, `bg/panel` `#FFFFFF`, `text` `#1B1F27`, `accent` `#2F5FCC`, `warn` `#A2560A`). The canvas has History, the title bar and the nav rail in light. The app follows `prefers-color-scheme` (Electron `nativeTheme`) and switches live; Settings › Appearance can force dark or light.

## Interaction notes

### Sending to replay

Every place an exchange appears can send it to replay in one action:

- A **Replay** pill on every History row (always visible, not hover-only).
- **Ctrl R** on the current selection in any view, and the right-click menu on any row, timeline bar, browser feed entry or stream message.
- **Drag** a row onto the Replay tab, or onto an open replay to replace its request.
- The right-click menu also offers "Send to replay, cookies from jar" and "Resend now", which sends a copy without opening the editor and puts the result in History.
- Replay tabs are workspace tabs (confirmed); a new send opens a new tab unless the exchange is already open.

### Tokens

Tokens are placeholders resolved when a request is sent. They can sit anywhere: URL, header, cookie, or inside any decoded layer, including JSON values in the codec workbench and in the replay editor.

| Token | Value at send time |
| --- | --- |
| `{{cookie:session}}` | Cookie from the jar for the request's host |
| `{{cookie:session@shop.example.com}}` | Cookie from a named domain |
| `{{var:csrf}}` | Variable from a token extraction rule or a script |
| `{{uuid}}`, `{{now:iso}}` | Generators |
| `{{counter:1..100}}`, `{{list:ids.txt}}` | Batch generators: one send per value |

In the JSON tree a value holding a token shows as a purple pill with its current resolved value underneath. The Token button and the find and replace field both accept tokens, so "replace every `3b9a0c11` with `{{var:csrf}}`" works across layers. Codec chains re-encode with the resolved value at send time; the workbench output shows the current value.

### Keys and certificates

Settings › Keys and certificates is the one place to create, import and assign every key the app uses.

**Key store.** Grouped into certificate authorities, certificates, private keys, and HMAC and signing secrets. Each entry shows its owner (project, or a person), its chain (root → intermediate → leaf), validity, and everything that uses it. Actions: issue from this CA, renew with the same key, export, rotate. Import accepts PEM, DER, PKCS#12, JWK and OpenSSH; export offers the same, with a passphrase for private keys. Private keys are encrypted at rest (Electron `safeStorage`, falling back to a project passphrase).

**Generator.** One form for root CA, intermediate CA, leaf, CSR, key only, or HMAC secret, with presets (TLS server that browsers accept, mTLS client, long-lived IoT device, and deliberately broken ones: expired, wrong SAN). Options:

| Area | Options |
| --- | --- |
| Key | ECDSA P-256 or P-384, Ed25519, RSA 2048, 3072 or 4096; new random key, reuse an existing key, derive from the team secret, or sign a CSR; signature hash SHA-256, 384, 512, or SHA-1 for legacy tests; owner |
| Subject | CN, O, OU, C, ST, L, email |
| SANs | DNS (including wildcards), IP, URI, email; fill from hosts in scope. These are what SNI and browsers check |
| Key usage | All nine bits, with a critical flag |
| Extended key usage | serverAuth, clientAuth, codeSigning, emailProtection, timeStamping, OCSPSigning, or any custom OID |
| Serial | Random 128-bit (default), next in sequence for the issuer, custom hex, or a duplicate of an existing serial for negative tests |
| Validity | Not before and not after, relative or absolute; back-dated or expired on purpose |
| Issuer | Any CA in the store, or self-signed |
| More | Basic constraints (CA, path length), name constraints, CRL, OCSP and AIA URLs served by the core at `http://siq.local/pki/`, must-staple, certificate policies, raw extensions by OID |

A live check under the form says whether the result will be accepted by Chrome and Android (SAN present, 397 days or less, serverAuth), so a broken certificate is always a choice.

**Where keys are used.** A table of uses, each with a scope, a project default and an optional override per person:

- Proxy interception CA (signs the on-the-fly leaf certificates)
- Pinned server certificate for a host, instead of an on-the-fly one
- Client certificate (mTLS) presented upstream for a host
- HMAC steps in codec chains and rules, for example `X-Signature` on `POST /api/webhooks/*`
- JWT re-signing keys
- AWS SigV4 credentials
- The CA offered on the device setup page

Resolution is most specific first: the sending person's override, then the project default for that scope, then the project-wide default. Codec steps, rules and scripts name a binding, not a key: the HMAC step's key field takes `{{key:webhook-signature}}`, which resolves to whichever key applies to the person sending. So two people with different keys can share one rule set.

**Team CA and key derivation (for multi-user, after v1).** The owner creates a team root CA (name-constrained to the project's hosts) and installs it on devices once. Each person gets an intermediate CA and their own HMAC keys, derived from the team secret with a KDF using context `siq/v1/{person}/{purpose}` and the project id as salt. Supported KDFs: HKDF-SHA256 (default, for a strong random team secret), Argon2id and scrypt (when the secret is a passphrase), and PBKDF2-HMAC-SHA256 (compatibility). Derivation is deterministic, so a member can recreate their keys on a new machine from the secret alone. Devices trust everyone through the root, while each person's traffic is signed by their own intermediate, so captures and signatures show who made them.

**Building on the in-house certificate code.** PR #9 replaces mockttp with `packages/core/src/x509.ts` (hand-written DER, RSA with SHA-256, a root CA and a `LeafIssuer`). This screen needs that module extended with: EC (P-256, P-384) and Ed25519 keys; intermediate CAs and sending the full chain in the TLS handshake; all SAN types; key usage, extended key usage, basic constraints with path length, name constraints, SKI and AKI; serial policies; arbitrary extensions by OID; and CSR parsing. `LeafIssuer` takes its issuer from the binding for the person whose core is capturing. New core API: `keys.list`, `keys.get`, `keys.generate`, `keys.import`, `keys.export`, `keys.delete`, `bindings.list`, `bindings.set`, `kdf.derive`. PKCS#12 and JWK import and export can use `node:crypto` where it supports them, so no new dependency is needed.

### Other notes

- **Approval for agent writes** appears in two places: a chip in the title bar (visible from every screen) and a full card in Settings › MCP. Approving runs the request immediately and the result appears in History with source `mcp`.
- **Breakpoints** pause inside the Browser view when the paused request came from a browser tab, and in Rules › Breakpoints otherwise. A queued count shows on "Forward all".
- **Placeholders** (`{{counter:1..100}}`, `{{list:ids.txt}}`, `{{uuid}}`, `{{now:iso}}`, `{{var:csrf}}`) render as purple pills in the raw editor, with their current or next value in a footer.
- **Diffs** are line based on the decoded layer, not the raw bytes, with a "Compare with" picker (original, previous send, any exchange).
- **Scope first-run**: a new project records nothing, so History shows an empty state pointing at Rules › Scope and listing hosts already seen.

## Multi-user readiness (after v1)

The shell already reserves space for it: people in the title bar, a "Work together" settings page, and a presence ring on selected rows and shared replay tabs. Nothing in v1 renders other people, but every view must redraw from the event stream rather than from local optimistic state, so a second client works without UI changes.

## Decisions

- Theme follows the system by default (2026-11-04).
- Replay and Race are workspace tabs, as mocked (2026-11-04).
- Keys and certificates get their own Settings page with per-person bindings and KDF-derived team keys (2026-11-04).

## Open questions for review

1. Is a per-browser-tab traffic feed worth the space, or should the Browser view be full width with History one click away?
2. MCP approvals: is "approve for 10 minutes" the right middle option, or should it be "approve this tool for this session"?
