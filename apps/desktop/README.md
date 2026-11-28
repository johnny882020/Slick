# @oneseat/desktop

The OneSeat desktop app: a Tauri 2 shell (Rust, `src-tauri/`) and a small vanilla TypeScript
UI (`src/`). Stream D. The shell speaks the daemon protocol in
`packages/contracts/src/harness.ts` (`DaemonMethods` / `DaemonNotifications`).

```
pnpm --filter @oneseat/desktop test        # vitest: transport, reducer, rendering, protocol parity
pnpm --filter @oneseat/desktop typecheck
pnpm --filter @oneseat/desktop build       # vite build -> dist/
pnpm --filter @oneseat/desktop e2e         # gate 6: build + Playwright (dev bridge + fake daemon)
cd apps/desktop/src-tauri && cargo test    # Rust unit + fake-daemon integration tests
pnpm --filter @oneseat/desktop smoke:native  # real shell + real pinned window sandbox check (needs a display or xvfb)
pnpm --filter @oneseat/desktop tauri dev   # the app, with the daemon from ONESEAT_DAEMON / apps/daemon / fake
```

## How the shell finds the daemon

| Build | What runs | Where from |
|---|---|---|
| debug (`cargo build`, `tauri dev`) | `ONESEAT_NODE` (default `node`) + script | `ONESEAT_DAEMON` if set (a `.js/.mjs/.cjs` runs with node, anything else runs directly); else `apps/daemon/dist/main.js` if built; else `apps/desktop/dev/fake-daemon.mjs` (logged as "fake daemon") |
| release (`tauri build`) | sidecar `oneseat-daemon[.exe]` | next to the app executable; bundled from `bundle.externalBin = ["binaries/oneseat-daemon"]`. `ONESEAT_DAEMON` is ignored |

The daemon always gets `ONESEAT_HOME=<Tauri app data dir>` (e.g. `~/Library/Application Support/app.oneseat`,
`%APPDATA%\app.oneseat`, `~/.local/share/app.oneseat`) and `ONESEAT_SHELL=desktop`. `NODE_OPTIONS`
and `NODE_PATH` are removed from its environment.

**What the lead provides**

- The daemon entry point: `apps/daemon/src/main.ts` -> `apps/daemon/dist/main.js` (dev). It must read
  newline-delimited JSON-RPC 2.0 on stdin, write responses and notifications on stdout (one JSON
  object per line, nothing else on stdout), and log to stderr.
- The sidecar binary for each release target, named for Tauri's `externalBin`:
  `apps/desktop/src-tauri/binaries/oneseat-daemon-<target-triple>[.exe]`
  (e.g. `oneseat-daemon-x86_64-pc-windows-msvc.exe`, `oneseat-daemon-aarch64-apple-darwin`).
  `pnpm --filter @oneseat/daemon run build:sidecar` (Node SEA via `apps/daemon/scripts/build-sidecar.mjs`)
  writes exactly that file. Build it on each target OS before `tauri build`.
- `build.rs` writes a small placeholder there for debug builds (so `cargo build` / `cargo test` work
  without the sidecar) and **fails a release build** if the file is missing or is the placeholder.
  `ONESEAT_ALLOW_PLACEHOLDER_SIDECAR=1` overrides that, for CI compile checks only.

**Process management** (`src-tauri/src/daemon.rs`): one supervisor thread spawns the process,
routes responses to pending calls by id, forwards `harness.event` and `schedule.fired` to the main
window as the Tauri event `daemon://notification` (`{ method, params }`), and status changes as
`daemon://status`. On exit every pending call fails at once (code -32010) and the daemon is
restarted with backoff (0.5 s doubling to 30 s; reset after a minute of uptime). After each start
the handshake sends `daemon.hello`, then `auth.set` for every key in the keychain, and only then
marks the daemon running. UI calls made while it restarts wait up to 15 s. Daemon stderr and any
non-JSON stdout go to the app log after redaction (`src-tauri/src/redact.rs`: known key values,
`x-api-key` / `authorization` / `x-goog-api-key` / `apiKey` fields, `sk-...`, `AIza...`, `Bearer ...`).

## Security model

