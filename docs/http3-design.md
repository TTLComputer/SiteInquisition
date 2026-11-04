# HTTP/3 testing controls: design and feasibility

Status: implemented (2026-11-04). Everything below is built and tested except
where "Not in this round" says otherwise. Tests: RFC 9001 and RFC 7541 vectors,
loopback transport tests with a lossy relay, stream plans, browser capture, and
an interop suite against aioquic in both directions (it runs when a Python with
aioquic is available and skips otherwise; aioquic is never a dependency).

Throughput on one connection is about 11 MB/s on loopback. That is plenty for
testing; it is not a bulk transfer tool.

## Goal

Let a developer drive HTTP/3 at the stream and connection level to find timing,
threading and protocol-handling bugs in a server: how many requests go out at
once and in which order, which streams are held, reset or starved, what the
server does with priorities, 0-RTT replays, connection migration, small flow
control windows and QPACK edge cases.

## Decision: an in-house QUIC, TLS 1.3, HTTP/3 and QPACK stack

Node 22 has no stable QUIC (`node:quic` is behind a flag and still changing),
and the library options (quiche or ngtcp2 bindings, or a pure JS port) either
bring native builds back or hide the parts we want to change: when a frame is
written, what goes in which packet, which ACKs are sent, whether flow control
credit is granted. For a testing tool those are the features, so we write the
stack ourselves on `node:dgram` and `node:crypto`, with no new dependencies.

### Is node:crypto enough for TLS 1.3?

Yes. QUIC carries TLS handshake messages in CRYPTO frames, so there is no TLS
record layer to write, only the handshake state machine and key schedule.

| TLS / QUIC need | node:crypto |
| --- | --- |
| Key exchange X25519, P-256 | `generateKeyPairSync('x25519')`, `createECDH('prime256v1')`, `diffieHellman` |
| HKDF-Extract / Expand-Label | `createHmac('sha256' \| 'sha384')` (HKDF written out, about 20 lines) |
| AEAD AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305 | `createCipheriv` with auth tags |
| Header protection | `aes-128-ecb` / `aes-256-ecb`, raw `chacha20` |
| CertificateVerify | `sign` / `verify` with RSA-PSS, ECDSA P-256/P-384, Ed25519 |
| Chain and hostname checks | `X509Certificate.verify`, `checkHost`, `checkIP`, `tls.rootCertificates` |
| Server certificates | the proxy's own CA and `LeafIssuer` (x509.ts) |

### Cost and risk

About 6,000 to 8,000 lines of TypeScript. The risky parts are loss recovery
and interop with real servers. We reduce that with:

- RFC test vectors: QUIC Initial keys and packet protection (RFC 9001 appendix A),
  QPACK and Huffman examples (RFC 7541 appendix C, RFC 9204 appendix B).
- Loopback tests of our client against our server, including loss and
  reordering injected by a lossy UDP relay.
- An interop suite against aioquic (Python) that runs when `python3 -m aioquic`
  is importable and skips otherwise, like the Playwright UI tests. aioquic is a
  developer tool here, never a dependency.

## Layers

All in `packages/core/src/quic/`:

| File | What it does |
| --- | --- |
| `bytes.ts` | Reader and writer with QUIC varints |
| `tls.ts` | TLS 1.3 client and server handshake for QUIC: key shares, ALPN, transport parameters extension, certificate checks, session tickets, PSK resumption and early data |
| `keys.ts` | Key schedule, Initial secrets, packet protection, header protection, key update |
| `packet.ts` | Long and short headers, coalesced packets, Version Negotiation, Retry integrity tag |
| `frames.ts` | Every QUIC v1 frame plus DATAGRAM (RFC 9221) |
| `connection.ts` | Packet number spaces, ACKs, loss detection and PTO (RFC 9002), NewReno congestion control, streams, flow control, stream limits, connection IDs, path validation and migration, idle timeout, close |
| `endpoint.ts` | UDP sockets, client connect and server accept, Retry and stateless reset |
| `huffman.ts`, `qpack.ts` | HPACK Huffman code; QPACK static and dynamic tables, encoder and decoder streams, blocked streams |
| `h3.ts` | HTTP/3 frames, control and QPACK streams, SETTINGS, GOAWAY, PRIORITY_UPDATE, request streams, client and server |
| `plan.ts` | The stream plan runner behind the UI controls |

Every layer exposes hooks so the plan runner can step outside normal
behaviour: write raw frames on a stream, coalesce chosen frames into one
datagram, skip ACKs, withhold flow control credit, send a frame the peer
should reject.

## Controls exposed in the UI

### Stream plan (the core of timing and threading testing)

A table of requests on one connection. Each row has:

- **Open at**: an offset in ms, or "after row N's headers / response / end".
- **Order**: open order is the row order unless an offset or dependency says otherwise.
- **Hold**: send HEADERS and all but the last DATA chunk, keep FIN back until a
  release time or "release with group", so many requests complete together.
