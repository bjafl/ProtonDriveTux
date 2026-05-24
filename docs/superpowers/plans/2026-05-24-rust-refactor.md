# Rust Backend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src-tauri/src/commands.rs` (1,523 lines, 8 mixed concerns) into focused submodules, extract path-safety helpers into their own file, and translate all Norwegian user-visible strings in the Rust layer to English.

**Architecture:** Convert the flat `commands.rs` into a `commands/` directory module. `commands/mod.rs` holds shared types (`CommandError`, `AppState`, `AuthStatus`, `SessionTokens`, `FileStat`, `RecentFile`, `TrayStatusPayload`) and re-exports every public command function via `pub use`. Each concern lives in its own file (`auth.rs`, `db.rs`, `file.rs`, `config.rs`, `watcher.rs`, `ui.rs`). Path-safety helpers move to `commands/guards.rs` (private to the module, `pub(super)` visibility). Because `lib.rs` uses `commands::*`, no changes are needed there beyond the module declaration pointing to the new directory.

**Tech Stack:** Rust stable, Tauri v2, existing Cargo.toml dependencies unchanged. All 63 existing `cargo test` cases must pass after every task.

---

## File Structure

**Create:**
- `src-tauri/src/commands/mod.rs` — shared types + `pub use` re-exports of all public commands
- `src-tauri/src/commands/guards.rs` — `canonical`, `within_sync_root`, `ensure_parent` + their tests
- `src-tauri/src/commands/auth.rs` — `store_tokens`, `logout`, `get_auth_status`, `get_session_tokens`, `store_key_password`, `get_key_password`, `restore_session_from_keyring`, `open_captcha_window`, `close_captcha_window`
- `src-tauri/src/commands/db.rs` — `get_all_file_states`, `upsert_file_state`, `set_file_sync_state`, `get_file_state_by_remote_id`, `get_file_state_by_local_path`, `get_db_sync_config`, `set_db_sync_config`, `delete_file_state`, `clear_all_file_states`
- `src-tauri/src/commands/file.rs` — `ensure_local_dir`, `list_local_dir`, `read_local_file`, `write_local_file`, `truncate_local_file`, `write_local_file_chunk`, `trash_local_file`, `delete_local_file`, `delete_local_dir`, `stat_local_file`, `rename_local_file`, `list_dir_recursive`; private helpers `do_list_local_dir`, `do_read_local_file`, `do_write_local_file`, `do_trash`, `do_delete_local_file`, `do_delete_local_dir`, `do_stat_local_file`, `do_rename_local_file`, `collect_recursive`; file.rs unit tests
- `src-tauri/src/commands/config.rs` — `validate_local_root`, `set_local_root`, `get_local_root`, `get_home_dir`; private `count_files_capped`, `SYSTEM_DIRS`, `LocalRootInfo` type; config + validate tests
- `src-tauri/src/commands/watcher.rs` — `start_file_watcher`, `stop_file_watcher`
- `src-tauri/src/commands/ui.rs` — `show_notification`, `get_autostart_enabled`, `enable_autostart`, `disable_autostart`, `update_tray_status`, `get_tray_status`, `show_main_window`, `emit_pause_toggle`, `suppress_appindicator_warning`; private `autostart_path`

**Modify:**
- `src-tauri/src/lib.rs` — update initial tray menu Norwegian strings; no import changes needed
- `src-tauri/src/keyring.rs` — translate 2 Norwegian error message strings

**Delete:**
- `src-tauri/src/commands.rs` (replaced by commands/ directory)

---

## Task 1: Fix Norwegian strings

**Files:**
- Modify: `src-tauri/src/keyring.rs:12-14`
- Modify: `src-tauri/src/lib.rs:177-180`

- [ ] **Step 1: Fix `keyring.rs` error strings**

