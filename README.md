# SiteInquisition

An intercepting proxy, built-in browser and replay toolkit for testing websites, APIs and IoT devices before they are finished. It runs on Windows and Linux and is MIT licensed.

> **Status:** early development. This repository currently contains the headless **core engine** and the `siq` CLI. The Electron UI, codec workbench, replay and race tools, scripting and MCP server follow in later milestones. The full design is in the [design spec](https://claude.ai/artifact/HyHcJe2h7r7iCqLT3PmyEM).

## What works today

- HTTP/1.1 and HTTP/2 proxy on one port. It accepts plain HTTP, `CONNECT` tunnels and SOCKS5.
- HTTPS interception with a per-install root CA, for in-scope hosts only. Out-of-scope TLS is tunnelled untouched.
- WebSocket capture, with every frame recorded in both directions.
- **MQTT** 3.1, 3.1.1 and 5.0 relay: devices connect to SiteInquisition as their broker, every byte is passed to the real broker unchanged, and each packet (CONNECT, SUBSCRIBE, PUBLISH, acks, ...) is recorded with topic, QoS, retain flag, properties and payload. TLS is supported on both sides, with device-facing certificates signed by the project CA.
- **Scope rules** (host glob, port, scheme, path prefix) that decide what is decrypted and what is recorded. A new project records nothing until you add a host.
- Redirect chains linked into a single flow.
- A capture database in SQLite (`node:sqlite`) with full-text search over URLs, headers and decoded bodies (gzip, deflate, brotli, zstd).
- An append-only change log with ULID ids on every row, ready for the planned multi-user and replication work.
- A core API (JSON-RPC 2.0 over a token-protected local WebSocket) with live change notifications.
- By default only loopback clients may connect. Pass `--lan` to accept phones and IoT devices.

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

Projects live in `./.siq` by default; use `-p <dir>` to choose another folder. The CA is stored per user in `~/.config/siteinquisition/ca` on Linux or `%APPDATA%\SiteInquisition\ca` on Windows. You can override this with `SIQ_DATA_DIR`.

### Search syntax

| Filter | Example |
| --- | --- |
| `host:` (glob) | `host:*.example.com` |
| `method:` | `method:POST` |
| `status:` | `status:404`, `status:>=400`, `status:5xx`, `status:200-299` |
| `path:` (prefix or glob) | `path:/api/`, `path:/v*/users` |
| `url:` (substring) | `url:token=` |
| `body:` / `header:` (full text) | `body:"session expired"` |
| `ws:` `source:` `state:` `scheme:` `tag:` `flow:` | `ws:true`, `tag:bug-123` |
| free text | `"invalid signature"` |

Prefix any filter with `-` to negate it, as in `-status:304`.

### Scope

Examples use `siq` for brevity. From a checkout, run `pnpm siq ...` or `node packages/cli/dist/main.js ...`.

```sh
siq scope add '*.example.com'               # decrypt and record
siq scope add login.example.com --exclude   # never record (first match wins, so list exclusions first)
siq scope add cdn.example.com --no-decrypt  # leave its TLS alone (only plain HTTP to it is recorded)
siq scope                                    # list rules
```

TLS interception is decided per connection, before the path is known. A host is decrypted when any include rule for it asks for decryption. Changing the set of decrypted hosts restarts the proxy listener on the same port.

## Repository layout

```
packages/
  codecs/  chainable encoders and decoders (url, base64, hex, gzip, deflate, br, zstd, json, ...)
  core/    proxy, MQTT relay, scope, capture store, search, core API
  cli/     the siq command
```

## Development

```sh
pnpm build   # type-checks and compiles every package
pnpm test    # unit and integration tests (Vitest); spins up local HTTP, HTTPS and WebSocket servers
```

CI runs only for release tags (`v*`) or when started by hand from the Actions tab, to conserve Actions minutes. Run the build and tests locally before pushing.
