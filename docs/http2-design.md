# HTTP/2 testing controls: design

Status: implemented (2026-11-05). An in-house HTTP/2 stack (frames, HPACK, a
connection engine in both roles, the connect methods and a protocol ladder), a
stream-plan runner behind the protocol lab, and keepalives on connections held
at a breakpoint. Tests: RFC 7541 (HPACK) appendix vectors, RFC 9113 framing and
error cases, interop against `node:http2` in both roles, loopback stream plans,
the h2c upgrade, ALPN, prior knowledge, the ladder, and the proxy path.

The transparent-proxy HTTP/2 support (the server always decides how HTTP/2 is
negotiated) is described in its own change; this document covers the testing
and debugging surface built on top of it.

## Goal

Let a developer drive HTTP/2 at the stream and connection level to find the
same classes of bug the HTTP/3 lab finds — timing, threading, ordering,
flow-control and protocol-handling bugs in a server — and to work around a
server's bugs while another team fixes them, by mocking or editing the whole
request or response in place.

## An in-house HTTP/2 engine

`node:http2` is complete and fast, but it decides the things a testing tool
wants to control: when a frame is written and in which TCP segment, how a
header block is split into CONTINUATION frames, when WINDOW_UPDATE credit is
granted, whether a stream is reset mid-body, what goes in a GOAWAY. So the lab
runs on an in-house engine (`src/h2/`) with no new dependencies, built on
`node:net`/`node:tls`:

- `frames.ts` — the frame codec, SETTINGS, error codes, a reader that respects
  `MAX_FRAME_SIZE`, and `describeFrame` for the log.
- `hpack.ts` — HPACK (RFC 7541): static and dynamic tables, Huffman, the
  never-index flag, size updates, tested against the RFC's own vectors.
- `connection.ts` — `H2Connection` in both the client and server roles, with
  streams that expose the controls below, flow control, CONTINUATION, trailers,
  and a frame log. It interoperates with `node:http2` in both directions.
- `connect.ts` — the three ways to get HTTP/2 from a server (ALPN over TLS, the
  h2c upgrade, prior knowledge), and `protocolLadder`, which tries each and
  reports what the server accepted.
- `plan.ts` — `runH2Plan`, the stream-plan runner the lab calls.

The engine is a testing tool, not a bulk transfer library; it keeps whole
bodies in memory and records every frame.

## The protocol lab

The HTTP/3 lab and the HTTP/2 lab are one view now (`Protocol lab`), because a
plan reads the same way on either: a list of requests that become streams on
one connection, each with timing and stream controls, and a connection panel
for the settings. A segmented control picks the protocol. The row controls are
shared — open-at, after-row gating, hold and release, chunking, reset
after-bytes / at-time, stop-reading, the RFC 9218 priority header. HTTP/2 adds
its own: the connect method, CONTINUATION splitting, frame padding and
trailers. HTTP/3 keeps its own: 0-RTT, migration and key updates.

Everything needed to debug HTTP/2 is reachable: breakpoint a stream at any
point (hold it, release it on a gate or a timer, wait for another stream, reset
it after N bytes or at a time), shape the connection (SETTINGS, flow-control
windows, HPACK table size, GOAWAY at a time, close at a time), send a
single-packet race, and read back a decoded frame log and per-stream lanes. The
ladder-test button probes the first row's host and reports every way in it
accepts.

Each stream is recorded as an ordinary exchange (HTTP version 2, trailers
folded into the response headers), so it shows up in History and the Inspector
with everything else.

## Keepalives while a breakpoint is paused

A breakpoint can hold a request or response for as long as it takes to compose
an edit. Meanwhile the server — or the client — may time the connection out, so
forwarding later fails for a reason that has nothing to do with the bug under
test. With the setting on (Breakpoints panel; off by default, saved per
project), the proxy sends PING frames on the held connections every N seconds
while a hook waits: for HTTP/2 the client's connection and the paired upstream
one, for HTTP/3 the client's QUIC connection and the pooled upstream one. The
timer only runs while a hook is actually waiting, so ordinary traffic is
untouched, and the setting is read live, so it takes effect without restarting
the proxy. HTTP/1.1 keeps its own sockets alive.

## Replay and Race

Replay's protocol picker offers HTTP/1.1, HTTP/2 (with a choice of how to ask
for it: automatic, ALPN, h2c upgrade or prior knowledge) and HTTP/3, and a
request captured over HTTP/2 or HTTP/3 replays over the same protocol by
default. Race's single-packet mode runs on the in-house HTTP/2 plan runner, as
the HTTP/3 race runs on the HTTP/3 one: every stream holds its last byte and the
gate releases them in one TCP write. Both use the built-in stacks, so the
server decides: one that does not take HTTP/2 fails the send or the race rather
than falling back to HTTP/1.1.

## Not in this round

- The Timeline's per-connection lanes and the server-error feed do not yet
  split HTTP/2 streams out of their connection.
