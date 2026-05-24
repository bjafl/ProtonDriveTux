# Frontend Refactor + Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/App.tsx` (539 lines) into focused files; configure a Content Security Policy in `tauri.conf.json`; add debug logging to `src-tauri/src/keyring.rs` so keyring failures are visible in logs instead of silently returning `None`.

**Architecture:** `App.tsx` becomes a pure router/state-machine (the `App()` function and its 5-state enum). The `MainView` component (lines 158–458) moves to `src/components/Dashboard.tsx`. Two custom hooks (`useSyncStatus` and `useFileStates`) extract the async-init logic and file-list state from Dashboard. The CSP is a one-line change in `tauri.conf.json`. Keyring logging is a mechanical `eprintln!` addition to `keyring.rs`.

**Tech Stack:** React 19, TypeScript 5, Tauri v2. All 81 TypeScript tests and all 63 Rust tests must pass after every task that touches compilable code.

---

## File Structure

**Create:**
- `src/hooks/useSyncStatus.ts` — encapsulates the sync lifecycle init effect: `syncStatus`, `syncPaused`, `syncPath`, `driveFolders`, `localEvents`, `stopSyncRef`; returns handlers `handleLogout`, `handleFullSync`, `togglePause`
- `src/hooks/useFileStates.ts` — encapsulates the `fileStates` list and its `refresh` callback

**Modify:**
- `src/App.tsx` — remove `MainView`; import it from `"./components/Dashboard"` instead
- `src/components/Dashboard.tsx` — new file: current `MainView` body verbatim, but uses `useSyncStatus` and `useFileStates` hooks; type `LocalEvent` and `syncStateBadge` helper stay here
- `src-tauri/tauri.conf.json` — set `"csp"` to a minimal restrictive policy
- `src-tauri/src/keyring.rs` — add `eprintln!` on each `?` / `.ok()?` failure point

**No changes to:**
- `src/lib/sync.ts` (or sync/ directory — handled in Plan B)
- `src-tauri/src/commands.rs` (handled in Plan A)

---

## Task 1: Extract `MainView` to `components/Dashboard.tsx`

This is a pure rename-and-move. No logic changes, no new hooks yet.

**Files:**
- Modify: `src/App.tsx` (remove MainView, add import)
- Create: `src/components/Dashboard.tsx`

- [ ] **Step 1: Create `src/components/Dashboard.tsx`**

Copy the `MainView` function from `App.tsx` and rename it to `Dashboard`. Also move the `syncStateBadge` helper and `LocalEvent` type to the same file, since they are only used by `Dashboard`.

```tsx
// src/components/Dashboard.tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  startSync, setSyncStatusCallback, triggerFullSync, pauseSync, resumeSync, isSyncPaused,
} from "../lib/sync";
import type { SyncStatus, WatchEvent, FileState, SelectedFolderRecord } from "../lib/sync";
import { setSessionExpiredCallback, releaseDriveClient } from "../lib/drive";
import { defaultSyncPath } from "../lib/paths";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";

interface LocalEvent {
  absPath: string;
  kind: string;
  time: string;
}

function syncStateBadge(state: string): { label: string; color: string } {
  // ... (copy verbatim from App.tsx lines 140–156)
}

export function Dashboard({
  onSessionExpired,
  onOpenOnboarding,
}: {
  onSessionExpired: () => void;
  onOpenOnboarding: () => void;
}) {
  // ... (copy the entire MainView body verbatim, no changes)
}
```

- [ ] **Step 2: Update `src/App.tsx`**

Replace the `MainView` function body with an import from Dashboard, and update the render call:

```tsx
// Remove: the entire MainView function (lines 158–459) and LocalEvent type, syncStateBadge helper
// Add at top with other imports:
import { Dashboard } from "./components/Dashboard";

// In App() render, replace:
//   <MainView onSessionExpired={...} onOpenOnboarding={...} />
// with:
//   <Dashboard onSessionExpired={...} onOpenOnboarding={...} />
```

After the change, `App.tsx` contains only:
- The imports
- `AuthStatus`, `SessionTokens`, `AppState` type declarations
- `UnlockForm` component (lines 36–156) — this stays in App.tsx for now
- `App()` default export function

