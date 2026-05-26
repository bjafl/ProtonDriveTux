# Test Suite Improvement Design — Proton Drive Linux Sync

*Date: 2026-05-24*

## Background

The test suite covers pure helper functions and Rust file commands (105 tests total), but
the core sync engine (`src/lib/sync.ts`, 864 lines) has zero coverage. The two highest-priority
gaps are:

1. **`sync.ts` handler logic** — upload, download, delete, directory operations, anti-loop
   suppression. This is the most business-critical code in the application.
2. **`within_sync_root` path guard** — security-critical Rust code added in commit `9b3b82d`
   that prevents path traversal attacks. Guard logic is untested.

Secondary gap: `auth.rs` has a trivial `InvalidConfig` variant that is easy to test without
network mocking.

## Goals

- Cover all Level 1 handler flows in `sync.ts`: local→remote upload, remote→local download,
  delete, directory operations, anti-loop suppression
- Test `within_sync_root` and `canonical` (path traversal guards) in Rust
- Add trivial test for `auth.rs` invalid header rejection
- Target ~65% overall TypeScript coverage (from current ~48%)

## Non-Goals (Level 2 — pinned for later)

These require wiring the full event subscription lifecycle and are deferred:

- `startSync()` / `stopSync()` lifecycle
- `initialSyncLocalFolder` / `initialSyncRemoteFolder` startup orchestration
- `triggerFullSync` / `cleanStaleDbEntries` reconciliation
- React component tests (ConflictWizard, FolderTree, etc.)
- Watcher debounce timing tests

See `docs/superpowers/specs/sync-level2-design.md` for Level 2 design notes.

---

## Design Decisions

### D1: Tauri `mockIPC` + per-file jsdom annotation

`@tauri-apps/api/mocks` exports `mockIPC(cb)` which intercepts all `invoke()` calls at
the Tauri internals level. `// @vitest-environment jsdom` on the handler test file keeps all
existing node-environment tests unchanged — no global config modification needed.

**Rejected: Extract all invoke() calls to an injected adapter.** Makes production code harder
to read and adds indirection that doesn't improve the actual test quality.

**Rejected: Global jsdom environment in vite.config.ts.** Would break existing node tests
that rely on node globals and don't need a DOM.

### D2: `@internal` exports from sync.ts

Handler functions (`handleLocalChange`, `handleLocalUpsert`, etc.) are exported with a
`@internal` JSDoc tag. Tests import them directly. No public-API surface change.

**Rejected: Extract handlers to a separate `syncHandlers.ts` file.** Requires moving
all module-level state and helpers that the handlers depend on, which is a large restructuring
that adds complexity without improving testability proportionally.

### D3: Module-level state reset function

`_resetSyncStateForTesting()` clears all module state between tests:
`suppressUntil`, `recentlyUploaded`, `watchedFolderUids`, `_paused`,
`_fullSyncInProgress`, `_status`, `_statusCallback`, `_trayUpdateTimer`.

This is cleaner than dependency injection for state the module owns completely.
The leading `_` and `@internal` comment signal test-only access.

### D4: `syncDecisions.ts` for pure decision logic

`guessMimeType()` and `isAlreadySynced()` are extracted as pure functions (no I/O).
These encode the most important upload decision logic and benefit most from isolated testing.
They are imported back into `sync.ts` — zero behavior change.

### D5: `fetch` stub for `pd-file://` protocol

`handleLocalUpsert` uses `fetch("pd-file://...")` to read file bytes. In jsdom, `fetch`
is not available by default and does not understand `pd-file://`. Tests stub it:

```typescript
vi.stubGlobal("fetch", vi.fn());
vi.mocked(fetch).mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["x"])) } as Response);
```

Cleaned up with `vi.unstubAllGlobals()` in `afterEach`.

---

## New Files