Replace lines 11–16:
```rust
#[derive(Debug, Error)]
pub enum KeyringError {
    #[error("Secret Service error: {0}")]
    SecretService(#[from] secret_service::Error),
    #[error("Serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}
```

- [ ] **Step 2: Fix `lib.rs` initial tray menu**

Replace the four `MenuItem::with_id` calls in `setup_tray` (lines ~177–181):
```rust
let status = MenuItem::with_id(app, "status", "✓  Synced", false, None::<&str>)?;
let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
```

- [ ] **Step 3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/keyring.rs src-tauri/src/lib.rs
git commit -m "fix: translate Norwegian strings in keyring.rs and lib.rs tray setup to English"
```

---

## Task 2: Convert commands.rs to commands/ directory module

This task converts the flat file to a directory module without changing any behaviour.

**Files:**
- Create: `src-tauri/src/commands/` (directory)
- Create: `src-tauri/src/commands/mod.rs` (all content from commands.rs as-is, plus submodule declarations)
- Delete: `src-tauri/src/commands.rs`

- [ ] **Step 1: Create the directory and write `commands/mod.rs`**

Create `src-tauri/src/commands/mod.rs` with **exactly** the content of the current `src-tauri/src/commands.rs` (copy verbatim), then add module declarations at the top (after the `use` imports):

```rust
// At the top of mod.rs, after existing use statements:
mod guards;
mod auth;
mod db;
mod file;
mod config;
mod watcher;
mod ui;
```

Keep all existing code in mod.rs for now — submodule files will be empty stubs so it compiles.

- [ ] **Step 2: Create empty stub files**

Create each of these files with just a comment (content will be filled in subsequent tasks):
```bash
touch src-tauri/src/commands/guards.rs
touch src-tauri/src/commands/auth.rs
touch src-tauri/src/commands/db.rs
touch src-tauri/src/commands/file.rs
touch src-tauri/src/commands/config.rs
touch src-tauri/src/commands/watcher.rs
touch src-tauri/src/commands/ui.rs
```

- [ ] **Step 3: Delete the old flat file**

```bash
rm src-tauri/src/commands.rs
```

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass. The code is unchanged — just moved.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/
git rm src-tauri/src/commands.rs
git commit -m "refactor: convert commands.rs to commands/ directory module"
```

---

## Task 3: Extract `commands/guards.rs`

Move the three path-safety helpers and their tests from `commands/mod.rs` to `commands/guards.rs`. These helpers are private to the commands module.

**Files:**
- Create/Fill: `src-tauri/src/commands/guards.rs`
- Modify: `src-tauri/src/commands/mod.rs` (remove moved functions; add `pub(super) use guards::{canonical, within_sync_root, ensure_parent};`)

- [ ] **Step 1: Write `commands/guards.rs`**