- [ ] **Step 3: Type-check and test**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: 0 type errors, 81 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/Dashboard.tsx src/App.tsx
git commit -m "refactor: extract MainView to Dashboard.tsx"
```

---

## Task 2: Extract `useSyncStatus` hook

Extract the large `useEffect` in `Dashboard` into a custom hook. The hook owns: startSync lifecycle, syncStatus, syncPaused, syncPath, driveFolders, localEvents, and the derived handlers.

**Files:**
- Create: `src/hooks/useSyncStatus.ts`
- Modify: `src/components/Dashboard.tsx`

- [ ] **Step 1: Create `src/hooks/useSyncStatus.ts`**

```typescript
// src/hooks/useSyncStatus.ts
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  startSync, setSyncStatusCallback, triggerFullSync, pauseSync, resumeSync, isSyncPaused,
} from "../lib/sync";
import type { SyncStatus, WatchEvent, SelectedFolderRecord } from "../lib/sync";
import { setSessionExpiredCallback, releaseDriveClient } from "../lib/drive";
import { defaultSyncPath } from "../lib/paths";

interface LocalEvent {
  absPath: string;
  kind: string;
  time: string;
}

interface SyncStatusHookResult {
  syncStatus: SyncStatus;
  syncPaused: boolean;
  syncPath: string;
  driveFolders: string[];
  localEvents: LocalEvent[];
  syncingFull: boolean;
  handleLogout: () => Promise<void>;
  handleFullSync: () => Promise<void>;
  togglePause: () => void;
}

export function useSyncStatus(
  onSessionExpired: () => void,
  onFileStatesChanged: () => void,
): SyncStatusHookResult {
  const [syncPath, setSyncPath] = useState<string>("");
  const [driveFolders, setDriveFolders] = useState<string[]>([]);
  const [localEvents, setLocalEvents] = useState<LocalEvent[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ active: [], errors: [] });
  const [syncingFull, setSyncingFull] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const stopSyncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlistenLocal: (() => void) | null = null;
    let unlistenPauseTray: (() => void) | null = null;

    setSessionExpiredCallback(onSessionExpired);

    async function init() {
      const [localRoot, selectedFoldersJson] = await Promise.all([
        invoke<string | null>("get_local_root"),
        invoke<string | null>("get_db_sync_config", { key: "selected_folders" }),
      ]);
      if (cancelled) return;

      if (selectedFoldersJson) {
        try {
          const folders = JSON.parse(selectedFoldersJson) as SelectedFolderRecord[];
          setDriveFolders(folders.map((f) => f.name));
        } catch { /* ignore malformed JSON */ }
      }

      if (!localRoot) {
        setSyncPath(await defaultSyncPath());
        return;
      }
      setSyncPath(localRoot);

      setSyncStatusCallback((s) => {
        if (!cancelled) {
          setSyncStatus({ ...s });
          onFileStatesChanged();
        }
      });

      await invoke("start_file_watcher", { path: localRoot }).catch(console.error);
      const stop = await startSync();
      if (cancelled) { stop(); return; }
      stopSyncRef.current = stop;

      onFileStatesChanged();

      unlistenPauseTray = await listen("sync://pause-toggle", () => {
        if (cancelled) return;
        if (isSyncPaused()) {
          resumeSync();
          setSyncPaused(false);
        } else {
          pauseSync();
          setSyncPaused(true);
        }
      });

      unlistenLocal = await listen<WatchEvent>("sync://local-change", (e) => {
        if (cancelled) return;
        setLocalEvents((prev) =>
          [
            { absPath: e.payload.absPath, kind: e.payload.kind, time: new Date().toLocaleTimeString() },
            ...prev,
          ].slice(0, 30),
        );
      });
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
      setSessionExpiredCallback(null);
      unlistenPauseTray?.();
      unlistenLocal?.();
      stopSyncRef.current?.();
      stopSyncRef.current = null;
    };
  }, [onSessionExpired, onFileStatesChanged]);

  const handleLogout = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    window.location.reload();
  };

  const handleFullSync = async () => {
    setSyncingFull(true);
    try {
      await triggerFullSync();
    } finally {
      setSyncingFull(false);
    }
  };

  const togglePause = () => {
    if (syncPaused) { resumeSync(); setSyncPaused(false); }
    else { pauseSync(); setSyncPaused(true); }
  };

  return { syncStatus, syncPaused, syncPath, driveFolders, localEvents, syncingFull, handleLogout, handleFullSync, togglePause };
}
```

- [ ] **Step 2: Update `src/components/Dashboard.tsx`**

Replace the inline `useEffect` and related state with the hook:

```tsx
// Remove: useState for syncPath, driveFolders, localEvents, syncStatus, syncingFull, syncPaused
// Remove: stopSyncRef, the entire large useEffect, handleLogout, handleFullSync
// Remove: imports for listen, startSync, setSyncStatusCallback, etc. (now in hook)

