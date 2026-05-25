use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;
use super::{CommandError, FileStat};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub rel_path: String,
    pub abs_path: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
}
use super::guards::{canonical, within_sync_root, ensure_parent};
use crate::db::Db;

/// Creates the directory at abs_path (including parents) if it doesn't already exist.
#[tauri::command]
pub fn ensure_local_dir(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    std::fs::create_dir_all(&abs_path)
        .map_err(|e| format!("create_dir_all {abs_path}: {e}"))
        .map_err(Into::into)
}

pub(super) fn do_list_local_dir(abs_path: &str) -> Result<Vec<String>, CommandError> {
    let entries = std::fs::read_dir(abs_path)
        .map_err(|e| format!("read_dir {abs_path}: {e}"))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && path.extension().map_or(true, |e| e != "pd-tmp")
        {
            files.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(files)
}

/// Lists regular files (non-directories) directly inside abs_path. Returns absolute paths.
#[tauri::command]
pub fn list_local_dir(abs_path: String, db: State<'_, Db>) -> Result<Vec<String>, CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_list_local_dir(&abs_path)
}

pub(super) fn do_read_local_file(abs_path: &str) -> Result<String, CommandError> {
    let bytes = std::fs::read(abs_path).map_err(|e| format!("read {abs_path}: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

pub(super) fn do_read_local_file_raw(abs_path: &str) -> Result<Vec<u8>, CommandError> {
    let bytes = std::fs::read(abs_path).map_err(|e| format!("read {abs_path}: {e}"))?;
    Ok(bytes)
}

/// Reads a local file and returns its contents as raw bytes
#[tauri::command]
pub fn read_local_file(abs_path: String, db: State<'_, Db>) -> Result<Vec<u8>, CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_read_local_file_raw(&abs_path)
}

pub(super) fn do_write_local_file(abs_path: &str, content_b64: &str) -> Result<(), CommandError> {
    let bytes = STANDARD
        .decode(content_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    ensure_parent(abs_path)?;
    std::fs::write(abs_path, &bytes)
        .map_err(|e| format!("write {abs_path}: {e}"))
        .map_err(Into::into)
}

/// Decodes a base64 string and writes it to a local file, creating parent dirs as needed.
#[tauri::command]
pub fn write_local_file(abs_path: String, content_b64: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_write_local_file(&abs_path, &content_b64)
}

/// Creates (or truncates) a local file, creating parent dirs as needed.
/// Used to initialize a file before streaming chunks via write_local_file_chunk.
#[tauri::command]
pub fn truncate_local_file(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    ensure_parent(&abs_path)?;
    std::fs::File::create(&abs_path).map_err(|e| format!("truncate {abs_path}: {e}"))?;
    Ok(())
}

/// Decodes a base64 chunk and appends it to an existing file.
/// Must be called after truncate_local_file to ensure the file exists.
#[tauri::command]
pub fn write_local_file_chunk(abs_path: String, content_b64: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    use std::io::Write;
    let bytes = STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&abs_path)
        .map_err(|e| format!("open append {abs_path}: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("write chunk {abs_path}: {e}"))
        .map_err(Into::into)
}

/// Inner logic for trashing a file; testable without Tauri State.
pub(super) fn do_trash(abs_path: &str, sync_root: &str) -> Result<(), CommandError> {
    let canon_root = std::fs::canonicalize(sync_root)
        .map_err(|e| CommandError::Other(format!("canonicalize sync root: {e}")))?;
    if !canonical(abs_path)?.starts_with(&canon_root) {
        return Err(CommandError::Other(format!("path outside sync root: {abs_path}")));
    }
    let src = std::path::Path::new(abs_path);
    if !src.exists() {
        return Ok(());
    }
    let trash_dir = std::path::Path::new(sync_root).join(".trash");
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
    let filename = src
        .file_name()
        .ok_or_else(|| format!("no filename in {abs_path}"))?;
    // Append a timestamp so repeated deletes of the same name don't collide.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dest = trash_dir.join(format!("{}.{ts}", filename.to_string_lossy()));
    match std::fs::rename(src, &dest) {
        Ok(()) => Ok(()),
        // Cross-device (e.g. NFS mount): fall back to copy + delete.
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => std::fs::copy(src, &dest)
            .and_then(|_| std::fs::remove_file(src))
            .map_err(|e2| format!("cross-device trash {abs_path}: {e2}").into()),
        Err(e) => Err(format!("rename {abs_path} → {}: {e}", dest.display()).into()),
    }
}

/// Moves a local file into `{sync_root}/.trash/` instead of permanently deleting it.
/// Creates the trash directory as needed. Silently succeeds if the source does not exist.
/// sync_root is read from the database — it is not a JS parameter.
#[tauri::command]
pub fn trash_local_file(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    let sync_root = db
        .get_sync_config("local_root")?
        .ok_or_else(|| CommandError::Other("sync root not configured".into()))?;
    do_trash(&abs_path, &sync_root)
}

pub(super) fn do_delete_local_file(abs_path: &str) -> Result<(), CommandError> {
    match std::fs::remove_file(abs_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove_file {abs_path}: {e}").into()),
    }
}

/// Deletes a local file. Silently succeeds if the file does not exist.
#[tauri::command]
pub fn delete_local_file(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_delete_local_file(&abs_path)
}

pub(super) fn do_delete_local_dir(abs_path: &str) -> Result<(), CommandError> {
    match std::fs::remove_dir_all(abs_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove_dir_all {abs_path}: {e}").into()),
    }
}

/// Recursively deletes a local directory. Silently succeeds if the path does not exist.
#[tauri::command]
pub fn delete_local_dir(abs_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_delete_local_dir(&abs_path)
}

pub(super) fn do_stat_local_file(abs_path: &str) -> Result<FileStat, CommandError> {
    let meta = std::fs::metadata(abs_path)
        .map_err(|e| format!("stat {abs_path}: {e}"))?;
    let mtime_ms = meta
        .modified()
        .map_err(|e| format!("mtime {abs_path}: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Ok(FileStat {
        mtime_ms,
        size_bytes: meta.len() as i64,
        is_dir: meta.is_dir(),
    })
}

/// Returns the modification time (in ms since Unix epoch) and size of a local file.
#[tauri::command]
pub fn stat_local_file(abs_path: String, db: State<'_, Db>) -> Result<FileStat, CommandError> {
    within_sync_root(&abs_path, &db)?;
    do_stat_local_file(&abs_path)
}

pub(super) fn do_rename_local_file(from_path: &str, to_path: &str) -> Result<(), CommandError> {
    std::fs::rename(from_path, to_path)
        .map_err(|e| format!("rename {from_path} → {to_path}: {e}"))
        .map_err(Into::into)
}

/// Renames (moves) a local file. Fails if the source does not exist.
#[tauri::command]
pub fn rename_local_file(from_path: String, to_path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    within_sync_root(&from_path, &db)?;
    within_sync_root(&to_path, &db)?;
    do_rename_local_file(&from_path, &to_path)
}

#[tauri::command]
pub fn list_dir_recursive(abs_path: String, db: State<'_, Db>) -> Result<Vec<LocalFileEntry>, CommandError> {
    within_sync_root(&abs_path, &db)?;
    let root = std::path::Path::new(&abs_path);
    let mut results = Vec::new();
    collect_recursive(root, root, &mut results, 10_000)?;
    Ok(results)
}

pub(super) fn collect_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<LocalFileEntry>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        if out.len() >= cap {
            break;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if path.file_name().map_or(false, |n| n == ".trash") {
                continue;
            }
            collect_recursive(root, &path, out, cap)?;
        } else if ft.is_file() {
            // Skip partial-download temp files left by an interrupted sync.
            if path.extension().map_or(false, |e| e == "pd-tmp") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            let rel_path = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(LocalFileEntry {
                rel_path,
                abs_path: path.to_string_lossy().into_owned(),
                mtime_ms,
                size_bytes: meta.len() as i64,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── collect_recursive ─────────────────────────────────────────────────────

    #[test]
    fn collect_recursive_skips_pd_tmp_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("real.txt"), "data").unwrap();
        fs::write(dir.path().join("real.txt.pd-tmp"), "partial").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.bin.pd-tmp"), "partial").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "real.txt");
    }

    #[test]
    fn collect_recursive_skips_trash_subdirectory() {
        let dir = TempDir::new().unwrap();
        let trash = dir.path().join(".trash");
        fs::create_dir(&trash).unwrap();
        fs::write(trash.join("deleted.txt"), "gone").unwrap();
        fs::write(dir.path().join("kept.txt"), "keep").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "kept.txt");
    }

    #[test]
    fn collect_recursive_builds_relative_paths() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("docs");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("report.pdf"), "pdf").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "docs/report.pdf");
    }

    #[test]
    fn collect_recursive_honors_cap() {
        let dir = TempDir::new().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("{i}.txt")), "x").unwrap();
        }
        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 5).unwrap();
        assert!(out.len() <= 5);
    }

    #[test]
    fn collect_recursive_populates_abs_path_and_size() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("file.txt"), "hello").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 5);
        assert!(out[0].abs_path.ends_with("file.txt"));
        assert!(out[0].mtime_ms > 0);
    }

    // ── list_local_dir ────────────────────────────────────────────────────────

    #[test]
    fn list_local_dir_returns_only_files_not_dirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("file.txt"), "data").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let result = do_list_local_dir(&dir.path().to_string_lossy()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].ends_with("file.txt"));
    }

    #[test]
    fn list_local_dir_empty_dir_returns_empty() {
        let dir = TempDir::new().unwrap();
        let result = do_list_local_dir(&dir.path().to_string_lossy()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_local_dir_errors_on_nonexistent_path() {
        assert!(do_list_local_dir("/nonexistent/path/zzzz").is_err());
    }

    #[test]
    fn list_local_dir_skips_pd_tmp_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("file.txt"), "data").unwrap();
        fs::write(dir.path().join("file.txt.pd-tmp"), "partial").unwrap();

        let result = do_list_local_dir(&dir.path().to_string_lossy()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].ends_with("file.txt"));
    }

    // ── read_local_file / write_local_file ────────────────────────────────────

    #[test]
    fn write_and_read_local_file_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.bin").to_string_lossy().into_owned();
        let original = b"hello world \x00\xff";
        let encoded = base64::engine::general_purpose::STANDARD.encode(original);

        do_write_local_file(&path, &encoded).unwrap();
        let result_b64 = do_read_local_file(&path).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(result_b64)
            .unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn write_local_file_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir
            .path()
            .join("a/b/c/file.txt")
            .to_string_lossy()
            .into_owned();
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"data");
        do_write_local_file(&path, &encoded).unwrap();
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn read_local_file_errors_on_missing_file() {
        assert!(do_read_local_file("/nonexistent/file.txt").is_err());
    }

    #[test]
    fn write_local_file_rejects_invalid_base64() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        assert!(do_write_local_file(&path, "not!valid!base64!!!").is_err());
    }

    // ── delete_local_file ─────────────────────────────────────────────────────

    #[test]
    fn delete_local_file_removes_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("del.txt");
        fs::write(&path, "bye").unwrap();
        do_delete_local_file(&path.to_string_lossy()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_local_file_succeeds_silently_on_missing() {
        assert!(do_delete_local_file("/tmp/proton_test_missing_zzzz.txt").is_ok());
    }

    // ── delete_local_dir ─────────────────────────────────────────────────────

    #[test]
    fn delete_local_dir_removes_directory_tree() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("subtree");
        fs::create_dir(&target).unwrap();
        fs::create_dir(target.join("child")).unwrap();
        fs::write(target.join("child").join("file.txt"), "data").unwrap();
        do_delete_local_dir(&target.to_string_lossy()).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn delete_local_dir_succeeds_silently_on_missing() {
        assert!(do_delete_local_dir("/tmp/proton_test_missing_dir_zzzz").is_ok());
    }

    // ── rename_local_file ─────────────────────────────────────────────────────

    #[test]
    fn rename_local_file_moves_the_file() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("old.txt");
        let dst = dir.path().join("new.txt");
        fs::write(&src, "content").unwrap();
        do_rename_local_file(&src.to_string_lossy(), &dst.to_string_lossy()).unwrap();
        assert!(!src.exists());
        assert!(dst.exists());
    }

    #[test]
    fn rename_local_file_errors_on_missing_source() {
        let dir = TempDir::new().unwrap();
        assert!(do_rename_local_file(
            "/nonexistent/src.txt",
            &dir.path().join("dst.txt").to_string_lossy(),
        )
        .is_err());
    }

    // ── trash_local_file ─────────────────────────────────────────────────────

    #[test]
    fn trash_local_file_moves_file_to_trash_dir() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("important.txt");
        fs::write(&file_path, "data").unwrap();

        do_trash(
            &file_path.to_string_lossy(),
            &dir.path().to_string_lossy(),
        )
        .unwrap();

        assert!(!file_path.exists());
        let trash = dir.path().join(".trash");
        let entries: Vec<_> = fs::read_dir(&trash).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].file_name().to_string_lossy().contains("important.txt"));
    }

    #[test]
    fn trash_local_file_succeeds_silently_when_source_missing() {
        let dir = TempDir::new().unwrap();
        // Non-existent path, but within the root so the guard passes.
        let ghost = dir.path().join("ghost.txt");
        assert!(do_trash(&ghost.to_string_lossy(), &dir.path().to_string_lossy()).is_ok());
    }

    // ── stat_local_file ───────────────────────────────────────────────────────

    #[test]
    fn stat_local_file_returns_correct_size() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sized.txt");
        fs::write(&path, "12345").unwrap(); // 5 bytes
        let stat = do_stat_local_file(&path.to_string_lossy()).unwrap();
        assert_eq!(stat.size_bytes, 5);
    }

    #[test]
    fn stat_local_file_returns_positive_mtime() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("timed.txt");
        fs::write(&path, "x").unwrap();
        let stat = do_stat_local_file(&path.to_string_lossy()).unwrap();
        assert!(stat.mtime_ms > 0);
    }

    #[test]
    fn stat_local_file_errors_on_missing() {
        assert!(do_stat_local_file("/nonexistent/missing.txt").is_err());
    }
}
