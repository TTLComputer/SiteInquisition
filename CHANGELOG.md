# Changelog

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