- **Body chunks**: split the body into chunks of N bytes with gaps between them.
- **Reset**: RESET_STREAM after N bytes or at a time, with a chosen error code;
  STOP_SENDING the response after N bytes.
- **Priority**: the `priority` header (urgency, incremental), plus
  PRIORITY_UPDATE frames at chosen times while the response is in flight.

Connection controls on the plan:

- **Concurrency limit**: at most N streams open at once from our side.
- **Gate**: "single datagram" coalesces the final frame of every held stream
  into one UDP datagram, the HTTP/3 version of the single-packet race.
- **Flow control**: our initial_max_data, initial_max_stream_data and
  max_streams, and whether we grant more credit (off = back-pressure and
  starvation on the server side).
- **QPACK**: dynamic table capacity, max blocked streams, Huffman on or off,
  literal vs indexed choices, and deliberately blocked headers (refer to an
  insertion the decoder has not seen yet).
- **0-RTT**: resume with a saved session ticket and send chosen requests as
  early data, optionally the same request in 0-RTT twice on two connections to
  test replay protection.
- **Migration**: at a time, move the connection to a new local UDP port (NAT
  rebinding) or a new connection ID, with or without PATH_CHALLENGE.
- **Datagrams**: send HTTP datagrams when the server advertises them.

### Results

For each stream: open, headers sent, FIN sent, first response byte, response
complete, reset, plus the order the server answered in compared with the order
we asked in. A per-connection frame log (direction, packet number, frame
type, stream, length) is kept with the exchange so the Timeline can draw
stream lanes inside one connection.

### Elsewhere in the app

- **Replay**: protocol choice HTTP/1.1 or HTTP/3. HTTP/3 sends are recorded
  with `httpVersion: '3'`.
- **Race**: a fourth sync method, "Single datagram (HTTP/3)".
- **Scripts and MCP**: `h3.run` takes the same plan as the UI; `siq.h3` in scripts.
- **Settings › Proxy and TLS**: the list of hosts the built-in browser reaches
  over HTTP/3 (next section).

## Capturing HTTP/3 from the built-in browser

Chromium never sends QUIC through a proxy, so the browser's proxy setting alone
only ever captures HTTP/1.1 and HTTP/2. For hosts the user lists, the app
instead points Chromium straight at the browser listener:

- `host-resolver-rules` maps `host:443` (and `host:80`) to `127.0.0.1:<port>`,
  `origin-to-force-quic-on` makes Chromium use QUIC for `host:443` without
  waiting for Alt-Svc, and the session's `proxyBypassRules` skip the proxy for
  those hosts.
- The browser listener takes TLS on TCP and QUIC on UDP on the same port
  number, so if QUIC fails Chromium's TCP fallback is still captured.
- The UDP side (`packages/core/src/quic/capture.ts`) terminates QUIC with a
  leaf from the project CA (Chromium trusts it through the same
  `setCertificateVerifyProc` as for TCP), records each request with source
  `browser` and `httpVersion: '3'`, runs the same rules and hooks as the TCP
  interceptor, and forwards upstream over HTTP/3. Origins that do not finish a
  QUIC handshake within 3 seconds are sent over HTTPS instead and remembered as
  TCP-only for five minutes.

Limits: Chromium reads these switches at launch, so a changed host list takes
effect after a restart. Hosts must be exact names (the force-QUIC switch takes
no wildcards). Listed hosts are always decrypted on UDP; scope still decides
what is recorded. Responses are buffered rather than streamed, so server-sent
events over HTTP/3 arrive in one piece. The list lives in `browser.json` in the
project folder; `SIQ_BROWSER_H3_HOSTS=a.test,b.test` overrides it for one launch.

This was checked end to end with Electron 45 under xvfb: a page on a listed host
loaded over QUIC through the listener and was recorded as HTTP/3 with the real
upstream's response.

## Not in this round

- HTTP/3 capture from other devices (IoT, phones). The browser listener's UDP
  side could serve them with DNS pointed at this machine, but nothing sets
  that up yet.
- An "HTTP/3 available" badge from Alt-Svc in History, and HTTP/2 in Replay.
- WebTransport sessions, ECN, CUBIC and pacing, QUIC v2 and multipath.

## Build order

1. Bytes, keys, packets, frames, TLS 1.3 client and server; Initial vectors.
2. Connection, recovery, streams and endpoint; loopback client and server.
3. Huffman, QPACK, HTTP/3; replay over HTTP/3.
4. Plan runner and `h3.run`; Race single-datagram sync.
5. UI: HTTP/3 lab view, Replay protocol picker, Race sync option.
6. aioquic interop suite (runs when aioquic is installed).
7. HTTP/3 capture from the built-in browser.
