# Command line reference

The `siq` command runs the proxy headless and works with a project's data, even while the app or a proxy is running. Installed builds put `siq` on your PATH (the .deb) or ship it in `bin/` (the .tar.gz and Windows zip). From a source checkout, run `pnpm siq ...` or `node packages/cli/dist/main.js ...`. `siq --help` and `siq <command> --help` list every option.

## Capture and search

```sh
# Capture traffic for one host
siq proxy --include 'api.example.com' --port 8080
# then point a browser, device or tool at 127.0.0.1:8080
curl -x http://127.0.0.1:8080 --cacert "$(siq ca | awk '/certificate/{print $2}')" https://api.example.com/

# Search and inspect (works while the proxy is running)
siq search host:api.example.com status:>=400
siq show <exchange-id>
```

## Desktop app options

```sh
siteinquisition                                  # the proxy listens on 127.0.0.1:8080 (or a free port if taken)
siteinquisition --project ~/siq/shop --lan       # choose the project folder and accept LAN devices
siteinquisition --port 9090
```

On Windows, pass the same options to `SiteInquisition.exe`; from a checkout, `pnpm app -- --project ...`. `SIQ_PROJECT` also sets the project folder. Without one, projects live in the app's user data folder. The core runs in a separate utility process, and the window talks to it over the same local API as the CLI.

## Agents (MCP)

```sh
claude mcp add siteinquisition -- siq mcp --project ~/siq/shop   # stdio bridge to the running app or `siq proxy`
siq agent-writes allow                                          # let agents send traffic without asking (default: ask)
```

The app shows the exact command for its open project, and an HTTP alternative, in Settings, MCP and agents.

## MQTT

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

## Storage and retention

```sh
siq delete host:ads.example.com          # delete what a search matches
siq clear --yes                          # delete all recorded traffic (scope, rules and scripts stay)
siq prune --older-than 30 --max-size 2000 --keep   # delete now, and keep doing it every hour
```

In the app: right-click a row (or press Delete), *Delete matching* in History, and Settings, Storage.

## Search syntax

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

## Scope

```sh
siq scope add '*.example.com'               # decrypt and record
siq scope add login.example.com --exclude   # never record (first match wins, so list exclusions first)
siq scope add cdn.example.com --no-decrypt  # leave its TLS alone (only plain HTTP to it is recorded)
siq scope                                    # list rules
```

TLS interception is decided per connection, before the path is known. A host is decrypted when any include rule for it asks for decryption. Changing the set of decrypted hosts restarts the proxy listener on the same port.
