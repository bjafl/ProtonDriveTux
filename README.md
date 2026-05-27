# ProtonDriveTux

> **Unofficial, non-commercial.** This project is not affiliated with or supported by Proton AG.
> Proton has announced an official Linux client; this fills the gap in the meantime.

A desktop sync client for [Proton Drive](https://proton.me/drive) on Linux, built with Tauri v2.
It syncs a local folder against your Drive using Proton's own JS SDK, so end-to-end encryption
is handled entirely by Proton's code.

---

## Status

Working prototype. The core sync loop is complete.

| Feature | State |
|---------|-------|
| Login (SRP + 2FA) | ✅ |
| Session restore from keyring | ✅ |
| Onboarding: pick local folder + Drive folders | ✅ |
| Root-folder sync mode (none / files only / recursive) | ✅ |
| Conflict resolution wizard | ✅ |
| Upload new files | ✅ |
| Upload modified files (revisions) | ✅ |
| Download new/changed Drive files | ✅ |
| Remote rename/move → local rename | ✅ |
| Local deletes → Drive (permanent trash) | ✅ |
| Remote deletes → local delete | ✅ |
| Token refresh on 401 | ✅ |
| Watcher stop/restart on path change | ✅ |
| DB cleared when sync root changes | ✅ |
| Recursive folder sync on cold start | ✅ |
| Full reconciliation (periodic + manual "Sync now") | ✅ |
| Sync pause / resume (button + tray) | ✅ |
| Large file streaming (no base64 round-trip) | ✅ |
| Parallel downloads (up to 6 concurrent) | ✅ |
| Parallel uploads (up to 4 concurrent) | ✅ |
| Simultaneous up + down on initial sync | ✅ |
| Per-key event coalescing (no duplicate writes) | ✅ |
| System tray with sync state + recent files | ✅ |
| Tray shows queued count under backpressure | ✅ |
| Desktop notifications (sync + errors) | ✅ |
| Autostart on login | ✅ |

---

## Requirements

- Ubuntu 22.04+ or equivalent (GNOME/X11 or Wayland)
- GNOME Keyring or any `libsecret`-compatible secrets manager
- For system tray: `gnome-shell-extension-appindicator` (installed by default on Ubuntu 22.04+)
- Proton account with Drive access

**Build dependencies:**

```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  libssl-dev \
  libsecret-1-dev \
  build-essential \
  curl
```

**Toolchain:**

```bash
# Rust
curl https://sh.rustup.rs -sSf | sh

# Node (via nvm or system)
# pnpm
npm install -g pnpm
```

---

## Development

```bash
# Clone with submodules (includes the Proton Drive SDK)
git clone --recurse-submodules git@github.com:bjafl/ProtonDriveTux.git
cd ProtonDriveTux

# If you already cloned without --recurse-submodules:
git submodule update --init --recursive

# Build the SDK (required once, and again after `git submodule update`)
cd vendor/sdk/js/sdk && npm install && npm run build && cd ../../../..

pnpm install
cargo tauri dev
```

The app opens in a window. On close it minimises to the system tray.
To start hidden: `cargo tauri dev -- -- --minimized`

```bash
# TypeScript tests
pnpm test

# TypeScript coverage
pnpm coverage

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Rust coverage (requires cargo-llvm-cov)
pnpm coverage:rust
```

---

## Build

```bash
cargo tauri build
```

Produces an AppImage in `src-tauri/target/release/bundle/appimage/`.

---

## How it works

```
┌─────────────────────────────────────┐
│  React + TypeScript (Tauri WebView) │
│  Login UI · status · settings       │
│  Proton Drive JS SDK                │  ← all crypto lives here
│  inotify events via Tauri IPC       │
├─────────────────────────────────────┤
│  Tauri IPC (invoke / emit)          │
├─────────────────────────────────────┤
│  Rust (Tauri backend)               │
│  notify crate → inotify watcher     │
│  SQLite (rusqlite) — file state     │
│  GNOME Keyring — session tokens     │
│  notify-rust — desktop alerts       │
└─────────────────────────────────────┘
```

**Local → Drive:** inotify fires → 300 ms debounce → stability check (wait for
write to finish) → `pd-file://` fetch raw bytes → SDK encrypts + uploads → SQLite updated.

**Drive → local:** SDK Drive event subscription → compare revision ID against
SQLite → download + decrypt → stream chunks to disk → SQLite updated.

**Concurrency:** Downloads and uploads run in parallel with bounded concurrency
(6 downloads, 4 uploads). Both directions run simultaneously during initial sync.
Live events go through a per-file coalescing queue — if the same file changes
multiple times while a download/upload is in flight, the intermediate events
collapse into a single re-run after the current one completes.

Anti-loop: files written locally by a Drive download are suppressed from
re-upload for 5 seconds. Large files never buffer entirely in memory — uploads
fetch bytes via a custom `pd-file://` URI scheme, downloads write each chunk
directly to disk via append-mode IPC commands.

Authentication uses SRP (Secure Remote Password) — the password never leaves
your machine. Session tokens are stored in GNOME Keyring, not on disk.

---

## Security notes

- Passwords are never stored. Only access + refresh tokens are persisted, in GNOME Keyring.
- All Drive operations go through Proton's SDK; no direct API calls bypass it.
- Every request carries `x-pm-appversion: external-drive-protondrive-linux@0.1.0-alpha`
  as required by Proton's terms.
- This is personal-use software. Proton's SDK terms prohibit commercial use without agreement.

---

## Known limitations

- **System tray requires** `gnome-shell-extension-appindicator` on GNOME Shell
  (installed by default on Ubuntu 22.04+).
- **Single account only** — no multi-account support.
- Proton's SDK has a breaking crypto change coming (ETA late 2026). All SDK calls
  are isolated in `src/lib/drive.ts` to minimise the migration surface.

---

## References

Authentication (SRP) and sync behaviour were cross-referenced against Proton's
own open-source code:

- [ProtonDriveApps/win-drive](https://github.com/ProtonDriveApps/win-drive) —
  Windows Drive client (C#). Reference for token refresh, revision upload,
  rename/move handling, and write-stability detection.
- [ProtonMail/WebClients](https://github.com/ProtonMail/WebClients) —
  Web apps monorepo. Reference for SRP implementation and address key derivation.

Neither codebase was copied — they were read for behaviour and protocol details.

---

## Contributing

PRs and issues are welcome. This is a personal project and response time may vary.
If you hit a bug or want to discuss an approach before writing code, open an issue first.

---

## Credits

Co-created with [Claude](https://claude.ai) (Anthropic) as a learning project for
Tauri + Linux desktop integration.