- **Commands and capabilities.** `build.rs` declares the app's commands, so each gets an
  `allow-<command>` permission. `capabilities/main.json` (window `main`) grants `core:default` and every
  command except `bridge_run`. `capabilities/pinned-apps.json` (windows `app-*`) grants only
  `allow-bridge-run`: no core APIs, no events, no plugins. Every command also checks the calling
  window's label itself.
- **`daemon_call(method, params)`** accepts only `UI_METHODS` (`src-tauri/src/allowlist.rs`): every
  `DaemonMethods` entry except `apps.run` and `auth.set`. Unknown methods are refused, so a new
  daemon method stays closed until it is listed. Tests check the Rust list, `src/protocol.ts`,
  `dev/protocol.mjs` and harness.ts agree.
- **Keys.** `key_save(provider, apiKey, baseUrl?)` validates, stores in the OS keychain (service
  `app.oneseat`, account = provider id, secret = JSON `{apiKey, baseUrl?}`), reads it back and sends
  `auth.set` from Rust. `key_status()` returns only booleans and base URLs; `key_delete(provider)`
  removes the entry and sends `auth.clear`. Keys never go back to a webview, a log, or an error.
  `keyring` v3 uses Keychain (macOS), Credential Manager (Windows), Secret Service (Linux, `sync-secret-service`
  + `crypto-rust`). With no keychain, `key_status` reports `keychain.available = false` with a plain
  message, and saving fails; there is no file fallback. Debug builds can use
  `ONESEAT_DEV_MEMORY_KEYSTORE=1` (memory only) where no keychain exists.
- **Pinned apps** (`src-tauri/src/pinned.rs`, `windows.rs`). `pin_open(appId)` opens window `app-<id>`
  sized from `<dataDir>/apps/<id>/app.json`, titled with the app name, loading
  `oneseat-app://localhost/<id>/index.html` (`http://oneseat-app.localhost/...` on Windows). The
  scheme handler serves only the requesting window's own page, with the `PINNED_APP_CSP` header
  (copied from contracts; a Rust test and a vitest test fail if they drift). The init script
  (`src/pinned_init.js`) defines only a frozen `window.oneseat = { run(skill, input) }`, which invokes
  `bridge_run`; the shell takes the app id from the window label and calls `apps.run`. Navigation off
  the page is blocked; http(s)/mailto links (clicks, scripts, `target=_blank`) open in the system
  browser via the opener plugin only after the person confirms a native dialog, one prompt at a time.
- **Main window**: CSP in `tauri.conf.json` (no remote anything, `connect-src ipc:` only), navigation
  limited to the bundled UI (and the dev server in debug builds), new windows denied.

`scripts/native-smoke.mjs` verifies the pinned sandbox in the real shell: the probe page in
`dev/probe-app` tries `daemon_call` (including `apps.run`), `key_status`, `key_save`, `pin_open`,
`plugin:event|listen`, `plugin:opener|open_url`, creating a webview, remote and local `fetch`, and a
skill outside `allowedSkills`; all must be refused.

## Dev bridge and fake daemon

- `dev/fake-daemon.mjs`: every `DaemonMethods` method with canned data, scripted runs (input with
  "send/email/remind" asks for approval; "app/dashboard/tracker" produces an artifact draft; "fail"
  errors; "slow" streams slowly), skill scan verdicts by source ("block/evil" -> block, "warn" -> warn,
  "missing" -> not found), pinned apps written to `$ONESEAT_HOME/apps/<id>/`.
- `dev/bridge.mjs`: serves `dist/` and bridges a WebSocket (`/rpc`) to a daemon child process, with
  the same commands and allowlist as the Rust core. Keys are kept in memory only. `/pinned/<id>/`
  serves pinned pages with the CSP. `pnpm dev:bridge` then open http://127.0.0.1:4780.
  `ONESEAT_DAEMON=/path/to/apps/daemon/dist/main.js pnpm dev:bridge` runs the real daemon instead.
- The UI picks `TauriTransport` inside Tauri and `WebSocketTransport` in a browser (`src/transport.ts`).

## Artifact drafts

