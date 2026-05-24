use tauri::State;
use super::CommandError;
use crate::db::{Db, FileState};

#[tauri::command]
pub fn get_all_file_states(db: State<'_, Db>) -> Result<Vec<FileState>, CommandError> {
    Ok(db.all_files()?)
}

#[tauri::command]
pub fn upsert_file_state(
    remote_id: String,
    local_path: String,
    etag: Option<String>,
    modified_at: Option<i64>,
    size_bytes: Option<i64>,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), CommandError> {
    let state = FileState {
        remote_id,
        local_path,
        etag,
        modified_at,
        size_bytes,
        sync_state,
    };
    Ok(db.upsert_file(&state)?)
}

#[tauri::command]
pub fn set_file_sync_state(
    remote_id: String,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), CommandError> {
    Ok(db.set_sync_state(&remote_id, &sync_state)?)
}

#[tauri::command]
pub fn get_file_state_by_remote_id(
    remote_id: String,
    db: State<'_, Db>,
) -> Result<Option<FileState>, CommandError> {
    Ok(db.get_by_remote_id(&remote_id)?)
}

#[tauri::command]
pub fn get_file_state_by_local_path(
    local_path: String,
    db: State<'_, Db>,
) -> Result<Option<FileState>, CommandError> {
    Ok(db.get_by_local_path(&local_path)?)
}

#[tauri::command]
pub fn get_db_sync_config(key: String, db: State<'_, Db>) -> Result<Option<String>, CommandError> {
    Ok(db.get_sync_config(&key)?)
}

#[tauri::command]
pub fn set_db_sync_config(
    key: String,
    value: String,
    db: State<'_, Db>,
) -> Result<(), CommandError> {
    Ok(db.set_sync_config(&key, &value)?)
}

#[tauri::command]
pub fn delete_file_state(remote_id: String, db: State<'_, Db>) -> Result<(), CommandError> {
    Ok(db.delete_by_remote_id(&remote_id)?)
}

/// Removes all file-state rows. Called when the user changes the sync root so the
/// new sync session starts with a clean slate instead of treating old paths as conflicts.
#[tauri::command]
pub fn clear_all_file_states(db: State<'_, Db>) -> Result<(), CommandError> {
    Ok(db.clear_all()?)
}
