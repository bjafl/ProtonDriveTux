# CLAUDE.md — Proton Drive Linux Sync Client

## Purpose

Unofficial, non-commercial Proton Drive sync client for Linux (Ubuntu/GNOME focus), built with
Tauri v2. The goal is a working prototype that syncs a local folder against Proton Drive with
end-to-end encryption handled entirely by Proton's own SDK.

Proton has announced an official Linux client, but it is not yet available (May 2026). This
project fills the gap and serves as a learning project for Tauri + Linux desktop integration.

---

## Repo structure

```
proton-drive-linux-sync/    ← project root
├── CLAUDE.md
├── src-tauri/              ← Rust/Tauri backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         ← Tauri entry point
│       ├── auth.rs         ← SRP authentication against the Proton API
│       ├── watcher.rs      ← inotify via the notify crate
│       ├── db.rs           ← SQLite state database
│       ├── keyring.rs      ← GNOME Keyring via secret-service crate
│       └── commands.rs     ← Tauri IPC commands
├── src/                    ← React/TypeScript frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   └── lib/
│       └── drive.ts        ← Thin wrapper around the Proton Drive JS SDK
└── vendor/
    └── sdk/                ← Proton Drive SDK (git submodule, read-only)
        ├── js/             ← TypeScript SDK — primary integration
        ├── cs/             ← C# SDK (reference only)
        ├── kt/             ← Kotlin (reference only)
        └── swift/          ← Swift (reference only)
```

---

## SDK integration

The SDK is included as a **git submodule** at `vendor/sdk/` and must **not** be modified.
Clone with `git clone --recurse-submodules`, or run `git submodule update --init --recursive`
after a plain clone. Build the SDK once with `cd vendor/sdk/js/sdk && npm install && npm run build`.

### JS SDK (primary)
- Location: `vendor/sdk/js/sdk/`
- Used in the React/TypeScript layer (Tauri WebView)
- Handles all Drive logic: encryption, file upload/download, folder structure
- Referenced via `file:./vendor/sdk/js/sdk` in `package.json`

```jsonc
// tsconfig.json paths
{
  "compilerOptions": {
    "paths": {
      "@proton/drive-sdk": ["./vendor/sdk/js/packages/sdk/lib"]
    }
  }
}
```

### Procedure: update the SDK submodule

Run this procedure when the user asks to check or update the SDK.

#### Step 1 — find new commits

```bash
# Fetch without changing anything
git -C vendor/sdk fetch origin

# List commits since the current pin
CURRENT=$(git submodule status vendor/sdk | awk '{print $1}' | tr -d +-)
git -C vendor/sdk log "$CURRENT..origin/HEAD" --oneline
```

If there are no new commits: report and stop.

#### Step 2 — analyse the changes

For each commit since the pin:

```bash
# See which files changed
git -C vendor/sdk show <sha> --name-only

# See the diff for JS SDK code (the only part we use)
git -C vendor/sdk show <sha> -- "js/sdk/src/"
```

**Assess risk per commit:**

| What changed | Risk |
|--------------|------|
| Only `cs/`, `kt/`, `swift/`, `CHANGELOG.md` | None — we only use JS |
| `js/sdk/src/internal/` | Low — internal refactor; verify exported API is intact |
| `js/sdk/src/index.ts` or re-exports | High — public API change |
| Existing exported function/type removed or signature changed | **Breaking** |
| New optional parameter on a function we call | Non-breaking |
| New required parameter added | **Breaking** |
| Field changed from required to optional or vice versa | Potentially breaking |

**Our SDK entry points** (the only things that matter):
```
ProtonDriveClient — constructor options
getDriveClient().getNode()
getDriveClient().listFolderChildren()
getDriveClient().subscribeToTreeEvents()
getDriveClient().getFileUploader()          — metadata: { mediaType, expectedSize, modificationTime? }
getDriveClient().getFileRevisionUploader()  — metadata: same shape
getDriveClient().getFileDownloader()
getDriveClient().trashNodes()
getDriveClient().createFolder() / findOrCreateFolder()
```
All calls are isolated in `src/lib/drive.ts` — only that file needs to change on an API break.

#### Step 3 — check npm dependencies in the SDK

```bash
# Did package.json change since the pin?
git -C vendor/sdk diff "$CURRENT..origin/HEAD" -- js/sdk/package.json
```

