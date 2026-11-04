# Dependency audit (2026-11-04)

Goal: fewer packages, shallower chains, and no package we only use a sliver of.
Counts are unique `name@version` entries in the pnpm tree (`pnpm -r list --json --depth Infinity`).
"Shipped" means production dependencies of core, cli, app and ui, which is what users run.

## Summary

| | Before | After this PR | After replacing mockttp (next PR) |
|---|---|---|---|
| Shipped packages | 196 | 182 | about 8 |
| All packages, dev included | 372 | 330 | about 162 |
| Deepest shipped chain | 9 | 9 | 3 |

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

## Changes in this PR

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

Next PR (agreed): replace it with an in-house proxy on `node:http`, `node:http2`, `node:tls` and `node:net`, keeping `ws`. That leaves the shipped tree at about 8 packages (react, react-dom and their 3 helpers, ws, two font packages). New code to own: X.509 certificate generation (a small DER writer plus `crypto.sign`), the CONNECT, SOCKS5 and TLS-sniffing front end, and HTTP/2. The existing proxy, power-tools and UI tests are the safety net.

## Kept, and why

- **ws** (0 dependencies): the core API server and WebSocket replay. Node has a WebSocket client but no server, and the built-in client cannot set Cookie or Authorization headers.
- **react, react-dom** (5 packages): the UI.
- **@fontsource/inter, @fontsource/jetbrains-mono** (0 dependencies): bundled fonts, so nothing loads from the network.
- **electron, vite, @vitejs/plugin-react, typescript, vitest** (dev): build and test tooling that does not ship. vitest is the biggest at 65 packages of its own. Moving to `node:test` would remove them but means rewriting every test file; not worth it for dev-only packages.
