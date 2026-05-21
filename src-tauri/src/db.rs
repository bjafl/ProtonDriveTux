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