Note **dependencies** and **devDependencies** separately:
- New/changed **dependency**: `npm install` is required after checkout.
- New/changed **devDependency**: only relevant for building; `npm install` is still sufficient.
- Changed **build script** (`scripts.build`): use the new script, do not hardcode `tsc`.

#### Step 4 — report and ask the user

Present a summary:

```
Found N new commits since <old-sha>:
  - <sha> <title>  [no JS change / low risk / BREAKING]
  - ...

JS dependencies changed: yes/no
Break in our API calls: yes/no — [details]
```

Then ask:
- If **no breaking changes**: "Looks safe. Shall I update the submodule?"
- If **breaking changes**: describe what breaks and propose concrete fixes in
  `src/lib/drive.ts` (and optionally `src/lib/sync.ts`). Ask whether the user wants
  to proceed with the update and fix the code, or wait.
- If **uncertain**: describe the uncertainty and let the user decide.

#### Step 5 — perform the update (only after user approval)

```bash
# 1. Move to the new commit
NEW_SHA=$(git -C vendor/sdk rev-parse origin/HEAD)
git -C vendor/sdk checkout "$NEW_SHA"

# 2. Install npm dependencies (always safe; required if deps changed)
cd vendor/sdk/js/sdk
npm install

# 3. Build the SDK — use build:ci for a clean build if deps changed, otherwise build
npm run build          # or: npm run build:ci
cd ../../../..

# 4. Update project dependencies (picks up any changes in dist/)
pnpm install

# 5. Type-check + tests
pnpm tsc --noEmit
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

If the type-check fails due to breaking API changes: implement the agreed fixes in
`src/lib/drive.ts` (and optionally `src/lib/sync.ts`) and re-run the tests.

#### Step 6 — commit

```bash
git add vendor/sdk pnpm-lock.yaml   # also add src/lib/drive.ts etc. if changed
git commit -m "chore(sdk): advance submodule to <new-short-sha>

<list of commits since previous pin, with risk assessment>
<'No changes required' or describe what was fixed>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

#### Fallback: roll back

If something goes wrong after updating:
```bash
git -C vendor/sdk checkout <old-sha>
cd vendor/sdk/js/sdk && npm run build && cd ../../../..
pnpm install
git checkout vendor/sdk   # discard the staged submodule change
```

---

### Important SDK constraints
- The SDK is **not production-ready** — breaking changes are coming (new crypto model)
- The SDK does **not** include authentication, session management, or an address provider — these are implemented here
- Direct API calls that bypass the SDK are **not permitted** under Proton's terms of use
- Syncing must go via **Drive events** — not polling or recursive traversal

### Required HTTP header
All requests via the SDK must set:
```
x-pm-appversion: external-drive-protondrive-linux@{version}-alpha
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│  React + TypeScript (Tauri WebView)     │
│  - Login UI, status view, settings      │
│  - Proton Drive JS SDK                  │
│  - VolumeEventChannel (server events)   │
├─────────────────────────────────────────┤
│  Tauri IPC (invoke / emit)              │
├─────────────────────────────────────────┤
│  Rust (Tauri backend)                   │
│  - notify crate → inotify watcher       │
│  - tokio::sync::mpsc event queue        │
│  - SQLite state database (rusqlite)     │
│  - secret-service → GNOME Keyring       │
│  - notify-rust → desktop notifications  │
└─────────────────────────────────────────┘
```

### Data flow — local → remote
1. `notify` watcher (Rust) detects file change via inotify
2. Event is debounced 300 ms and placed in an `mpsc` channel
3. Tauri emits the event to the WebView: `sync://local-change`
4. `handleLocalUpsert` fetches raw bytes via `pd-file://` scheme
5. JS SDK encrypts and uploads the file
6. SQLite updated with new `etag` and `sync_state = synced`

### Data flow — remote → local
1. `VolumeEventChannel` (JS SDK) receives a server-side event
2. Compare revision ID against SQLite state
3. Download and decrypt via SDK; stream chunks straight to disk
4. SQLite updated

---