// Add:
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useFileStates } from "../hooks/useFileStates";

export function Dashboard({ onSessionExpired, onOpenOnboarding }: ...) {
  const { fileStates, refreshFileStates } = useFileStates();
  const {
    syncStatus, syncPaused, syncPath, driveFolders, localEvents, syncingFull,
    handleLogout, handleFullSync, togglePause,
  } = useSyncStatus(onSessionExpired, refreshFileStates);

  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    invoke<boolean>("get_autostart_enabled").then(setAutostartEnabled).catch(console.error);
  }, []);

  // ... JSX unchanged, but replace inline handlers with hook-provided ones:
  // togglePause() instead of the inline if/else
  // handleFullSync() instead of inline
  // handleLogout() instead of inline
}
```

- [ ] **Step 3: Type-check and test**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: 0 errors, 81 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSyncStatus.ts src/components/Dashboard.tsx
git commit -m "refactor: extract useSyncStatus hook from Dashboard"
```

---

## Task 3: Extract `useFileStates` hook

**Files:**
- Create: `src/hooks/useFileStates.ts`
- Modify: `src/components/Dashboard.tsx`

- [ ] **Step 1: Create `src/hooks/useFileStates.ts`**

```typescript
// src/hooks/useFileStates.ts
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileState } from "../lib/sync";

interface FileStatesHookResult {
  fileStates: FileState[];
  refreshFileStates: () => Promise<void>;
}

export function useFileStates(): FileStatesHookResult {
  const [fileStates, setFileStates] = useState<FileState[]>([]);

  const refreshFileStates = useCallback(async () => {
    try {
      const files = await invoke<FileState[]>("get_all_file_states");
      setFileStates(files);
    } catch { /* ignore */ }
  }, []);

  return { fileStates, refreshFileStates };
}
```

- [ ] **Step 2: Update `src/components/Dashboard.tsx`**

The `useSyncStatus` hook already accepts `onFileStatesChanged: () => void` as its second argument. Pass `refreshFileStates` from `useFileStates` as that callback.

Since `refreshFileStates` is created with `useCallback(async () => ..., [])`, its reference is stable — passing it to `useSyncStatus` does not cause infinite re-renders.

Confirm Dashboard now reads:
```tsx
const { fileStates, refreshFileStates } = useFileStates();
const { ... } = useSyncStatus(onSessionExpired, refreshFileStates);
// remove: useState<FileState[]>, the separate refreshFileStates function body
```

- [ ] **Step 3: Remove unused imports from Dashboard.tsx**

