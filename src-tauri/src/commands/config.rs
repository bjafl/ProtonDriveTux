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

#[tauri::command]
pub fn validate_local_root(path: String) -> Result<LocalRootInfo, CommandError> {
    let p = std::path::Path::new(&path);

    if !p.is_absolute() {
        return Ok(LocalRootInfo {
            valid: false,
            exists: false,
            is_empty: true,
            file_count: 0,
            error: Some("Path must be absolute".into()),
        });
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let home_path = std::path::Path::new(&home);

    if path == home {
        return Ok(LocalRootInfo {
            valid: false,
            exists: p.exists(),
            is_empty: false,
            file_count: 0,
            error: Some("Cannot sync directly into your home directory".into()),
        });
    }

    if !p.starts_with(home_path) {
        return Ok(LocalRootInfo {
            valid: false,
            exists: p.exists(),
            is_empty: false,
            file_count: 0,
            error: Some("Path must be inside your home directory".into()),
        });
    }

    for sys in SYSTEM_DIRS {
        if p.starts_with(sys) {
            return Ok(LocalRootInfo {
                valid: false,
                exists: p.exists(),
                is_empty: false,
                file_count: 0,
                error: Some(format!("Cannot use system directory {sys}")),
            });
        }
    }

    let exists = p.exists();
    if !exists {
        return Ok(LocalRootInfo {
            valid: true,
            exists: false,
            is_empty: true,
            file_count: 0,
            error: None,
        });
    }

    let file_count = count_files_capped(p, 10_000);
    Ok(LocalRootInfo {
        valid: true,
        exists: true,
        is_empty: file_count == 0,
        file_count,
        error: None,
    })
}

fn count_files_capped(dir: &std::path::Path, cap: u32) -> u32 {
    let mut count = 0u32;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        if count >= cap {
            return count;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_file() {
            count += 1;
        } else if ft.is_dir() {
            count += count_files_capped(&entry.path(), cap - count);
        }
    }
    count
}

#[tauri::command]
pub fn set_local_root(path: String, db: State<'_, Db>) -> Result<(), CommandError> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Cannot create directory: {e}"))?;
    }
    Ok(db.set_sync_config("local_root", &path)?)
}

#[tauri::command]
pub fn get_local_root(db: State<'_, Db>) -> Result<Option<String>, CommandError> {
    Ok(db.get_sync_config("local_root")?)
}

#[tauri::command]
pub fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "~".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── count_files_capped ────────────────────────────────────────────────────

    #[test]
    fn count_files_capped_empty_dir_returns_zero() {
        let dir = TempDir::new().unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 0);
    }

    #[test]
    fn count_files_capped_counts_flat_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::write(dir.path().join("c.txt"), "c").unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 3);
    }

    #[test]
    fn count_files_capped_counts_files_in_subdirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("root.txt"), "r").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("child.txt"), "c").unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 2);
    }

    #[test]
    fn count_files_capped_stops_at_cap() {
        let dir = TempDir::new().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("{i}.txt")), "x").unwrap();
        }
        assert_eq!(count_files_capped(dir.path(), 3), 3);
    }

    // ── validate_local_root ───────────────────────────────────────────────────

    #[test]
    fn validate_local_root_rejects_relative_path() {
        let result = validate_local_root("relative/path".to_string()).unwrap();
        assert!(!result.valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn validate_local_root_rejects_system_dir() {
        let result = validate_local_root("/etc/proton-test-folder".to_string()).unwrap();
        assert!(!result.valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn validate_local_root_rejects_home_directory_itself() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let result = validate_local_root(home).unwrap();
        assert!(!result.valid);
    }

    #[test]
    fn validate_local_root_rejects_path_outside_home() {
        // /tmp is not under HOME on Linux (HOME is /home/…)
        let result = validate_local_root("/tmp/some-folder".to_string()).unwrap();
        // Either rejected as system dir or as outside HOME — either way, invalid
        assert!(!result.valid);
    }

    #[test]
    fn validate_local_root_accepts_nonexistent_path_under_home() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let path = format!("{home}/nonexistent-proton-drive-test-zzzz9999");
        let result = validate_local_root(path).unwrap();
        assert!(result.valid, "expected valid, got error: {:?}", result.error);
        assert!(!result.exists);
        assert_eq!(result.file_count, 0);
        assert!(result.error.is_none());
    }

    #[test]
    fn validate_local_root_reports_file_count_for_existing_dir() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let dir = TempDir::new_in(&home).unwrap();
        fs::write(dir.path().join("one.txt"), "1").unwrap();
        fs::write(dir.path().join("two.txt"), "2").unwrap();

        let result = validate_local_root(dir.path().to_string_lossy().into_owned()).unwrap();
        assert!(result.valid);
        assert!(result.exists);
        assert!(!result.is_empty);
        assert_eq!(result.file_count, 2);
    }
}
