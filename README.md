# SiteInquisition

An intercepting proxy, built-in browser and replay toolkit for testing websites, APIs and IoT devices before they are finished. It runs on Linux (x64) and Windows (x64). It is MIT licensed.

This repository contains the core engine, the `siq` CLI and the desktop app. The full design is in the [design spec](https://claude.ai/artifact/HyHcJe2h7r7iCqLT3PmyEM). Before you use it on anything sensitive, read [Security and data](#security-and-data).

## Install

Download a release from the [Releases page](https://github.com/TTLComputer/SiteInquisition/releases):

```sh
# Debian, Ubuntu and derivatives
sudo apt install ./siteinquisition_1.0.0-beta.1_amd64.deb     # installs to /opt/siteinquisition, with siteinquisition and siq on PATH

# Anything else: unpack anywhere and run it from there
tar xzf siteinquisition-1.0.0-beta.1-linux-x64.tar.gz
./siteinquisition-1.0.0-beta.1-linux-x64/siteinquisition
./siteinquisition-1.0.0-beta.1-linux-x64/bin/siq --help
```

On Windows, unzip `siteinquisition-1.0.0-beta.1-win-x64.zip` anywhere you can write (for example `%LOCALAPPDATA%\Programs`) and run `SiteInquisition.exe`. For the CLI, add the folder's `bin` to your PATH, or run it directly:

```bat
siteinquisition-1.0.0-beta.1-win-x64\bin\siq --help
```

The Windows build is a portable zip with no installer, and it is not code signed yet, so SmartScreen may warn the first time you run it ("More info", then "Run anyway").

The tarball's Chromium sandbox helper (`chrome-sandbox`) needs to be owned by root and setuid to work; the .deb sets that up. Without it, run with `--no-sandbox` only on a machine you trust.

To uninstall: `sudo apt remove siteinquisition`, or delete the unpacked folder. Your projects and the CA stay behind: remove the CA from every device that trusts it first ([CA trust and removal](docs/ca-trust.md)), then run `siq ca remove` and delete the data folder (`~/.config/siteinquisition` on Linux, `%APPDATA%\SiteInquisition` on Windows) and your project folders.

## What works today

- HTTP/1.1 and HTTP/2 proxy on one port. It accepts plain HTTP, `CONNECT` tunnels and SOCKS5.
- HTTPS interception with a per-install root CA, for in-scope hosts only. Out-of-scope TLS is tunnelled untouched.
- WebSocket capture, with every frame recorded in both directions.
- **MQTT** 3.1, 3.1.1 and 5.0 relay: devices connect to SiteInquisition as their broker, every byte is passed to the real broker unchanged, and each packet (CONNECT, SUBSCRIBE, PUBLISH, acks, ...) is recorded with topic, QoS, retain flag, properties and payload. TLS is supported on both sides, with device-facing certificates signed by the project CA.
- **Scope rules** (host glob, port, scheme, path prefix) that decide what is decrypted and what is recorded. A new project records nothing until you add a host.
- Redirect chains linked into a single flow.
- A capture database in SQLite (`node:sqlite`) with text search (any part of a word) over URLs, request and response headers, and decoded bodies (gzip, deflate, brotli, zstd).
- An append-only change log with ULID ids on every row, ready for the planned multi-user and replication work.
- A core API (JSON-RPC 2.0 over a token-protected local WebSocket) with live change notifications.
- By default the proxy and MQTT listeners bind to 127.0.0.1. With `--lan` they listen on every interface, but each new device is refused until you allow it (title bar chip, Settings, `siq lan allow 192.168.1.42`, or `--lan-allow 192.168.1.0/24`).
- **Desktop app** (Electron): History with the search syntax, quick filters, saved views, site map and live follow; an inspector for requests, responses, WebSocket frames and MQTT packets; replay tabs with a raw editor, send history and a diff against the original; one-click replay from any row (Replay pill, Ctrl R, double click, right-click menu, or drag onto the tab bar) and "Resend now" (Ctrl Shift Enter); a scope editor with "seen but not in scope" hosts and certificate pinning warnings; theme that follows the system.
- **Built-in browser**: Chromium tabs inside the app on their own proxy listener (traffic recorded as source `browser`, localhost included), trusting the project CA only for intercepted hosts; address bar scope badge, one-click "add this host to scope", DevTools, and a live traffic feed with replay links.
- **Timeline**: exchanges on a time axis grouped by host, flow or client connection, with WebSocket and MQTT messages as ticks and replays dashed; drag a range to filter History (`since:` / `until:`).
- **Endpoint coverage** (History, Coverage): every method and path template seen per host (ids collapsed to `{n}`, `{uuid}`, `{token}`...), with call counts, statuses, query and body parameters, content types and the slowest call; endpoints that never succeeded; and paths the app's own HTML, scripts and JSON mention that nobody has requested yet. Copy it as Markdown for a first draft of API docs.
- **Codec workbench**: paste or send anything (Ctrl D on any selection, or Decode on a body), detect its layers (url, base64, hex, gzip, JSON, JWT, form...), edit the innermost one with a JSON tree and JSONPath bulk edits (set, increment, swap type, flip, append, delete), find and replace through every layer with a live count, insert tokens, and put the result back into the replay it came from. Application-protocol decoders read Socket.IO/Engine.IO frames, SignalR hub messages, ASP.NET ViewState (ObjectStateFormatter, flagging MAC protection), and schemaless protobuf and gRPC bodies (field tree, with gRPC framing).
- **Tokens** in replays, rules, mocks, macros and flows: `{{cookie:name}}`, `{{cookie:name@domain}}`, `{{var:name}}`, `{{uuid}}`, `{{now}}`, `{{random:16}}`, and batch tokens `{{counter:1..100}}` and `{{list:a,b,c}}` (or a file) that send once per value. Replay previews what they resolve to.
- **Technology awareness**: 86 built-in signatures recognize the cloud, CDN, hosting, web server, framework, auth provider and protocol behind each host (AWS, Cloudflare, Azure, Google Cloud, Vercel, Django, Rails, Laravel, Spring, ASP.NET, Next.js, Cognito, Keycloak, gRPC, Socket.IO, SignalR and more), passively from captured traffic, with confidence and evidence. When it guesses wrong you can reject a technology for a host (or a host glob), pin one it missed, turn a signature off for the project or add your own as JSON. Platform cookies such as `AWSALB` and `__cf_bm` are flagged and hidden in the cookie jar by default. Suggested checks (for example `GET /actuator` on Spring) are only ever sent when you click them.
- **JWT and auth**: a bearer JWT on a request is decoded in the Inspector with its claims and expiry, and flagged for risky shapes (`alg: none`, a symmetric algorithm, `jku`/`x5u`/`jwk` header keys, a `kid` that could be injectable, no expiry, long-lived, expired). You can edit the payload and re-sign it with an HMAC secret or a stored private key (HS/RS/PS/ES/EdDSA, all on `node:crypto`), and test whether a token is signed with a known or leaked secret. Signing keys are held for the session only, behind a `KeyResolver` the coming key store will implement.
- **AWS requests**: the Inspector shows AWS-specific details: the operation an `X-Amz-Target` call makes (otherwise every call is a POST to `/`), the S3 bucket and key, the API Gateway id and stage, and for a presigned URL how long until it expires, with a warning once it has. SigV4 signing (by profile or matched automatically) re-signs after an edit, from Replay.
- **Server errors**: 43 signatures recognize errors that leak into responses: SQL errors (MySQL, PostgreSQL, SQL Server, Oracle, SQLite, ORMs), MongoDB errors, template, XML, shell, file, LDAP and deserialization errors, unhandled exceptions, stack traces (Python, Java, .NET, Node.js, PHP, Ruby, Go) and framework debug pages (Django, Werkzeug, Rails, Laravel, Symfony, ASP.NET, Spring, Express, Tomcat). Flagged rows carry the error kind in History, `error:sql`, `error:high` and `error:any` filter for them, and the Inspector names the part of the request that most likely caused each error, with the reasons: the error quotes that value or names that field, the value changed from the original of a replay or from similar requests that did not fail, or it holds characters that break that kind of interpreter. An error that names its database adds that database to the host's technologies.
- **CSRF tokens**: the Tech and CSRF tab shows where a request carries a CSRF token and which response handed it out (a double-submit cookie, a meta tag, a hidden field, a header or JSON). One click keeps it fresh: the latest token is captured into a variable, and replays with "Fresh CSRF token" put it in, load a page for a new one when none is known, and retry once when the server answers 400, 403, 419 or 422.
- **Replay options**: fresh cookies from the jar, fresh CSRF tokens, apply match and replace rules, log in again on 401/403 with a login macro, follow redirects, sign with AWS SigV4 (by profile or matched automatically), ignore TLS errors.
- **Match and replace** on requests and responses (URL, header, body through a codec chain or a JSONPath, status), with hit counts and a test against the selected exchange; **mocks** made from any recorded response; **breakpoints** that pause requests or responses for editing, shown in the title bar wherever you are.
- **Race**: line up requests with millisecond offsets and fire them with last-byte sync (HTTP/1.1), single-packet (HTTP/2) or plain timers, repeated, with per-run spreads and differing outcomes highlighted.
- **Streams**: WebSocket and MQTT connections with a composer. WebSocket messages go out on a replay connection that copies the captured one's URL, cookies and headers; MQTT messages are injected into a live session towards the broker or the device.
- **Scripts**: hooks on live traffic (with a time budget and stats), test suites with `test()` and `expect()`, one-off scripts and a console, all with the `siq` SDK (search, send, resend, race, cookies, variables, tags, macros). Scripts run in a separate process that the app can kill, so a stuck script cannot freeze the proxy. By default that process is sandboxed with Node's permission model (no files, no programs, no native code). Each script has a Sandbox switch; turning it off gives the script `require` and `process` with your rights, and is trusted only on the computer where you turned it off. A project from someone else asks again. SDK calls are synchronous (`siq.search(...)`), except those that go to the network, which return promises (`await siq.send(...)`).
- **Login macros, variables and extractors**: record the login requests once; extractors keep variables such as a CSRF token or access token current from responses.
- **MCP server** for agents such as Claude Code: search and read traffic, endpoint coverage, decode, cookies, scope, and (with approval) replay, resend, tag, add scope hosts and run scripts. Approvals appear in the title bar: approve once, for 10 minutes, deny, or open the request in Replay instead. Agents' scripts always run sandboxed, and running one always asks. Connect with `claude mcp add siteinquisition -- siq mcp --project <dir>` or over HTTP at `/mcp` on the core API port.
- **API understanding** (API view):
  - **Values** lists every field the API hands out in JSON, by endpoint and JSONPath, with ids and numbers first and sample values. Copy `{{pick:GET /api/products $.items[*].sku}}` to always use the newest recorded value, or `{{each:...}}` to send once per value.
  - **Where from?** on a selected value (the Inspector, or Values) finds the earlier response that first handed it out.
  - **Tag references**: right-click a History row, then *Set reference tag (create or move)*, type a new name or pick an existing one, then use `{{$my-tag.PO_number}}` in any request. The field can be a key name, a JSONPath, `header.Name`, `query.name` or `@status`. Moving the tag to another request updates every reference.
  - **Flows**: named multi-step setup ("log in, create a PO") that keeps values from each response (`$.order.number`, `number`, `header.Location`, `cookie.sid`) and can run script steps with `vars`. Use `{{flow:create-po.po}}` in any request, batch or race, and every send runs the flow for a fresh value. A flow can also be the login that runs on 401/403. To build one, pick the requests you made by hand in History and press *Make flow*: values passed from one response to the next request are wired for you, and client-made UUIDs become `{{uuid}}`.
  - **Pipes and encoded bodies**: `{{var:po | base64}}`, `| url`, `| json`, `| jsonesc`, `| hex`, `| upper`. Replay and flow steps can keep a body decoded and encode it with a codec chain (for example `base64,json`) after the tokens are filled in.
  - **API files**: import OpenAPI 3, Swagger 2 (JSON or YAML), Postman v2.1 collections, or a HAR file (added to History). Coverage then marks undocumented endpoints and lists the documented ones nobody has called. *Open in Replay* fills path parameters from real recorded calls. **Export OpenAPI** writes an OpenAPI 3.1 file from what was seen, with schemas inferred from real bodies.
  - Scripts get `siq.flows.run()`, `siq.pick()`, `siq.origin()`, `siq.tagged()`, `siq.moveTag()`, `siq.resolve()` and `siq.specs()`. MCP gets `api_values`, `value_origin`, `tag_value`, `api_specs`, `list_flows` and `run_flow`.
  - **Contract check**: each exchange that matches an endpoint in an API file is checked against its schema (types, required fields, enums, formats, ranges, undocumented fields and statuses). The Inspector shows the result, and API files, Contract check scans a whole host.
  - **GraphQL**: get a schema by introspection, from a different server than the one you test (pull it from a beta server with introspection on and point the requests at pre-prod, each with its own headers), by rebuilding it from "Did you mean" errors when introspection is off, or from the operations the app sent (including persisted query hashes and queries in loaded scripts). *Check drift* lists fields the target rejected.
  - **Auth matrix**: send requests again as each identity (other users' headers, or no auth). An identity that gets the same data back is flagged as possible broken access control.
  - **Negative tests**: broken variants of a request (wrong types, missing and extra fields, huge and special values, other ids), using the API file's schema when there is one. Server errors and accepted bad input come first.
  - **Compare**: mark one request in History and compare another with it: URL, query, headers and JSON bodies by path.
  - **Resources**: list, create, read, replace, update and delete per resource, from traffic and API files, so the untested operations stand out.
  - **Glossary**: every field name with its types, nullability, values seen (an enum in all but name), ranges, lengths and formats.
  - **Endpoint notes**: notes and tags on an endpoint (Inspector, Notes) are shared and shown on every call to it.
  - **Export**: copy a request as curl, export History (by filter) as HAR, a flow as a Postman collection whose test scripts pass values on, or a flow as a test script that checks every step and that ids are fresh each run.
- **Cookie jar**: every Set-Cookie seen, newest wins, with expiry highlighting, a decoded hint (url, base64, JSON, JWT), a link to the response that set it, and `{{cookie:name@domain}}` tokens to copy. A framework session cookie decodes in place: Flask, Django, Rails, Laravel and Express are named and split into parts, and a signed-but-readable payload (Flask, Django, Express cookie-session) is shown without any key, while an encrypted one (Laravel, Rails 5.2+) shows its envelope and says it needs the app key. A Flask session can be verified against a candidate secret and re-signed with a secret from the key store.

## Quick start

Requires Node.js 22.13 or later and pnpm 10. There are no native modules: storage uses the `node:sqlite` module built into Node and Electron.

```sh
pnpm install
pnpm build

# Capture traffic for one host
node packages/cli/dist/main.js proxy --include 'api.example.com' --port 8080
# then point a browser, device or tool at 127.0.0.1:8080
curl -x http://127.0.0.1:8080 --cacert "$(node packages/cli/dist/main.js ca | awk '/certificate/{print $2}')" https://api.example.com/

# Search and inspect (works while the proxy is running)
node packages/cli/dist/main.js search host:api.example.com status:>=400
node packages/cli/dist/main.js show <exchange-id>
```

### Desktop app

```sh
pnpm install
pnpm build
pnpm app                                  # opens the app; the proxy listens on 127.0.0.1:8080 (or a free port if taken)
pnpm app -- --project ~/siq/shop --lan    # choose the project folder and accept LAN devices
```

The core runs in a separate utility process, and the window talks to it over the same local API as the CLI. Projects default to the app's user data folder.

### Agents (MCP)

```sh
claude mcp add siteinquisition -- siq mcp --project ~/siq/shop   # stdio bridge to the running app or `siq proxy`
siq agent-writes allow                                          # let agents send traffic without asking (default: ask)
```

### MQTT

```sh
# Devices connect to 127.0.0.1:1883 (add --lan for real devices); traffic goes to broker.local:1883
siq proxy --include broker.local --mqtt 1883=broker.local

# TLS on both sides; devices must trust the SiteInquisition CA
siq proxy --lan --include broker.example.com --mqtt 8883=broker.example.com:8883,tls,listen-tls

siq search scheme:mqtt          # one row per MQTT session
siq show <exchange-id>          # every packet, with topics and payloads
```

The spec format is `PORT=BROKER[:PORT][,tls][,listen-tls][,insecure]`. `tls` connects to the broker over TLS, `listen-tls` accepts TLS from devices, and `insecure` skips broker certificate checks. Scope rules apply to the broker host, as they do for HTTP. DNS-based and transparent redirection of MQTT come later; for now, point devices at the relay.

Projects live in `./.siq` by default; use `-p <dir>` to choose another folder. The CA is stored per user in `~/.config/siteinquisition/ca`. You can override this with `SIQ_DATA_DIR`.

### Storage and retention

```sh
siq delete host:ads.example.com          # delete what a search matches
siq clear --yes                          # delete all recorded traffic (scope, rules and scripts stay)
siq prune --older-than 30 --max-size 2000 --keep   # delete now, and keep doing it every hour
```

In the app: right-click a row (or press Delete), *Delete matching* in History, and Settings, Storage.

### Search syntax

| Filter | Example |
| --- | --- |
| `host:` (glob) | `host:*.example.com` |
| `method:` | `method:POST` |
| `status:` | `status:404`, `status:>=400`, `status:5xx`, `status:200-299` |
| `path:` (prefix or glob) | `path:/api/`, `path:/v*/users` |
| `url:` (substring) | `url:token=` |
| `req:` / `res:` (one side, headers and body) | `res:"stack trace"`, `request:apikey` |
| `reqbody:` / `resbody:` | `reqbody:password`, `resbody:"\"admin\":true"` |
| `reqheader:` / `resheader:` (as `name: value`) | `reqheader:"authorization: bearer"`, `resheader:"server: nginx"` |
| `body:` / `header:` (either side) | `body:"session expired"` |
| `resjson:` / `reqjson:` / `json:` (JSONPath, then `=` `!=` `~` `!~` `>` `>=` `<` `<=`, or just the path) | `resjson:$.order.status=open`, `reqjson:"$.payload['some_value']~abc"`, `json:$.items[*].qty>=2` |
| a bare JSONPath (the field is in either body) | `$.payload.user` |
| Replay tokens in any value, filled in first | `{{$order.number}}`, `resbody:{{var:userId}}`, `reqjson:$.sku={{pick:/api/products $.items[*].sku}}` |
| `ws:` `source:` `state:` `scheme:` `tag:` `flow:` `replayof:` | `ws:true`, `tag:bug-123`, `source:browser` |
| `error:` (server error kind, signature id or severity; `any`) | `error:sql`, `error:high`, `error:any` |
| `tech:` (technology id or name, after your corrections) | `tech:django`, `tech:aws`, `-tech:cloudflare` |
| `since:` / `until:` (epoch ms or ISO time) | `since:2026-11-04T09:30 until:2026-11-04T10:00` |
| free text (URL, headers and bodies) | `"invalid signature"`, `PO-77` |

Text matches any part of a word and ignores case, so `PO-77` finds `PO-7781` and `csrf_tok` finds `csrf_token`. Bodies are searched after Content-Encoding is undone, up to the first 1 MB. JSON filters also look inside fields that hold encoded JSON, so `$.payload.user` works when `payload` is base64 of JSON. Prefix any filter with `-` to negate it, as in `-status:304`. In the app, **Build search** next to the filter writes a query for you and shows how many requests match, and the Inspector highlights the matches and steps through them.

### Scope

Examples use `siq` for brevity. From a checkout, run `pnpm siq ...` or `node packages/cli/dist/main.js ...`.

```sh
siq scope add '*.example.com'               # decrypt and record
siq scope add login.example.com --exclude   # never record (first match wins, so list exclusions first)
siq scope add cdn.example.com --no-decrypt  # leave its TLS alone (only plain HTTP to it is recorded)
siq scope                                    # list rules
```

TLS interception is decided per connection, before the path is known. A host is decrypted when any include rule for it asks for decryption. Changing the set of decrypted hosts restarts the proxy listener on the same port.

## Security and data

- **Captured traffic is sensitive.** It holds cookies, tokens and passwords as they were sent. Project folders are created readable only by you (0700, database 0600). The database itself is not encrypted, so keep projects on an encrypted disk; Settings, Storage warns when the project folder is not on one (LUKS/dm-crypt, also under LVM, or eCryptfs on Linux; BitLocker on Windows). On Windows the folders use your user's default permissions rather than 0700/0600, which in your profile means only you and administrators can read them.
- **Secrets at rest.** With an OS keyring (on Linux, GNOME Keyring or KWallet through `secret-tool`, package `libsecret-tools`; on Windows, DPAPI for your user account), the CA's private key and saved identities are encrypted with a master key kept in the keyring. Without one they are files only you can read, and Settings says so.
- **The CA** can sign a certificate for any site, for every device that trusts it. New CAs last two years. Install it only where you need it, and remove it when you are done: [CA trust and removal](docs/ca-trust.md). `siq ca rotate` replaces it.
- **Scripts and agents**: see the Scripts and MCP notes above, and [SECURITY.md](SECURITY.md) for what the sandbox does and does not stop.

## Repository layout

```
packages/
  codecs/  chainable encoders and decoders (url, base64, hex, gzip, deflate, br, zstd, json, Socket.IO, SignalR, ViewState, protobuf, gRPC, ...)
  core/    proxy, MQTT relay, scope, capture store, search, core API
  cli/     the siq command
  ui/      React renderer (runs in the app, or in any browser for development)
  app/     Electron shell: hosts the core in a utility process and loads the renderer
```

## Development

```sh
pnpm build   # type-checks and compiles every package
pnpm test    # unit and integration tests; spins up local HTTP, HTTPS and WebSocket servers
pnpm test packages/core -t 'frame plans'   # only matching files and test names
```

The UI tests drive the built renderer in Chromium against a real core. They need `pnpm build` first and a Chromium or Chrome, which `@siteinquisition/devkit/browser` drives over the DevTools protocol. It looks at `SIQ_CHROMIUM`, then `chromium`, `google-chrome` and similar on `PATH`; without one the UI tests are skipped. Set `SIQ_SCREENSHOTS=dir` to save screenshots.

To work on the renderer in a normal browser, start a proxy with `siq proxy`, read the API port and token from `core.json` in the project folder, run `pnpm --filter @siteinquisition/ui dev` (rebuilds on save and reloads the page) and open `http://127.0.0.1:5173/?api=ws://127.0.0.1:PORT&token=TOKEN`.

The test runner and the renderer bundler are in `packages/devkit`. Tests use the vitest API (`describe`, `it`, `expect`, hooks, `.each`, `.skipIf`, `expect.poll`), imported from `@siteinquisition/devkit/test`. Each test file runs in its own process, and TypeScript is compiled with `transpileModule`, so tests are not type-checked.

Packaging: `pnpm package` writes the unpacked app, a .tar.gz and a .deb to `release/`, without electron-builder. `pnpm package --platform win32` writes `release/win-unpacked` and the Windows zip, and works from Linux too (it downloads Electron's Windows build and checks it against Electron's checksums, or uses `SIQ_ELECTRON_WIN32_ZIP`). On Windows, `pnpm smoke release/win-unpacked/SiteInquisition.exe` runs the same smoke test without xvfb. `pnpm smoke release/linux-unpacked/siteinquisition` starts the packaged app headless under `xvfb-run`, checks that a script runs and the sandbox holds, loads a page in the built-in browser, and exits. `SIQ_SMOKE_SCREENSHOT=/tmp/siq.png` saves a screenshot. `node scripts/notices.mjs` regenerates THIRD_PARTY_NOTICES.md after a dependency change.

CI runs only for release tags (`v*`) or when started by hand from the Actions tab, to conserve Actions minutes. A tag builds, tests, packages and smoke-tests, then publishes a GitHub release with the notes from CHANGELOG.md. Run the build and tests locally before pushing.