After extracting both hooks, `Dashboard.tsx` should import only:
- `useState`, `useEffect` (for autostart toggle only)
- `invoke` (for autostart toggle)
- `useLang`, `useTheme`
- `useSyncStatus`, `useFileStates`
- `syncStateBadge` helper (kept locally)
- Type `FileState` (for `syncStateBadge`'s badge output)

All sync-related imports (`startSync`, `setSyncStatusCallback`, `listen`, `releaseDriveClient`, etc.) move to `useSyncStatus.ts`.

- [ ] **Step 4: Type-check and test**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: 0 errors, 81 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useFileStates.ts src/components/Dashboard.tsx
git commit -m "refactor: extract useFileStates hook; Dashboard now uses two focused hooks"
```

---

## Task 4: Configure Content Security Policy

`tauri.conf.json` currently has `"csp": null` — this disables the CSP entirely, giving the WebView no content-security boundary. This task enables a restrictive baseline CSP.

**Files:**
- Modify: `src-tauri/tauri.conf.json:33`

- [ ] **Step 1: Understand the app's resource requirements**

The React frontend:
- Loads its own bundles (script, style, images) — `'self'`
- Communicates with Tauri via `ipc://localhost` — must be in `connect-src`
- Does NOT make direct `fetch()` calls to Proton API (all HTTP goes through `tauri-plugin-http` in Rust)
- Uses Tailwind CSS with some inline style attributes — `'unsafe-inline'` only for `style-src`
- Loads icons as data URIs (`data:`) or SVGs from bundled assets

- [ ] **Step 2: Write the CSP string**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost
```

**Why each directive:**
- `default-src 'self'` — blocks external resources by default
- `script-src 'self'` — only bundled scripts; no inline scripts, no eval
- `style-src 'self' 'unsafe-inline'` — Tailwind utility classes on elements use `style=""` attributes
- `img-src 'self' data: blob:` — allows inline SVG icons and data URIs
- `connect-src ipc: http://ipc.localhost` — Tauri v2 IPC channel

- [ ] **Step 3: Update `tauri.conf.json`**

Change line 33:
```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost"
}
```

- [ ] **Step 4: Smoke test in dev mode**

```bash
cargo tauri dev &
# Open DevTools console, confirm no CSP violation errors on load.
# Navigate through: loading → login form → (if session available) dashboard
# Kill dev server when done.
```
Expected: no CSP violations in the DevTools console.

If you see a CSP violation for a specific resource, add the minimum necessary directive to permit it. Log what was blocked and why it is safe to allow.

- [ ] **Step 5: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml && pnpm test
```
Expected: all tests pass (CSP is a runtime-only setting, no test impact).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "security: enable restrictive CSP in tauri.conf.json (was null)"
```

---

## Task 5: Add debug logging to `keyring.rs`

Currently `load_session()` and `load_key_password()` silently return `None` if GNOME Keyring is unavailable or an item is not found. This makes it impossible to distinguish "no saved session" from "keyring daemon not running". This task adds `eprintln!` to each failure point.

**Files:**
- Modify: `src-tauri/src/keyring.rs`

- [ ] **Step 1: Add logging to `load_session`**

Replace the current `load_session` (lines 39–49):

```rust
pub async fn load_session() -> Option<AuthSession> {
    let ss = SecretService::connect(EncryptionType::Dh).await
        .map_err(|e| eprintln!("[keyring] Failed to connect to Secret Service: {e}"))
        .ok()?;
    let collection = ss.get_default_collection().await
        .map_err(|e| eprintln!("[keyring] Failed to get default collection: {e}"))
        .ok()?;
    collection.unlock().await
        .map_err(|e| eprintln!("[keyring] Failed to unlock collection: {e}"))
        .ok()?;

    let items = collection.search_items(session_attrs()).await
        .map_err(|e| eprintln!("[keyring] Failed to search for session item: {e}"))
        .ok()?;
    let item = items.first()?;
    let bytes = item.get_secret().await
        .map_err(|e| eprintln!("[keyring] Failed to read session secret: {e}"))
        .ok()?;

    serde_json::from_slice(&bytes)
        .map_err(|e| eprintln!("[keyring] Failed to deserialize session: {e}"))
        .ok()
}
```

- [ ] **Step 2: Add logging to `load_key_password`**

Replace the current `load_key_password` (lines 86–94):

```rust
pub async fn load_key_password() -> Option<String> {
    let ss = SecretService::connect(EncryptionType::Dh).await
        .map_err(|e| eprintln!("[keyring] Failed to connect to Secret Service: {e}"))
        .ok()?;
    let collection = ss.get_default_collection().await
        .map_err(|e| eprintln!("[keyring] Failed to get default collection: {e}"))
        .ok()?;
    collection.unlock().await
        .map_err(|e| eprintln!("[keyring] Failed to unlock collection: {e}"))
        .ok()?;
    let items = collection.search_items(key_password_attrs()).await
        .map_err(|e| eprintln!("[keyring] Failed to search for key password item: {e}"))
        .ok()?;
    let item = items.first()?;
    let bytes = item.get_secret().await
        .map_err(|e| eprintln!("[keyring] Failed to read key password secret: {e}"))
        .ok()?;
    String::from_utf8(bytes)
        .map_err(|e| eprintln!("[keyring] Key password is not valid UTF-8: {e}"))
        .ok()
}
```

- [ ] **Step 3: Run Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass (the logging functions don't affect test logic).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/keyring.rs
git commit -m "fix: add eprintln! debug logging to keyring load functions for diagnosing keyring failures"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml && pnpm test
```
Expected: 63 Rust + 81 TypeScript = 144 total tests pass.

- [ ] **Step 2: Verify App.tsx line count**

```bash
wc -l src/App.tsx src/components/Dashboard.tsx src/hooks/useSyncStatus.ts src/hooks/useFileStates.ts
```
Expected: `App.tsx` ≤ 120 lines; `Dashboard.tsx` ≤ 200 lines; each hook ≤ 100 lines.

- [ ] **Step 3: Type-check clean**

```bash
pnpm tsc --noEmit
```
Expected: no errors.
