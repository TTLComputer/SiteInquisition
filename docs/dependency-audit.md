# Dependency audit (2026-11-04)

Goal: fewer packages, shallower chains, and no package we only use a sliver of.
Counts are unique `name@version` entries in the pnpm tree (`pnpm -r list --json --depth Infinity`).
"Shipped" means production dependencies of core, cli, app and ui, which is what users run.

## Summary

| | Before | After round 1 | After replacing mockttp |
|---|---|---|---|
| Shipped packages | 196 | 182 | 8 |
| All packages, dev included | 372 | 330 | 162 |
| Deepest shipped chain | 9 | 9 | 3 (react-dom > loose-envify > js-tokens) |

## Where the packages come from

| Direct dependency | Kind | Tree | Only it brings | Deepest chain |
|---|---|---|---|---|
| mockttp | shipped, core | 175 | 159 | 9: mockttp > express > qs > side-channel > side-channel-map > get-intrinsic > get-proto > dunder-proto > es-errors |
| vitest | dev | 117 | 65 | 4 |
| vite + @vitejs/plugin-react | dev, ui | 70 | 1 | 5 |
| mqtt (client, tests only) | dev, core | 44 | 18 | 6: mqtt > worker-timers > worker-timers-worker > worker-factory > fast-unique-numbers > @babel/runtime |
| aedes (broker, tests only) | dev, core | 27 | 7 | 6 |
| mqtt-packet | shipped, core | 19 | 11 | 5 |
| electron | dev, app | 13 | 9 | 4 |
| https-proxy-agent, undici (tests only) | dev, core | 6 | 3 | 3 |
| react, react-dom | shipped, ui | 5 | 5 | 3 |
| commander, ulid, ws, @fontsource/* | shipped | 1 each | | 1 |

## Round 1: small replacements

| Removed | What we used | Replacement |
|---|---|---|
| `mqtt-packet` (+ bl, readable-stream, buffer, events, process, abort-controller and 6 more) | parse both directions of a relayed session, encode injected PUBLISH | `core/src/mqttcodec.ts`, about 600 lines covering MQTT 3.1, 3.1.1 and 5.0 with properties. Same field names as before, so stored message metadata and the UI are unchanged. Checked against 31 byte vectors recorded from mqtt-packet (decode and re-encode match byte for byte), byte-at-a-time chunking, and malformed input. It also drops a reach into the library's private `_list` buffer. |
| `ulid` | `monotonicFactory()` | `core/src/ids.ts`, 40 lines, same ULID format and monotonic ordering. |
| `commander` | subcommands, options, help | `cli/src/args.ts`, about 230 lines with the same API subset, so `cli.ts` barely changed. Checked `--help`, `--version`, nested `scope` commands, `--no-decrypt`, variadic `--include`, and error messages by hand. |
| `ws` in cli (+ `@types/ws`) | two one-shot JSON-RPC calls to a running core | Node's built-in `WebSocket` client (Node 22). `ws` stays in core for the API server and WebSocket replay, which needs custom headers. |
| `aedes`, `mqtt` (dev) | a broker and a client for relay tests | `core/test/mqtt-fixtures.ts`, a small broker and client on the in-house codec. |
| `undici`, `https-proxy-agent` (dev) | fetch and WebSocket through the proxy in tests | `core/test/proxy-client.ts`, CONNECT tunnels on `node:http`. |

Tests: 139 pass (was 102; new codec and id tests). Build and typecheck are clean.

## What mockttp costs

mockttp is 175 of the 182 shipped packages that remain, and the 9-deep chain above. We use its HTTP/1.1 and HTTP/2 proxy, CONNECT and SOCKS5, per-host TLS interception with on-the-fly leaf certificates, WebSocket passthrough with frame events, timing events, body decoding, and CA generation. Most of the tree serves features we never touch:

- a GraphQL admin server for remote control (graphql, @graphql-tools/*, graphql-http, subscriptions-transport-ws, Express, cors, body-parser, the side-channel/get-intrinsic chain)
- upstream proxy support including PAC files, which bundles a JavaScript engine (@tootallnate/quickjs-emscripten, esprima, escodegen) and an FTP client (basic-ftp)
- the @peculiar ASN.1 and X.509 suite (12 packages, plus asn1js, pvtsutils, tsyringe and reflect-metadata) for certificates
- WASM brotli and zstd decoders, which Node's zlib already provides
- a native module (`tls-impersonate`, via node-gyp-build), lodash, semver, and an old readable-stream 2 with its helpers

It also has costs beyond the count: the MQTT relay imports `mockttp/dist/util/certificates`, a private path that can break on any update, and the proxy has to reach into mockttp's internal server to refuse LAN clients because mockttp has no bind option.

## Round 2: mockttp replaced

The proxy is now `core/src/interceptor.ts` (about 1,100 lines) on `node:net`, `node:tls`, `node:http` and `node:http2`, plus `core/src/x509.ts` (about 250 lines) for the CA and leaf certificates. The shipped tree is 8 packages: react, react-dom and their 3 helpers, ws, and the two font packages.

What it does:

- One port takes plain HTTP proxy requests, CONNECT tunnels, SOCKS5 and TLS sent straight to the port.
- In a tunnel, a TLS ClientHello is read for its SNI. Hosts in decrypt scope get a leaf certificate from the project CA, with HTTP/2 or HTTP/1.1 chosen by ALPN. Other hosts pass through untouched and show up under "seen, not in scope".
- WebSockets are relayed frame by frame, and the subprotocol and close codes are kept.
- Handshake failures are recorded with the same causes as before (`cert-rejected`, `closed`, `reset`), so the certificate-pinning banner still works.
- Upstream failures answer 502 and are recorded as errors rather than aborts.
- The proxy binds to the port and refuses non-loopback clients before reading a byte, without reaching into library internals. The MQTT relay no longer imports a private mockttp path.

What changed in behaviour:

- **Responses stream.** Before, every response for a host with "modify" on was buffered whole. Now only responses that a response rule, breakpoint or script could touch are buffered, so server-sent events and large downloads flow normally.
- **Upstream was HTTP/1.1 only** at first. Since then HTTP/2 goes upstream as HTTP/2, and the server decides whether a connection is HTTP/2 (ALPN, h2c upgrade, prior knowledge).
- **Gone, and can be added back small if needed:** chaining to an upstream proxy (including PAC files), SOCKS4, and TLS fingerprint impersonation toward servers.

Tests: 147 pass. New tests cover HTTP/2 in a tunnel, SOCKS5 with plain HTTP and with TLS, streaming, 502 on an unreachable server, clients that reject our certificate, WebSocket subprotocols and close codes, SNI parsing, and certificate chains for names and IP addresses. I also drove real Chromium through the proxy. HTTPS came through as HTTP/2, a `wss:` connection relayed both frames, and a POST body arrived intact, all recorded.

## Round 3: ws replaced, with frame-level tools

`ws` is gone. `core/src/websocket.ts` (RFC 6455 framing, handshakes, client and server connections) and `core/src/wsplan.ts` (frame plans and presets) replace it. The API server, the proxy relay and WebSocket replay all use them. The shipped tree is now 7 packages: react, react-dom and their 3 helpers, and the two font packages. The whole tree, dev tools included, is 160.

Owning the framing is what makes the new tools possible, since a correct library will not send a broken frame:

- **Frame plans.** A plan is a list of steps: a frame with every header field under control (opcode including reserved ones, FIN, RSV1-3, mask on, off, zero or a chosen key, 16 or 64-bit length field, a claimed length that differs from the real one, a cut-off point), raw bytes, a delay, or closing the TCP socket.
- **25 presets** build plans from a message: fragment into N parts or N-byte pieces, split inside a UTF-8 character, ping between fragments, interleave a second message, orphan continuation, never finish, slow drip, burst, invalid UTF-8, unmasked, zero mask, RSV1 without compression, reserved opcode, oversized or fragmented ping, non-minimal length, length lie, huge length, invalid close codes, a 1-byte close, an over-long reason, data after close, and drop mid-frame. Each says whether the frames are legal and what a correct server should do.
- **Replay.** Open a new connection like a captured one with an edited handshake (Origin, cookies, subprotocols), then send messages or frame plans. A whole captured session can be replayed with its original timing, each message turned into a preset's frames.
- **Live injection.** The proxy relays WebSocket bytes as they are, so fragmentation and masking reach the other side unchanged. Plans can be injected into a live browser connection toward the server (as the client) or toward the browser (as the server), between messages so the stream stays valid.
- **Recording.** Messages show how many fragments they came in, close codes, which ones we sent, and protocol violations the parser noticed (unmasked client frames, reserved bits, bad close codes, invalid UTF-8).

In the UI, the Streams composer has a Frames mode with a preset picker and an editable frame table, and the handshake can be edited before connecting.

Tests: 158 pass. New ones cover the codec, every preset, plans over replay, session replay, passthrough of fragmented frames through the proxy, injection both ways, and the Frames composer in the renderer. Real Chromium through the proxy received a 3-fragment injected message and echoed a split UTF-8 character correctly.

## Round 4: vitest and Vite replaced

`packages/devkit` holds two small tools built on TypeScript, which the repo already needs:

- **Test runner** (`siq-test`, about 950 lines). It has the vitest API, so test files only changed their import line: `describe`, `it`/`test` with `.each`, `.skip`, `.skipIf`, `.only` and `.todo`, the four hooks, per-test timeouts, and `expect` with the matchers the repo uses, including `.not`, `.resolves`, `.rejects`, `expect.poll` and asymmetric matchers. Module hooks compile TypeScript with `transpileModule`, let `./x.js` find `./x.ts`, and point workspace packages at their sources. Each file runs in its own process, several at a time. Failures print a line diff and the test's stack. `-t` filters by name, file arguments filter by path, and `--watch` reruns on change.
- **Bundler** (`siq-bundle`, about 450 lines). It reads the entry from `index.html` and compiles TS, TSX and ES modules to CommonJS with `transpileModule`. It resolves packages through `exports` maps (browser, import, default) and `main`, and applies `process.env.NODE_ENV`, dropping the `if` branches that become constant so React's development build is never included. CSS imports are concatenated in order, `@import` is inlined, and every `url()` asset is copied under a hashed name. `--serve` rebuilds on save and reloads the page.

The script is 445 kB against Vite's 320 kB, because our own code is not minified. React ships pre-minified. The app loads it from disk, so the difference does not matter there.

The whole tree, dev tools included, went from 160 packages to 27. The shipped tree is still 7. What remains is React, the fonts, Electron with its downloader, TypeScript and type definitions.

Tests: 166 pass. New ones cover the matchers, the runner's hook order, skipping, `.each`, timeouts, failing `beforeAll`, diff output and name filters, plus the bundler (TSX, ES and CommonJS packages, conditional exports, JSON, CSS with `@import` and fonts, branch folding, missing imports). The renderer suites pass against the new bundle, and the Electron smoke test loads it from `file://`.

## Round 5: Playwright replaced

The renderer suites used Playwright, which was never in `package.json`: the tests loaded a global install when one was there and skipped otherwise. `@siteinquisition/devkit/browser` (about 1,100 lines) replaces it. It launches Chromium with `--remote-debugging-pipe` and speaks the DevTools protocol over the pipe, so there is no port and no WebSocket. It offers the part of the Playwright API the tests use, so they only changed their import and launch lines: `getByRole`, `getByLabel`, `getByText`, `getByTestId`, `locator` with `hasText`, `filter`, `first`, `nth`, then `click` (with right button and position), `fill`, `press`, `check`, `selectOption`, `textContent`, `inputValue`, `boundingBox`, the keyboard and mouse, screenshots, viewport, colour scheme, clipboard permissions and page errors.

Actions keep Playwright's rules: they wait for one visible, enabled element that would receive the click, and fail at once when a locator matches more than one. Roles and accessible names are computed in the page with a short version of the ARIA rules, enough for the app's markup.

It finds a browser through `SIQ_CHROMIUM` or `CHROME_PATH`, then `chromium`, `google-chrome` and similar on `PATH`, then browsers other tools downloaded. The package count does not change, since Playwright was never installed by the repo, but the UI tests no longer need anything outside it apart from a browser.

Tests: 172 pass. New ones cover the driver against a fixture page: role, label and text matching, strict mode, waiting for enabled, fill, check, select, key chords, right click, dragging, screenshots and page errors. All 22 renderer tests pass on it.

## Kept, and why

- **react, react-dom** (5 packages): the UI.
- **@fontsource/inter, @fontsource/jetbrains-mono** (0 dependencies): bundled fonts, so nothing loads from the network.
- **electron, typescript** (dev): the app shell and the compiler. TypeScript also powers the test runner and the bundler.
- **@types/*** (dev): type definitions only.