## Tech stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Tauri | v2 |
| Backend | Rust + Tokio | stable |
| Frontend | React + TypeScript | 19 / 5 |
| Styling | Tailwind CSS + shadcn/ui | v4 / latest |
| Drive SDK | Proton Drive JS SDK | `vendor/sdk/js/sdk` |
| File monitoring | `notify` crate | 6.x |
| Local state | SQLite via `rusqlite` | 0.31.x |
| Credentials | `secret-service` crate | 5.x |
| Notifications | `notify-rust` | 4.x |
| Package format | AppImage (v1), Flatpak (v2) | — |

---

## Authentication

Proton uses **SRP (Secure Remote Password)** — the password is never sent in plaintext.

### Flow
```
1. GET  /auth/info?Username={user}   → salt, server_ephemeral, srpSession
2. Compute SRP client proof locally  (bcrypt + SHA512)
3. POST /auth                        → access_token, refresh_token, UID
4. POST /auth/2fa  (if enabled)      → TOTP code
5. Store tokens in GNOME Keyring
```

### Reference implementations
- `ProtonDriveApps/WebClients` — TypeScript SRP implementation
- `ProtonDriveApps/sdk-tech-demo` — C# reference with `ProtonApiSession`
- Never store passwords — only session tokens in the keyring

---

## SQLite state schema

```sql
CREATE TABLE files (
    remote_id     TEXT PRIMARY KEY,
    local_path    TEXT NOT NULL,
    etag          TEXT,
    modified_at   INTEGER,          -- Unix timestamp
    size_bytes    INTEGER,
    sync_state    TEXT NOT NULL      -- 'synced' | 'pending_upload' | 'pending_download' | 'conflict' | 'error'
);

CREATE TABLE sync_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
    -- keys: 'local_root', 'volume_id', 'last_event_anchor', 'selected_folders', etc.
);
```

---

## Linux integration

### GNOME Keyring
Credentials are stored via the `secret-service` crate, which talks to
`org.freedesktop.secrets` (GNOME Keyring or any compatible provider).

### Autostart
```ini
# ~/.config/autostart/proton-drive-sync.desktop
[Desktop Entry]
Type=Application
Name=Proton Drive Sync
Exec=/path/to/proton-drive-linux-sync --minimized
Hidden=false
X-GNOME-Autostart-enabled=true
```

### System tray
GNOME removed native tray support. Requires `gnome-shell-extension-appindicator` or
`ubuntu-appindicator`. Tauri uses `tray-icon` + `libayatana-appindicator3`.
The one-time deprecation warning from `libayatana-appindicator3` is suppressed via a
GLib log handler installed before the tray is created (see `suppress_appindicator_warning`
in `commands.rs`).

---

## Known limitations and risks

- **SDK breaking change announced** — Proton will introduce a new crypto model. All SDK calls
  are abstracted behind `src/lib/drive.ts` so the migration surface is minimal.
- **SRP implementation is complex** — follow the WebClients repo closely; do not improvise crypto.
- **rclone is intentionally not used** — it is unstable and periodically blocked by Proton.
- **GNOME tray** requires the AppIndicator extension — falls back to status window if missing.
- **Personal, non-commercial use only** — Proton's SDK terms prohibit commercial use without agreement.
- **Conflict resolution is last-write-wins in v1** — a runtime wizard is deferred.

---

## Development environment

```bash
# Prerequisites
rustup toolchain install stable
cargo install tauri-cli
pnpm install

# Development
cargo tauri dev

# Build AppImage
cargo tauri build

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript tests
pnpm test
```

### Environment variables (`.env.local`)
```
PROTON_API_BASE=https://api.proton.me
PROTON_APP_VERSION=external-drive-protondrive-linux@0.1.0-alpha
```

---

## Phase status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Tauri shell, tray, inotify | ✅ Done |
| 1 | SRP authentication + Keyring | ✅ Done |
| 2 | JS SDK integration, file transfer | ✅ Done |
| 3 | Bidirectional sync engine | ✅ Done |
| 4 | UI, autostart, notifications, AppImage | 🔄 AppImage build pending |

---

## References

- [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) — `vendor/sdk/`
- [sdk-tech-demo](https://github.com/ProtonDriveApps/sdk-tech-demo) — C# auth reference
- [WebClients](https://github.com/ProtonMail/WebClients) — SRP TypeScript implementation
- [Tauri v2 docs](https://v2.tauri.app)
- [protondrive-linux (DonnieDice)](https://github.com/donniedice/protondrive-linux) — existing unofficial client (rclone-based)
