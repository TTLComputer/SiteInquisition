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

The proxy is now `core/src/interceptor.ts` (about 900 lines) on `node:net`, `node:tls`, `node:http` and `node:http2`, plus `core/src/x509.ts` (about 250 lines) for the CA and leaf certificates. The shipped tree is 8 packages: react, react-dom and their 3 helpers, ws, and the two font packages.

What it does:

- One port takes plain HTTP proxy requests, CONNECT tunnels, SOCKS5 and TLS sent straight to the port.
- In a tunnel, a TLS ClientHello is read for its SNI. Hosts in decrypt scope get a leaf certificate from the project CA, with HTTP/2 or HTTP/1.1 chosen by ALPN. Other hosts pass through untouched and show up under "seen, not in scope".
- WebSockets are relayed frame by frame, and the subprotocol and close codes are kept.
- Handshake failures are recorded with the same causes as before (`cert-rejected`, `closed`, `reset`), so the certificate-pinning banner still works.
- Upstream failures answer 502 and are recorded as errors rather than aborts.
- The proxy binds to the port and refuses non-loopback clients before reading a byte, without reaching into library internals. The MQTT relay no longer imports a private mockttp path.

What changed in behaviour:

- **Responses stream.** Before, every response for a host with "modify" on was buffered whole. Now only responses that a response rule, breakpoint or script could touch are buffered, so server-sent events and large downloads flow normally.
- **Upstream is always HTTP/1.1.** Clients can still speak HTTP/2 to the proxy.
- **Gone, and can be added back small if needed:** chaining to an upstream proxy (including PAC files), SOCKS4, and TLS fingerprint impersonation toward servers.

Tests: 147 pass. New tests cover HTTP/2 in a tunnel, SOCKS5 with plain HTTP and with TLS, streaming, 502 on an unreachable server, clients that reject our certificate, WebSocket subprotocols and close codes, SNI parsing, and certificate chains for names and IP addresses. I also drove real Chromium through the proxy. HTTPS came through as HTTP/2, a `wss:` connection relayed both frames, and a POST body arrived intact, all recorded.

## Kept, and why

- **ws** (0 dependencies): the core API server, WebSocket relaying and WebSocket replay. Node has a WebSocket client but no server, and the built-in client cannot set Cookie or Authorization headers. Next: replace it with in-house framing, which also opens frame-level replay tools (fragmentation, control frames, malformed frames).
- **react, react-dom** (5 packages): the UI.
- **@fontsource/inter, @fontsource/jetbrains-mono** (0 dependencies): bundled fonts, so nothing loads from the network.
- **electron, typescript** (dev): the app shell and the compiler.
- **vite, @vitejs/plugin-react, vitest** (dev, about 130 packages): planned for replacement. Tests would move to a small vitest-compatible runner on `node:test`, so the test files barely change.
