# SiteInquisition

**See, search and replay every request your unfinished website, API or IoT device makes.**

SiteInquisition is a desktop intercepting proxy with a built-in Chromium browser. Point a browser, phone, device or tool at it, and every HTTP, WebSocket and MQTT exchange lands in a searchable history you can inspect, decode, edit and send again. It runs on Linux and Windows (x64) and is MIT licensed.

## Why use it

- **Capture everything.** HTTP/1.1 and HTTP/2 (plus HTTP/3 in the built-in browser), HTTPS for the hosts you choose, WebSockets frame by frame, and MQTT 3.1 to 5.0. Plain proxy, SOCKS5 or transparent mode, all on one port.
- **Find it fast.** Full-text and JSONPath search over headers and decoded bodies, a timeline, endpoint coverage, and automatic spotting of frameworks, JWTs, CSRF tokens and leaked server errors.
- **Replay and bend it.** Edit and resend in one click, with fresh cookies and CSRF tokens, counters and lists, race-timed bursts, match and replace, mocks and breakpoints.
- **Decode anything.** Select a value and press Ctrl D to peel back base64, URL, gzip, JWT, protobuf and more right where it sits. It is encoded again when you send.
- **Understand the API.** Flows, value tracking, OpenAPI, Postman, HAR and GraphQL import, contract checks, an auth matrix and negative tests.
- **Automate it.** JavaScript scripts and test suites in a sandbox, and an MCP server so agents such as Claude Code can search and (with your approval) replay traffic.

The full list is in [docs/features.md](docs/features.md).

## Download

Get the latest build from [Releases](https://github.com/TTLComputer/SiteInquisition/releases).

| Platform | File | How |
| --- | --- | --- |
| Debian, Ubuntu | `siteinquisition_<version>_amd64.deb` | `sudo apt install ./siteinquisition_*_amd64.deb`, then run `siteinquisition` |
| Other Linux x64 | `siteinquisition-<version>-linux-x64.tar.gz` | Unpack anywhere and run `./siteinquisition` |
| Windows x64 | `siteinquisition-<version>-win-x64.zip` | Unzip anywhere (for example `%LOCALAPPDATA%\Programs`) and run `SiteInquisition.exe` |

The `siq` command line tool comes with every build: on PATH with the .deb, in the `bin` folder otherwise.

The Windows zip is portable and not code signed yet, so SmartScreen may warn the first time: choose More info, then Run anyway. With the .tar.gz, Chromium's sandbox helper `chrome-sandbox` must be owned by root and setuid (the .deb does this for you). To uninstall, see [docs/ca-trust.md](docs/ca-trust.md#uninstalling-siteinquisition).

## Quick start

1. **Open the app** and add the host you are testing to scope (Project settings, Capture scope, or "add this host to scope" in the browser's address bar). A new project records nothing until you do.
2. **Browse with the built-in browser.** It already trusts SiteInquisition's certificate for in-scope hosts, so HTTPS just works and every request shows up in Traffic.
3. **Or proxy anything else.** Point a browser, phone or device at `127.0.0.1:8080`. For HTTPS, trust the SiteInquisition CA on that device:

   ```sh
   siq ca                 # where the certificate is, and its fingerprint
   siq ca --pem > siteinquisition-ca.pem
   ```

   Steps for each OS and browser, and how to remove it afterwards, are in [docs/ca-trust.md](docs/ca-trust.md). For phones and IoT devices on your network, start with `--lan` and allow each device when it first connects.
4. **Replay.** Select any request and press Ctrl R to edit and resend it.

Prefer the terminal? Run the proxy headless and search what it records:

```sh
siq proxy --include 'api.example.com'
siq search host:api.example.com status:>=400
```

### Connect an agent

```sh
claude mcp add siteinquisition -- siq mcp --project <project-folder>
```

Project settings, MCP and agents shows this command with your project's folder filled in. Agents can read traffic freely; anything that sends requests or changes settings waits for your approval in the title bar.

More commands (scope, MQTT relay, retention, search syntax) are in [docs/cli.md](docs/cli.md).

## Security

Captured traffic holds real cookies, tokens and passwords, and the CA can impersonate any site to a device that trusts it. Projects are readable only by you, and the CA key and saved secrets are encrypted with your OS keyring (Secret Service on Linux, DPAPI on Windows) when one is available. Keep projects on an encrypted disk, install the CA only where you need it, and remove it when you are done. See [SECURITY.md](SECURITY.md) for the details, including what the script sandbox does and does not stop.

## Build from source

Requires Node.js 22.13+ and pnpm 10.

```sh
pnpm install
pnpm build
pnpm app        # run the desktop app
pnpm test       # run the tests
pnpm package    # build the .deb and .tar.gz into release/ (add --platform win32 for the zip)
```

Repository layout, testing, packaging and releases are covered in [docs/development.md](docs/development.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
