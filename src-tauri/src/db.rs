use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub remote_id: String,
    pub local_path: String,
    pub etag: Option<String>,
    pub modified_at: Option<i64>,
    pub size_bytes: Option<i64>,
    pub sync_state: String,
}

pub struct Db {
    conn: Mutex<Connection>,
}

// rusqlite::Connection is Send; Mutex makes it Sync.
unsafe impl Send for Db {}
unsafe impl Sync for Db {}

impl Db {
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ffi::ErrorCode::SystemIoFailure,
                    extended_code: 0,
                },
                Some(format!("create_dir_all: {e}")),
            ))?;

        let db_path = data_dir.join("sync_state.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch("PRAGMA journal_mode = WAL;")?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS files (
                remote_id   TEXT PRIMARY KEY,
                local_path  TEXT NOT NULL UNIQUE,
                etag        TEXT,
                modified_at INTEGER,
                size_bytes  INTEGER,
                sync_state  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_files_sync_state ON files (sync_state);
            CREATE TABLE IF NOT EXISTS sync_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert_file(&self, state: &FileState) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO files (remote_id, local_path, etag, modified_at, size_bytes, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(remote_id) DO UPDATE SET
               local_path  = excluded.local_path,
               etag        = excluded.etag,
               modified_at = excluded.modified_at,
               size_bytes  = excluded.size_bytes,
               sync_state  = excluded.sync_state",
            params![
                state.remote_id,
                state.local_path,
                state.etag,
                state.modified_at,
                state.size_bytes,
                state.sync_state,
            ],
        )?;
        Ok(())
    }

    pub fn set_sync_state(&self, remote_id: &str, sync_state: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE files SET sync_state = ?1 WHERE remote_id = ?2",
            params![sync_state, remote_id],
        )?;
        Ok(())
    }

    pub fn get_by_remote_id(&self, remote_id: &str) -> Result<Option<FileState>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT remote_id, local_path, etag, modified_at, size_bytes, sync_state
             FROM files WHERE remote_id = ?1",
            params![remote_id],
            |row| {
                Ok(FileState {
                    remote_id: row.get(0)?,
                    local_path: row.get(1)?,
                    etag: row.get(2)?,
                    modified_at: row.get(3)?,
                    size_bytes: row.get(4)?,
                    sync_state: row.get(5)?,
                })
            },
        )
        .optional()
    }

    pub fn get_by_local_path(&self, local_path: &str) -> Result<Option<FileState>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT remote_id, local_path, etag, modified_at, size_bytes, sync_state
             FROM files WHERE local_path = ?1",
            params![local_path],
            |row| {
                Ok(FileState {
                    remote_id: row.get(0)?,
                    local_path: row.get(1)?,
                    etag: row.get(2)?,
                    modified_at: row.get(3)?,
                    size_bytes: row.get(4)?,
                    sync_state: row.get(5)?,
                })
            },
        )
        .optional()
    }

    pub fn delete_by_remote_id(&self, remote_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM files WHERE remote_id = ?1",
            params![remote_id],
        )?;
        Ok(())
    }

    pub fn all_files(&self) -> Result<Vec<FileState>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT remote_id, local_path, etag, modified_at, size_bytes, sync_state
             FROM files ORDER BY local_path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(FileState {
                remote_id: row.get(0)?,
                local_path: row.get(1)?,
                etag: row.get(2)?,
                modified_at: row.get(3)?,
                size_bytes: row.get(4)?,
                sync_state: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_sync_config(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM sync_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn set_sync_config(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_config (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE files (
                remote_id   TEXT PRIMARY KEY,
                local_path  TEXT NOT NULL UNIQUE,
                etag        TEXT,
                modified_at INTEGER,
                size_bytes  INTEGER,
                sync_state  TEXT NOT NULL
            );
            CREATE TABLE sync_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        Db { conn: Mutex::new(conn) }
    }

    fn file(remote_id: &str, local_path: &str) -> FileState {
        FileState {
            remote_id: remote_id.to_string(),
            local_path: local_path.to_string(),
            etag: None,
            modified_at: None,
            size_bytes: None,
            sync_state: "synced".to_string(),
        }
    }

    // ── upsert_file / get_by_remote_id ────────────────────────────────────────

    #[test]
    fn upsert_inserts_new_file() {
        let db = make_db();
        db.upsert_file(&file("r1", "/local/a.txt")).unwrap();
        let result = db.get_by_remote_id("r1").unwrap();
        assert!(result.is_some());
        let f = result.unwrap();
        assert_eq!(f.remote_id, "r1");
        assert_eq!(f.local_path, "/local/a.txt");
        assert_eq!(f.sync_state, "synced");
    }

    #[test]
    fn upsert_overwrites_existing_file() {
        let db = make_db();
        db.upsert_file(&file("r1", "/local/a.txt")).unwrap();
        let updated = FileState {
            remote_id: "r1".to_string(),
            local_path: "/local/a.txt".to_string(),
            etag: Some("abc123".to_string()),
            modified_at: Some(1_700_000_000),
            size_bytes: Some(4096),
            sync_state: "pending_upload".to_string(),
        };
        db.upsert_file(&updated).unwrap();
        let result = db.get_by_remote_id("r1").unwrap().unwrap();
        assert_eq!(result.etag, Some("abc123".to_string()));
        assert_eq!(result.size_bytes, Some(4096));
        assert_eq!(result.sync_state, "pending_upload");
    }

    #[test]
    fn get_by_remote_id_returns_none_for_missing() {
        let db = make_db();
        assert!(db.get_by_remote_id("missing").unwrap().is_none());
    }

    // ── get_by_local_path ─────────────────────────────────────────────────────

    #[test]
    fn get_by_local_path_finds_inserted_file() {
        let db = make_db();
        db.upsert_file(&file("r1", "/sync/doc.pdf")).unwrap();
        let result = db.get_by_local_path("/sync/doc.pdf").unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().remote_id, "r1");
    }

    #[test]
    fn get_by_local_path_returns_none_for_missing() {
        let db = make_db();
        assert!(db.get_by_local_path("/nonexistent").unwrap().is_none());
    }

    // ── set_sync_state ────────────────────────────────────────────────────────

    #[test]
    fn set_sync_state_updates_existing_row() {
        let db = make_db();
        db.upsert_file(&file("r1", "/local/a.txt")).unwrap();
        db.set_sync_state("r1", "conflict").unwrap();
        let result = db.get_by_remote_id("r1").unwrap().unwrap();
        assert_eq!(result.sync_state, "conflict");
    }

    #[test]
    fn set_sync_state_no_op_for_missing_id() {
        let db = make_db();
        // Should succeed without error even if row doesn't exist
        assert!(db.set_sync_state("ghost", "error").is_ok());
    }

    // ── delete_by_remote_id ───────────────────────────────────────────────────

    #[test]
    fn delete_by_remote_id_removes_the_row() {
        let db = make_db();
        db.upsert_file(&file("r1", "/local/a.txt")).unwrap();
        db.delete_by_remote_id("r1").unwrap();
        assert!(db.get_by_remote_id("r1").unwrap().is_none());
    }

    #[test]
    fn delete_by_remote_id_no_op_for_missing() {
        let db = make_db();
        assert!(db.delete_by_remote_id("ghost").is_ok());
    }

    // ── all_files ─────────────────────────────────────────────────────────────

    #[test]
    fn all_files_returns_empty_on_fresh_db() {
        let db = make_db();
        assert!(db.all_files().unwrap().is_empty());
    }

    #[test]
    fn all_files_returns_all_rows_sorted_by_local_path() {
        let db = make_db();
        db.upsert_file(&file("r2", "/sync/z.txt")).unwrap();
        db.upsert_file(&file("r1", "/sync/a.txt")).unwrap();
        let files = db.all_files().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].local_path, "/sync/a.txt");
        assert_eq!(files[1].local_path, "/sync/z.txt");
    }

    // ── sync_config ───────────────────────────────────────────────────────────

    #[test]
    fn get_sync_config_returns_none_when_not_set() {
        let db = make_db();
        assert!(db.get_sync_config("local_root").unwrap().is_none());
    }

    #[test]
    fn set_and_get_sync_config_round_trips() {
        let db = make_db();
        db.set_sync_config("local_root", "/home/user/ProtonDrive").unwrap();
        let val = db.get_sync_config("local_root").unwrap();
        assert_eq!(val, Some("/home/user/ProtonDrive".to_string()));
    }

    #[test]
    fn set_sync_config_overwrites_existing_value() {
        let db = make_db();
        db.set_sync_config("key", "first").unwrap();
        db.set_sync_config("key", "second").unwrap();
        let val = db.get_sync_config("key").unwrap();
        assert_eq!(val, Some("second".to_string()));
    }

    #[test]
    fn set_sync_config_stores_independent_keys() {
        let db = make_db();
        db.set_sync_config("local_root", "/home/user/ProtonDrive").unwrap();
        db.set_sync_config("volume_id", "vol-abc123").unwrap();
        assert_eq!(
            db.get_sync_config("local_root").unwrap(),
            Some("/home/user/ProtonDrive".to_string())
        );
        assert_eq!(
            db.get_sync_config("volume_id").unwrap(),
            Some("vol-abc123".to_string())
        );
    }
}