| File | Purpose |
|------|---------|
| `src/lib/syncDecisions.ts` | Pure: `FileStat` type, `guessMimeType`, `isAlreadySynced` |
| `src/__tests__/syncDecisions.test.ts` | 12 tests for the above; node environment |
| `src/__tests__/helpers/syncMocks.ts` | `setupIpcMocks()`, Drive SDK `vi.fn()` exports |
| `src/__tests__/syncHandlers.test.ts` | 14+ handler integration tests; jsdom environment |
| `docs/superpowers/specs/sync-level2-design.md` | Level 2 design notes (pinned) |

## Modified Files

| File | Change |
|------|--------|
| `src/lib/sync.ts` | Import from syncDecisions; export 7 handlers + 2 test utilities |
| `package.json` | Add jsdom devDependency |
| `src-tauri/src/commands.rs` | Add 7 tests for `canonical()` and `within_sync_root()` |
| `src-tauri/src/auth.rs` | Add 3 tests for `ProtonAuth::new` |

---

## Handler Test Scenarios

### handleLocalChange

| Scenario | Key assertion |
|----------|--------------|
| Path ends with `.pd-tmp` | invoke never called |
| `_paused` is true | fetch never called |
| Path is in `suppressUntil` map | handlers not invoked |
| `kind === "delete"` + file in DB | `trashNode` called with correct remoteId |
| `stat.isDir === true`, `kind === "create"` | `findOrCreateFolder` called |
| Regular file create/modify | `handleLocalUpsert` dispatched |

### handleLocalUpsert

| Scenario | Key assertion |
|----------|--------------|
| File not under any watched folder | `fetch` never called |
| `isAlreadySynced` returns true | `fetch` never called |
| No DB entry (new file) | `getFileUploader` called; DB upserted |
| DB entry exists (revision) | `getFileRevisionUploader` called |
| `waitForFileStable` returns null | `fetch` never called |

### handleRemoteDelete

| Scenario | Key assertion |
|----------|--------------|
| Node UID in `get_file_state_by_remote_id` | `delete_local_file` + `delete_file_state` called |
| Node UID in `watchedFolderUids` | `delete_local_dir` called for that dir |
| Unknown node — `getNode` SDK resolves it | `delete_local_dir` called for resolved path |

### handleRemoteNodeUpdate

| Scenario | Key assertion |
|----------|--------------|
| parentUid not in `watchedFolderUids` | `streamDownloadToPath` not called |
| Revision matches existing DB entry | `streamDownloadToPath` not called |
| Revision differs from DB | `streamDownloadToPath` called |
| `node.type === Folder` | `ensure_local_dir` called |

### Rust path guard tests

| Test | Asserts |
|------|---------|
| `canonical_returns_canonical_path_for_existing_file` | Result is absolute and exists |
| `canonical_resolves_nonexistent_file_in_existing_parent` | Returns correct filename without error |
| `canonical_fails_when_parent_dir_does_not_exist` | Returns Err containing "canonicalize parent" |
| `within_sync_root_accepts_path_inside_root` | Returns Ok(()) |
| `within_sync_root_rejects_path_outside_root` | Returns Err containing "outside sync root" |
| `within_sync_root_rejects_dotdot_traversal` | Returns Err (canonical sees through `..`) |
| `within_sync_root_returns_error_when_root_not_configured` | Returns Err containing "not configured" |

### auth.rs tests

| Test | Asserts |
|------|---------|
| `new_succeeds_with_valid_app_version` | Returns Ok |
| `new_returns_error_for_app_version_with_newline` | Returns Err, message contains "invalid header characters" |
| `new_returns_error_for_app_version_with_null_byte` | Returns Err |

---

## Expected Coverage After Implementation

| Layer | Before | After |
|-------|--------|-------|
| Pure TS helpers | ✅ ~100% | ✅ ~100% |
| Rust DB | ✅ ~90% | ✅ ~90% |
| Rust file commands | ✅ ~80% | ✅ ~85% (guards added) |
| `within_sync_root` / `canonical` | 0% | ~90% |
| `auth.rs` | 0% | ~70% |
| `sync.ts` handlers (Level 1) | 0% | ~60% |
| `sync.ts` startup (Level 2) | 0% | 0% (pinned) |
| **Overall TypeScript** | ~48% | **~65%** |
