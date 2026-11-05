# Changelog

## Unreleased

- **Glossary**: each place a field was seen opens the newest request that carried it, the count opens all of them in History (new `id:a,b` filter), and "+N more" expands the list.
- **Tech view**: a new Tech screen lists every technology across all captured traffic, grouped by provider, with the hosts, evidence and requests behind each, plus the CSRF tokens pages hand out.
- **CSRF in meta tags**: `<meta name="csrf-token" content="...">` (and hidden CSRF form fields) are found on any site, not only known frameworks. The Inspector and Tech view offer one-click "Keep fresh on replay", tokens are matched across hosts of one site (www and api), and a rotated token is traced back to the page that hands it out.
- **Dropdowns stay on screen**: the token picker, the History row menu and the title-bar popovers flip and slide to fit the window.
- **Reference tags**: the History menu item is now "Set reference tag (create or move)", and says whether a name creates a tag or moves it.
- **Server certificates** (Settings): trust a dev server's self-signed certificate (fetched with one click) or a private CA, or skip checks for listed hosts or all of them. Used by the proxy, Replay, Race, the HTTP/3 lab, WebSockets and MQTT. Failed requests show a "Look at its certificate" helper.
- **Field codecs**: say a JSON field is, for example, base64 of JSON (`$.payload = base64>json`). The Inspector shows it decoded, Replay opens it decoded and encodes it on send, and Codecs can save one from a field it decoded.
- **Codecs decodes all the way down**: a JSON field that holds more encoded JSON (a JSON string, base64 of JSON, url-encoded, and so on) opens up in place, at any depth. The result re-encodes as you type, through every layer, and a value sent from Replay is updated there as you edit, so there is no Encode or Put back step. An untouched value comes back byte for byte.
- **Search inside requests and responses**: text now matches any part of a word, ignoring case (`PO-77`, `csrf_tok`), and can be narrowed to one side or part: `req:`, `res:`, `reqbody:`, `resbody:`, `reqheader:`, `resheader:`. Existing projects are re-indexed once when opened.
- **Build search** in History: pick where to look and what for, see how many requests match as you go, and search. Starts from what is already in the filter.
- **Search matches are highlighted** in the Inspector, which scrolls to the first one; Previous and Next step through the rest.
- **Cookies**: Decode opens the value in Codecs with its layers detected. Reading a framework session cookie moved to its own Session button.
- **Send to Replay** looks and reads the same everywhere, and every list of recorded requests has it.


## 1.0.0

The first release, for Linux (x64) and Windows (x64). Packages: a .deb for Debian and Ubuntu, a .tar.gz, and a portable .zip for Windows.

**Capture**: an HTTP/1.1 and HTTP/2 proxy (plain, CONNECT and SOCKS5 on one port), HTTPS interception for in-scope hosts with a per-install CA, HTTP/3 for the built-in browser, WebSocket capture, and an MQTT 3.1/3.1.1/5.0 relay. A built-in Chromium browser records on its own listener. Scope rules decide what is decrypted and recorded.

**Finding things**: a searchable SQLite store with a filter language, History with saved views, a site map and live follow, a Timeline, endpoint coverage, technology detection, server-error flagging, JWT, session cookie, AWS and CSRF awareness, and decoders for Socket.IO, SignalR, ViewState, protobuf and gRPC.

**Changing things**: Replay with tokens, fresh cookies and CSRF tokens and SigV4 signing; Race; match and replace, mocks and breakpoints; a codec workbench; Streams composers for WebSocket and MQTT; scripts and test suites; login macros, variables, flows; API files (OpenAPI, Swagger, Postman, HAR, GraphQL) with contract checks, an auth matrix and negative tests.

**Agents**: an MCP server, over stdio (`siq mcp`) or HTTP, with approvals for actions that change things.

**Safety and housekeeping** (from the pre-release review):

- Scripts run in a separate, killable process, sandboxed by default with Node's permission model. Each script can turn its sandbox off; that is trusted per computer, so shared projects ask again. Agents' scripts always run sandboxed and always ask.
- Large bodies stream through the proxy: only the first 10 MB (by default) of a body is kept, and bodies over 64 MB skip hooks instead of filling memory.
- Listeners bind to 127.0.0.1 unless `--lan`; with it, each new device waits for your approval.
- The CA key and saved identities are encrypted with a key in the OS keyring when there is one. New CAs last two years; `siq ca rotate` and `siq ca remove`.
- Delete traffic by selection, by search or all at once, with retention by age and size. Project files are private to your user.
- Settings warns when the project is not on an encrypted disk.

**Windows**: a portable zip with `SiteInquisition.exe` and `bin\siq.cmd`. Secrets use DPAPI for your user, Settings checks BitLocker, and the CA guide covers the Windows certificate store. The exe is not code signed and has Electron's icon for now.