`HarnessEvent` has no artifact event. The UI treats a successful `tool_end` whose content is a JSON
`ArtifactBundle` (`{ html, app }`, or wrapped as `{ artifact }` / `{ bundle }`) as a draft, and also
reads ```` ```oneseat-artifact ```` JSON blocks in the final text. Drafts are checked with
`validateArtifactBundle`; errors disable "Pin as app". "Pin as app" calls `apps.pin`.

## Export app (single-app build)

"Export" copies the app to `<dataDir>/exports/<id>/` (`app_export`) and shows the command:

```
pnpm --filter @oneseat/desktop export-app -- --app <dataDir>/exports/<id> [--bundles msi,nsis] [--no-build]
```

`scripts/export-app.mjs` writes `tauri-export/tauri.export.json` (productName = app name,
identifier `app.oneseat.pinned.<id>`, version, `mainBinaryName`, the page and app.json as resources
`pinned/*`, icons from a PNG data-URI icon via `tauri icon`) and runs `tauri build --config` with it,
into its own `CARGO_TARGET_DIR` (`tauri-export/target`), so the resources never land next to the
normal app's binary.
At startup the shell sees `resources/pinned/app.json`, pins it through the daemon, and opens only that
window (the main window opens only if no key is stored). It shares the main OneSeat data dir and
keychain entries. Build on Windows for .msi/.nsis and on macOS for .dmg/.app; the sidecar must exist
as for any release build.

## Release signing

`tauri.conf.json` holds null placeholders only. On CI:

```
cd apps/desktop
node scripts/signing-config.mjs --out signing.json   # reads WINDOWS_CERTIFICATE_THUMBPRINT, APPLE_SIGNING_IDENTITY, ...
pnpm tauri build --config signing.json
```

Tauri reads the secrets itself from the environment: `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`),
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
(or `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`). The Windows certificate must be in
the runner's certificate store; the script passes only its thumbprint.

Icons are placeholders made by `pnpm icons` (`scripts/make-icon.mjs` + `tauri icon`).

## Tauri WebDriver smoke test (optional, CI-only, Windows)

`webdriver/smoke.mjs` drives the real app through `tauri-driver` with plain W3C WebDriver calls
(setup -> save key -> run with skill chip -> approve). tauri-driver has no macOS support, so macOS
relies on the Playwright suite and `smoke:native`. Suggested job for stream F (`.github/`):

```yaml
webdriver-windows:
  runs-on: windows-latest
  continue-on-error: true            # optional job
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: pnpm }
    - uses: dtolnay/rust-toolchain@stable
    - run: pnpm install --frozen-lockfile
    - run: cargo install tauri-driver --locked
    - name: msedgedriver matching the runner's WebView2
      shell: pwsh
      run: |
        $v = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}").pv
        Invoke-WebRequest "https://msedgedriver.microsoft.com/$v/edgedriver_win64.zip" -OutFile edgedriver.zip
        Expand-Archive edgedriver.zip -DestinationPath $env:RUNNER_TEMP\edgedriver
        echo "$env:RUNNER_TEMP\edgedriver" >> $env:GITHUB_PATH
    - run: pnpm --filter @oneseat/desktop tauri build --debug --no-bundle
      env: { ONESEAT_ALLOW_PLACEHOLDER_SIDECAR: "1" }
    - name: run smoke
      shell: pwsh
      env:
        ONESEAT_DEV_MEMORY_KEYSTORE: "1"
        ONESEAT_DAEMON: ${{ github.workspace }}\apps\desktop\dev\fake-daemon.mjs
      run: |
        Start-Process tauri-driver
        Start-Sleep 3
        node apps/desktop/webdriver/smoke.mjs apps/desktop/src-tauri/target/debug/oneseat-desktop.exe
```

## Limitations

- Per-app dock/taskbar icons: pinned windows share the OneSeat process, so macOS shows one dock
  icon (OneSeat's) and Windows groups them under OneSeat. Each window has its own title. A per-app
  icon needs "Export app" (a separate executable).
- The macOS dock menu does not list pinned apps; the tray menu offers "Open OneSeat" and "Quit".
- `window.__TAURI_INTERNALS__` (Tauri's IPC plumbing) is still present in pinned pages; it cannot
  be removed without breaking IPC. Capabilities make every command but `bridge_run` unreachable through
  it (checked by `smoke:native`).
- Export app keeps the OneSeat icon unless the app icon is a PNG data URI (emoji / SVG icons are not
  rasterised).
- The Playwright suite runs in Chromium against the dev bridge. It covers the UI and the pinned page
  under the real CSP, not WebView2 / WKWebView specifics; the WebDriver job covers WebView2.