```rust
use crate::db::Db;
use super::CommandError;

/// Resolves `path` to a canonical, symlink-free form.
/// If the path does not yet exist (e.g. a `.pd-tmp` file about to be created),
/// canonicalises the parent directory and appends the filename component instead.
pub(super) fn canonical(path: &str) -> Result<std::path::PathBuf, CommandError> {
    let p = std::path::Path::new(path);
    if p.exists() {
        return std::fs::canonicalize(p)
            .map_err(|e| CommandError::Other(format!("canonicalize {path}: {e}")));
    }
    let parent = p
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| CommandError::Other(format!("no parent directory for {path}")))?;
    let name = p
        .file_name()
        .ok_or_else(|| CommandError::Other(format!("no filename in {path}")))?;
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| CommandError::Other(format!("canonicalize parent of {path}: {e}")))?;
    Ok(canon_parent.join(name))
}

/// Returns `Ok(())` when `abs_path` is inside the configured sync root.
/// Prevents JS (or a compromised SDK submodule) from touching arbitrary filesystem paths.
pub(super) fn within_sync_root(abs_path: &str, db: &Db) -> Result<(), CommandError> {
    let root = db
        .get_sync_config("local_root")?
        .ok_or_else(|| CommandError::Other("sync root not configured".into()))?;
    let canon_root = std::fs::canonicalize(&root)
        .map_err(|e| CommandError::Other(format!("canonicalize sync root: {e}")))?;
    if !canonical(abs_path)?.starts_with(&canon_root) {
        return Err(CommandError::Other(format!("path outside sync root: {abs_path}")));
    }
    Ok(())
}

/// Creates all parent directories of `abs_path` if they do not already exist.
pub(super) fn ensure_parent(abs_path: &str) -> Result<(), CommandError> {
    if let Some(parent) = std::path::Path::new(abs_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CommandError::Other(format!("create_dir_all {}: {e}", parent.display())))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::fs;
    use tempfile::TempDir;

    fn make_db_with_root(root: &str) -> Db {
        let db = Db::open_in_memory().unwrap();
        db.set_sync_config("local_root", root).unwrap();
        db
    }

    #[test]
    fn canonical_returns_canonical_path_for_existing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("real.txt");
        fs::write(&file, "data").unwrap();
        let result = canonical(file.to_str().unwrap()).unwrap();
        assert!(result.is_absolute());
        assert!(result.exists());
    }

    #[test]
    fn canonical_resolves_nonexistent_file_in_existing_parent() {
        let dir = TempDir::new().unwrap();
        let ghost = dir.path().join("ghost.txt");
        let result = canonical(ghost.to_str().unwrap()).unwrap();
        assert_eq!(result.file_name().unwrap(), "ghost.txt");
        assert!(!result.exists());
    }

    #[test]
    fn canonical_fails_when_parent_directory_does_not_exist() {
        let result = canonical("/does/not/exist/anywhere/file.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("canonicalize parent"));
    }

    #[test]
    fn within_sync_root_accepts_path_inside_root() {
        let dir = TempDir::new().unwrap();
        let db = make_db_with_root(dir.path().to_str().unwrap());
        let file = dir.path().join("file.txt");
        fs::write(&file, "x").unwrap();
        assert!(within_sync_root(file.to_str().unwrap(), &db).is_ok());
    }

    #[test]
    fn within_sync_root_rejects_path_outside_root() {
        let root_dir = TempDir::new().unwrap();
        let other_dir = TempDir::new().unwrap();
        let db = make_db_with_root(root_dir.path().to_str().unwrap());
        let outside = other_dir.path().join("secret.txt");
        fs::write(&outside, "x").unwrap();
        let result = within_sync_root(outside.to_str().unwrap(), &db);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("outside sync root"));
    }

    #[test]
    fn within_sync_root_rejects_dotdot_traversal() {
        let dir = TempDir::new().unwrap();
        let db = make_db_with_root(dir.path().to_str().unwrap());
        let traversal = format!("{}/../../../etc/passwd", dir.path().display());
        assert!(within_sync_root(&traversal, &db).is_err());
    }

    #[test]
    fn within_sync_root_returns_error_when_root_not_configured() {
        let db = Db::open_in_memory().unwrap();
        let result = within_sync_root("/any/path/file.txt", &db);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not configured"));
    }

    #[test]
    fn within_sync_root_accepts_nonexistent_file_inside_root() {
        let dir = TempDir::new().unwrap();
        let db = make_db_with_root(dir.path().to_str().unwrap());
        let ghost = dir.path().join("new_file.pd-tmp");
        assert!(!ghost.exists());
        assert!(within_sync_root(ghost.to_str().unwrap(), &db).is_ok());
    }
}
```

- [ ] **Step 2: Update `commands/mod.rs`**

Remove the three helper functions (`canonical`, `within_sync_root`, `ensure_parent`) and the path guard tests from `commands/mod.rs`. Replace the functions with a use import at the top of the file:

```rust
pub(super) use guards::{canonical, within_sync_root, ensure_parent};
```

