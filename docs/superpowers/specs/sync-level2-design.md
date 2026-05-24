# Sync Engine Level 2 Test Design (Pinned)

*Date: 2026-05-24*

## What is Level 2

Level 1 tests (implemented in Task 5–8) cover individual handler functions called in
isolation. Level 2 tests cover the full startup and subscription lifecycle:
`startSync`, `initialSyncLocalFolder`, `initialSyncRemoteFolder`, `triggerFullSync`.

## Why Pinned

`startSync` calls `listen("sync://local-change", ...)` from `@tauri-apps/api/event`.
To fire synthetic local-change events in tests we need mockIPC with `shouldMockEvents: true`
and `emit("sync://local-change", payload)`. This is available in @tauri-apps/api/mocks
since version 2.7.0, but requires careful setup.

## Flows to Test

### startSync() lifecycle
- Calls `get_local_root` and `get_db_sync_config("selected_folders")` via IPC
- Calls `getSyncRoot()` from Drive SDK
- Calls `buildWatchedFolderMap` → `expandFolderUids` → `listFolderChildren`
- Registers Drive event subscription via `subscribeToTreeEvents`
- Registers local-change Tauri listener via `listen("sync://local-change", ...)`
- Returns a cleanup function that calls `unlisten()`, `subscription.dispose()`,
  and `clearInterval(periodicInterval)`

### initialSyncLocalFolder()
- Calls `list_dir_recursive` for `mode === "recursive"` folders
- Calls `list_local_dir` for `mode === "files"` folders
- Calls `handleLocalUpsert(path, false)` for each returned entry

### initialSyncRemoteFolder()
- Calls `listFolderChildren` for each watched folder
- Skips files where `etag` matches the existing DB revision uid
- Calls `handleRemoteNodeUpdate` for changed/new files

### triggerFullSync()
- Is a no-op when `watchedFolderUids` is empty
- Is a no-op when `_fullSyncInProgress` is already true (concurrent call guard)
- Calls `cleanStaleDbEntries` → `initialSyncFolder` → `initialSyncLocalFolder`

## Mock Setup for Level 2

```typescript
// @vitest-environment jsdom
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

mockIPC(myHandler, { shouldMockEvents: true });

// Simulate a local-change event:
await emit("sync://local-change", { absPath: "/home/test/ProtonDrive/file.txt", kind: "create" });
```

## Prerequisite

Verify `@tauri-apps/api` version supports `shouldMockEvents`:
```bash
node -e "const m = require('./node_modules/@tauri-apps/api/mocks.d.ts'); console.log('ok')" 2>/dev/null || grep shouldMockEvents node_modules/@tauri-apps/api/mocks.d.ts
```

`shouldMockEvents` was added in @tauri-apps/api 2.7.0.
