use crate::db::Db;
use super::CommandError;

/// Resolves `path` to a canonical, symlink-free form.
/// If the path does not yet exist (e.g. a `.pd-tmp` file about to be created),
/// canonicalizes the parent directory and appends the filename component instead.
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
    use std::fs;
    use tempfile::TempDir;

    // ── canonical ────────────────────────────────────────────────────────────────

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
        assert!(
            result.unwrap_err().to_string().contains("canonicalize parent"),
            "expected 'canonicalize parent' in error"
        );
    }

    // ── within_sync_root ──────────────────────────────────────────────────────────

    fn make_db_with_root(root: &str) -> Db {
        let db = Db::open_in_memory().unwrap();
        db.set_sync_config("local_root", root).unwrap();
        db
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
        assert!(
            result.unwrap_err().to_string().contains("outside sync root"),
            "expected 'outside sync root' in error"
        );
    }

    #[test]
    fn within_sync_root_rejects_dotdot_traversal() {
        let dir = TempDir::new().unwrap();
        let db = make_db_with_root(dir.path().to_str().unwrap());
        let traversal = format!("{}/../../../etc/passwd", dir.path().display());
        let result = within_sync_root(&traversal, &db);
        assert!(result.is_err(), "dotdot traversal should be rejected");
    }

    #[test]
    fn within_sync_root_returns_error_when_root_not_configured() {
        let db = Db::open_in_memory().unwrap();
        let result = within_sync_root("/any/path/file.txt", &db);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("not configured"),
            "expected 'not configured' in error"
        );
    }

    #[test]
    fn within_sync_root_accepts_nonexistent_file_inside_root() {
        let dir = TempDir::new().unwrap();
        let db = make_db_with_root(dir.path().to_str().unwrap());
        // File does not exist yet — exercises the parent-fallback branch of canonical()
        let ghost = dir.path().join("new_file.pd-tmp");
        assert!(!ghost.exists());
        assert!(within_sync_root(ghost.to_str().unwrap(), &db).is_ok());
    }
}