- [ ] **Step 3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass (8 path-guard tests now run from guards.rs).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/guards.rs src-tauri/src/commands/mod.rs
git commit -m "refactor: extract path-safety helpers to commands/guards.rs"
```

---

## Task 4: Extract `commands/auth.rs`

**Files:**
- Fill: `src-tauri/src/commands/auth.rs`
- Modify: `src-tauri/src/commands/mod.rs` (remove moved functions, add `pub use auth::*;`)

- [ ] **Step 1: Write `commands/auth.rs`**

Move these functions from `commands/mod.rs` to `commands/auth.rs` (keeping the same code, changing `use super::*` imports):

```rust
use tauri::{Manager, State};
use super::{AppState, CommandError, SessionTokens, AuthStatus};
use crate::{auth::ProtonAuth, db::Db, keyring};

#[tauri::command]
pub async fn store_tokens(
    uid: String,
    access_token: String,
    refresh_token: String,
    user_id: String,
    two_factor_enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // ... (copy exact body from commands/mod.rs)
}

// ... (copy store_key_password, get_key_password, logout, get_auth_status,
//      get_session_tokens, restore_session_from_keyring, open_captcha_window,
//      close_captcha_window — exact bodies unchanged)
```

The full function bodies are copied verbatim from the current `commands/mod.rs`. Add `use tauri::Manager;` and other needed imports at the top.

- [ ] **Step 2: Update `commands/mod.rs`**

Remove the auth functions from mod.rs and add:
```rust
pub use auth::{
    store_tokens, logout, store_key_password, get_key_password, get_auth_status,
    get_session_tokens, restore_session_from_keyring, open_captcha_window, close_captcha_window,
};
```

- [ ] **Step 3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/auth.rs src-tauri/src/commands/mod.rs
git commit -m "refactor: extract auth commands to commands/auth.rs"
```

---

## Task 5: Extract `commands/db.rs`

**Files:**
- Fill: `src-tauri/src/commands/db.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write `commands/db.rs`**

```rust
use tauri::State;
use super::CommandError;
use crate::db::{Db, FileState};

