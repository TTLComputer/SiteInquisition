# Development

Requires Node.js 22.13 or later and pnpm 10. There are no native modules: storage uses the `node:sqlite` module built into Node and Electron.

## Repository layout

```
packages/
  codecs/  chainable encoders and decoders (url, base64, hex, gzip, deflate, br, zstd, json, Socket.IO, SignalR, ViewState, protobuf, gRPC, ...)
  core/    proxy, MQTT relay, scope, capture store, search, core API
  cli/     the siq command
  ui/      React renderer (runs in the app, or in any browser for development)
  app/     Electron shell: hosts the core in a utility process and loads the renderer
  devkit/  in-house test runner (vitest API), renderer bundler, Chromium driver and packager
```

## Run from source

```sh
pnpm install
pnpm build
pnpm app                 # the desktop app
pnpm siq proxy --help    # the CLI
```

## Build and test

```sh
pnpm build   # type-checks and compiles every package
pnpm test    # unit and integration tests; spins up local HTTP, HTTPS and WebSocket servers
pnpm test packages/core -t 'frame plans'   # only matching files and test names
```

The UI tests drive the built renderer in Chromium against a real core. They need `pnpm build` first and a Chromium or Chrome, which `@siteinquisition/devkit/browser` drives over the DevTools protocol. It looks at `SIQ_CHROMIUM`, then `chromium`, `google-chrome` and similar on `PATH`; without one the UI tests are skipped. Set `SIQ_SCREENSHOTS=dir` to save screenshots.

To work on the renderer in a normal browser, start a proxy with `siq proxy`, read the API port and token from `core.json` in the project folder, run `pnpm --filter @siteinquisition/ui dev` (rebuilds on save and reloads the page) and open `http://127.0.0.1:5173/?api=ws://127.0.0.1:PORT&token=TOKEN`.

The test runner and the renderer bundler are in `packages/devkit`. Tests use the vitest API (`describe`, `it`, `expect`, hooks, `.each`, `.skipIf`, `expect.poll`), imported from `@siteinquisition/devkit/test`. Each test file runs in its own process, and TypeScript is compiled with `transpileModule`, so tests are not type-checked.

## Packaging

`pnpm package` writes the unpacked app, a .tar.gz and a .deb to `release/`, without electron-builder. `pnpm package --platform win32` writes `release/win-unpacked` and the Windows zip, and works from Linux too (it downloads Electron's Windows build and checks it against Electron's checksums, or uses `SIQ_ELECTRON_WIN32_ZIP`). On Windows, `pnpm smoke release/win-unpacked/SiteInquisition.exe` runs the same smoke test without xvfb. `pnpm smoke release/linux-unpacked/siteinquisition` starts the packaged app headless under `xvfb-run`, checks that a script runs and the sandbox holds, loads a page in the built-in browser, and exits. `SIQ_SMOKE_SCREENSHOT=/tmp/siq.png` saves a screenshot. `node scripts/notices.mjs` regenerates THIRD_PARTY_NOTICES.md after a dependency change.

## CI and releases

CI runs only for release tags (`v*`) or when started by hand from the Actions tab, to conserve Actions minutes. A tag builds, tests, packages and smoke-tests, then publishes a GitHub release with the notes from CHANGELOG.md. Run the build and tests locally before pushing. To cut a release, bump the version in the root and every `packages/*/package.json` and in `packages/core/src/version.ts`, add a `## X.Y.Z` section to CHANGELOG.md, and push a `vX.Y.Z` tag on main; a tag with a hyphen (`v1.0.0-beta.2`) becomes a pre-release.
