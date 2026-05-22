# Proton Drive Linux Sync

> **Unofficial, non-commercial.** This project is not affiliated with or supported by Proton AG.
> Proton has announced an official Linux client; this fills the gap in the meantime.

A desktop sync client for [Proton Drive](https://proton.me/drive) on Linux, built with Tauri v2.
It syncs a local folder against your Drive using Proton's own JS SDK, so end-to-end encryption
is handled entirely by Proton's code.

---

## Status

Working prototype. The core sync loop runs but has known gaps — see [PLAN.md](PLAN.md).

| Feature | State |
|---------|-------|
| Login (SRP + 2FA) | ✅ |
| Session restore from keyring | ✅ |
| Onboarding: pick local folder + Drive folders | ✅ |
| Conflict resolution wizard | ✅ |
| Upload new files | ✅ |
| Upload modified files (revisions) | ✅ |
| Download new/changed Drive files | ✅ |
| Remote rename/move → local rename | ✅ |
| Token refresh on 401 | ✅ |
| System tray, autostart | ✅ |
| Recursive folder sync on cold start | ⚠️ subdirs missed ([G1](PLAN.md)) |
| Local deletes → Drive | ❌ not implemented ([G4](PLAN.md)) |
| Large file streaming | ❌ full base64 round-trip ([G2](PLAN.md)) |

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

**Proton Drive SDK** — clone alongside this repo:

```bash
git clone https://github.com/ProtonDriveApps/sdk.git ../sdk
cd ../sdk/js/sdk && npm install && npm run build
```

---

## Development

```bash
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
write to finish) → read file → SDK encrypts + uploads → SQLite updated.

**Drive → local:** SDK Drive event subscription → compare revision ID against
SQLite → download + decrypt → write to local path → SQLite updated.

Anti-loop: files written locally by a Drive download are suppressed from
re-upload for 5 seconds.

Authentication uses SRP (Secure Remote Password) — the password never leaves
your machine. Session tokens are stored in GNOME Keyring, not on disk.

---

## Security notes

- Passwords are never stored. Only access + refresh tokens are persisted, in GNOME Keyring.
- All Drive operations go through Proton's SDK; no direct API calls bypass it.
- Every request carries `x-pm-appversion: external-drive-protondrive@0.1.0-alpha`
  as required by Proton's terms.
- This is personal-use software. Proton's SDK terms prohibit commercial use without agreement.

---

## Known limitations

- **Local deletes are not synced to Drive** (files deleted locally stay in Drive).
- **Recursive folders miss subdirectories on cold start** (fixed after first watcher event).
- **No streaming for large files** — files are buffered in full through IPC.
- **System tray requires** `gnome-shell-extension-appindicator` on GNOME Shell.
- **Single account only** — no multi-account support.
- Proton's SDK has a breaking crypto change coming (ETA late 2026). All SDK calls
  are isolated in `src/lib/drive.ts` to minimise the migration surface.