#[tauri::command]
pub fn get_all_file_states(db: State<'_, Db>) -> Result<Vec<FileState>, CommandError> { ... }

#[tauri::command]
pub fn upsert_file_state(
    remote_id: String,
    local_path: String,
    etag: Option<String>,
    modified_at: Option<i64>,
    size_bytes: Option<i64>,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn set_file_sync_state(
    remote_id: String,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn get_file_state_by_remote_id(remote_id: String, db: State<'_, Db>) -> Result<Option<FileState>, CommandError> { ... }

#[tauri::command]
pub fn get_file_state_by_local_path(local_path: String, db: State<'_, Db>) -> Result<Option<FileState>, CommandError> { ... }

#[tauri::command]
pub fn get_db_sync_config(key: String, db: State<'_, Db>) -> Result<Option<String>, CommandError> { ... }

#[tauri::command]
pub fn set_db_sync_config(key: String, value: String, db: State<'_, Db>) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn delete_file_state(remote_id: String, db: State<'_, Db>) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn clear_all_file_states(db: State<'_, Db>) -> Result<(), CommandError> { ... }
```

Copy exact function bodies from `commands/mod.rs`.

- [ ] **Step 2: Update `commands/mod.rs`**

Remove the 9 db functions and add:
```rust
pub use db::{
    get_all_file_states, upsert_file_state, set_file_sync_state, get_file_state_by_remote_id,
    get_file_state_by_local_path, get_db_sync_config, set_db_sync_config,
    delete_file_state, clear_all_file_states,
};
```

- [ ] **Step 3: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/db.rs src-tauri/src/commands/mod.rs
git commit -m "refactor: extract DB state commands to commands/db.rs"
```

---

## Task 6: Extract `commands/file.rs`

This is the largest extraction: all file I/O commands plus their private helpers and unit tests.

**Files:**
- Fill: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write `commands/file.rs`**

File structure (all bodies copied verbatim from mod.rs):

```rust
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;
use super::{CommandError, guards::{canonical, within_sync_root, ensure_parent}};
use crate::db::Db;

// Private helpers (do_* functions, collect_recursive, do_trash)
fn do_list_local_dir(abs_path: &str) -> Result<Vec<String>, CommandError> { ... }
fn do_read_local_file(abs_path: &str) -> Result<String, CommandError> { ... }
fn do_write_local_file(abs_path: &str, content_b64: &str) -> Result<(), CommandError> { ... }
fn do_trash(abs_path: &str, sync_root: &str) -> Result<(), CommandError> { ... }
fn do_delete_local_file(abs_path: &str) -> Result<(), CommandError> { ... }
fn do_delete_local_dir(abs_path: &str) -> Result<(), CommandError> { ... }
fn do_stat_local_file(abs_path: &str) -> Result<super::FileStat, CommandError> { ... }
fn do_rename_local_file(from_path: &str, to_path: &str) -> Result<(), CommandError> { ... }
fn collect_recursive(
    base: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<super::LocalFileEntry>,
    cap: usize,
) -> Result<(), CommandError> { ... }

// Public Tauri commands
#[tauri::command]
pub fn ensure_local_dir(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn list_local_dir(abs_path: String, db: State<'_, Db>) -> Result<Vec<String>, CommandError> { ... }

// ... read_local_file, write_local_file, truncate_local_file, write_local_file_chunk,
//     trash_local_file, delete_local_file, delete_local_dir, stat_local_file,
//     rename_local_file, list_dir_recursive — all copied verbatim

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // Move these tests from mod.rs (lines 1145–1307 in original commands.rs):
    // - collect_recursive_skips_pd_tmp_files
    // - collect_recursive_skips_trash_subdirectory
    // - collect_recursive_builds_relative_paths
    // - collect_recursive_honors_cap
    // - collect_recursive_populates_abs_path_and_size
    // - list_local_dir_returns_only_files_not_dirs
    // - list_local_dir_empty_dir_returns_empty
    // - list_local_dir_errors_on_nonexistent_path
    // - list_local_dir_skips_pd_tmp_files
    // - write_and_read_local_file_round_trips
    // - write_local_file_creates_parent_dirs
    // - read_local_file_errors_on_missing_file
    // - write_local_file_rejects_invalid_base64
    // - delete_local_file_removes_existing_file
    // - delete_local_file_succeeds_silently_on_missing
    // - delete_local_dir_removes_directory_tree
    // - delete_local_dir_succeeds_silently_on_missing
    // - rename_local_file_moves_the_file
    // - rename_local_file_errors_on_missing_source
    // - trash_local_file_moves_file_to_trash_dir
    // - trash_local_file_succeeds_silently_when_source_missing
    // - stat_local_file_returns_correct_size
    // - stat_local_file_returns_positive_mtime
    // - stat_local_file_errors_on_missing
}
```

Note: `LocalFileEntry` is a type used in `list_dir_recursive`. It is currently a struct defined in `commands/mod.rs`. Keep it there or move to `file.rs` with `pub` visibility and re-export.

- [ ] **Step 2: Update `commands/mod.rs`**

Remove all file I/O functions and their tests. Add:
```rust
pub use file::{
    ensure_local_dir, list_local_dir, read_local_file, write_local_file,
    truncate_local_file, write_local_file_chunk, trash_local_file,
    delete_local_file, delete_local_dir, stat_local_file, rename_local_file,
    list_dir_recursive,
};
```

- [ ] **Step 3: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/file.rs src-tauri/src/commands/mod.rs
git commit -m "refactor: extract file I/O commands to commands/file.rs"
```

---

## Task 7: Extract `commands/config.rs`

**Files:**
- Fill: `src-tauri/src/commands/config.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write `commands/config.rs`**

```rust
use tauri::State;
use super::CommandError;
use crate::db::Db;

const SYSTEM_DIRS: &[&str] = &[
    "/usr", "/etc", "/var", "/bin", "/lib", "/sbin", "/boot", "/proc", "/sys", "/dev", "/run",
    "/tmp",
];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRootInfo {
    pub valid: bool,
    pub exists: bool,
    pub is_empty: bool,
    pub file_count: u32,
    pub error: Option<String>,
}

fn count_files_capped(dir: &std::path::Path, cap: u32) -> u32 { ... }

#[tauri::command]
pub fn validate_local_root(path: String) -> Result<LocalRootInfo, CommandError> { ... }

#[tauri::command]
pub fn set_local_root(path: String, db: State<'_, Db>) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn get_local_root(db: State<'_, Db>) -> Result<Option<String>, CommandError> { ... }

#[tauri::command]
pub fn get_home_dir() -> String { ... }

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // Move these tests from mod.rs:
    // - count_files_capped_empty_dir_returns_zero
    // - count_files_capped_counts_flat_files
    // - count_files_capped_caps_at_limit
    // - validate_local_root_rejects_relative_path
    // - validate_local_root_rejects_system_dir
    // - validate_local_root_rejects_home_directory_itself
    // - validate_local_root_rejects_path_outside_home
    // - validate_local_root_accepts_nonexistent_path_under_home
    // - validate_local_root_reports_file_count_for_existing_dir
}
```

- [ ] **Step 2: Update `commands/mod.rs`**

Remove config functions and `LocalRootInfo`. Add:
```rust
pub use config::{validate_local_root, set_local_root, get_local_root, get_home_dir, LocalRootInfo};
```

- [ ] **Step 3: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/config.rs src-tauri/src/commands/mod.rs
git commit -m "refactor: extract local root config commands to commands/config.rs"
```

---

## Task 8: Extract `commands/watcher.rs` and `commands/ui.rs`

**Files:**
- Fill: `src-tauri/src/commands/watcher.rs`
- Fill: `src-tauri/src/commands/ui.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write `commands/watcher.rs`**

```rust
use std::sync::{atomic::AtomicBool, Arc};
use tauri::State;
use super::{AppState, CommandError};
use crate::watcher;

#[tauri::command]
pub fn start_file_watcher(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> { ... }

#[tauri::command]
pub fn stop_file_watcher(state: State<'_, AppState>) { ... }
```

- [ ] **Step 2: Write `commands/ui.rs`**

Move `show_notification`, `get_autostart_enabled`, `enable_autostart`, `disable_autostart`, `update_tray_status`, `get_tray_status`, `show_main_window`, `emit_pause_toggle`, `suppress_appindicator_warning`, private `autostart_path`. Also move `RecentFile` and `TrayStatusPayload` type definitions here.

Key imports:
```rust
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem}, Emitter, Manager, State};
use super::{AppState, CommandError};
```

Translate the Norwegian strings in `update_tray_status` during this move:
```rust
let status_text = if payload.paused {
    "⏸  Sync paused".to_string()
} else if payload.syncing {
    format!("↕  Syncing {} item(s)…", payload.active_count)
} else if payload.error_count > 0 {
    format!("⚠  {} error(s)", payload.error_count)
} else {
    "✓  Synced".to_string()
};

let tooltip = if payload.paused {
    "Proton Drive Sync — paused".to_string()
} else if payload.syncing {
    format!("Proton Drive Sync — syncing {}", payload.active_count)
} else if payload.error_count > 0 {
    format!("Proton Drive Sync — {} errors", payload.error_count)
} else {
    "Proton Drive Sync — synced".to_string()
};
```

And for the menu labels:
```rust
let heading = MenuItem::with_id(&app, "recent-hd", "Recently synced:", false, None::<&str>)
let pause_label = if payload.paused { "▶  Resume sync" } else { "⏸  Pause sync" };
let show = MenuItem::with_id(&app, "show", "Open", true, None::<&str>)?;
let quit = MenuItem::with_id(&app, "quit", "Quit", true, None::<&str>)?;
```

- [ ] **Step 3: Update `commands/mod.rs`**

Remove watcher and UI functions, `RecentFile`, `TrayStatusPayload`. Add:
```rust
pub use watcher::{start_file_watcher, stop_file_watcher};
pub use ui::{
    show_notification, get_autostart_enabled, enable_autostart, disable_autostart,
    update_tray_status, get_tray_status, show_main_window, emit_pause_toggle,
    suppress_appindicator_warning, RecentFile, TrayStatusPayload,
};
```

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all 63 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/watcher.rs src-tauri/src/commands/ui.rs \
        src-tauri/src/commands/mod.rs
git commit -m "refactor: extract watcher and UI commands; translate Norwegian tray menu strings"
```

---

## Task 9: Verify `commands/mod.rs` is clean

After all extractions, `commands/mod.rs` should contain only:
- `use` imports
- `mod` declarations for all 7 submodules
- `pub use` re-exports
- `CommandError` enum + `Serialize` impl + `From<String>` + `From<&str>`
- `AppState` struct + `impl AppState { pub fn new() }`
- `AuthStatus`, `SessionTokens`, `FileStat` type definitions
- `LocalFileEntry` type (or re-exported from file.rs)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Verify mod.rs contains only shared types and re-exports**

The final `commands/mod.rs` should look like this skeleton:

```rust
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::image::Image;

use crate::auth::AuthSession;

mod auth;
mod config;
mod db;
mod file;
mod guards;
mod ui;
mod watcher;

pub use auth::{
    close_captcha_window, get_auth_status, get_key_password, get_session_tokens, logout,
    open_captcha_window, restore_session_from_keyring, store_key_password, store_tokens,
};
pub use config::{get_home_dir, get_local_root, set_local_root, validate_local_root, LocalRootInfo};
pub use db::{
    clear_all_file_states, delete_file_state, get_all_file_states, get_db_sync_config,
    get_file_state_by_local_path, get_file_state_by_remote_id, set_db_sync_config,
    set_file_sync_state, upsert_file_state,
};
pub use file::{
    delete_local_dir, delete_local_file, ensure_local_dir, list_dir_recursive, list_local_dir,
    read_local_file, rename_local_file, stat_local_file, trash_local_file, truncate_local_file,
    write_local_file, write_local_file_chunk,
};
pub use ui::{
    disable_autostart, emit_pause_toggle, enable_autostart, get_autostart_enabled, get_tray_status,
    show_main_window, show_notification, suppress_appindicator_warning, update_tray_status,
    RecentFile, TrayStatusPayload,
};
pub use watcher::{start_file_watcher, stop_file_watcher};

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<String> for CommandError {
    fn from(s: String) -> Self { Self::Other(s) }
}

impl From<&str> for CommandError {
    fn from(s: &str) -> Self { Self::Other(s.to_string()) }
}

pub struct AppState {
    pub session: Mutex<Option<AuthSession>>,
    pub watcher_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub last_tray_status: Mutex<Option<TrayStatusPayload>>,
    pub icon_idle: Image<'static>,
    pub icon_syncing: Image<'static>,
    pub icon_error: Image<'static>,
}

impl AppState {
    pub fn new() -> Self { ... }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    pub uid: String,
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: i64,
    pub size_bytes: i64,
    pub is_dir: bool,
}

// LocalFileEntry is used by file.rs::list_dir_recursive — keep here or move to file.rs + re-export
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub abs_path: String,
    pub rel_path: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
}
```

- [ ] **Step 2: Run full test suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture 2>&1 | tail -5
```
Expected: `test result: ok. 63 passed; 0 failed`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "refactor: clean up commands/mod.rs to contain only shared types and re-exports"
```
