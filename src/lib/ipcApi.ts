import { invoke } from "@tauri-apps/api/core";
import type { AuthStatus, SessionTokens } from "../types/auth";
import type {
  FileState,
  FileStat,
  LocalFileEntry,
  LocalRootInfo,
  TrayStatusPayload,
} from "../types/sync";

export type { LocalRootInfo, TrayStatusPayload };

// ── Auth ──────────────────────────────────────────────────────────────────────

export const storeTokens = (
  uid: string,
  accessToken: string,
  refreshToken: string,
  userId: string,
) => invoke<void>("store_tokens", { uid, accessToken, refreshToken, userId });

export const logout = () => invoke<void>("logout");

export const storeKeyPassword = (keyPassword: string) =>
  invoke<void>("store_key_password", { keyPassword });

export const getKeyPassword = () => invoke<string | null>("get_key_password");

export const getAuthStatus = () => invoke<AuthStatus>("get_auth_status");

export const getSessionTokens = () => invoke<SessionTokens | null>("get_session_tokens");

export const openCaptchaWindow = (token: string, methods: string[], theme?: string) =>
  invoke<void>("open_captcha_window", { token, methods, theme });

export const closeCaptchaWindow = () => invoke<void>("close_captcha_window");

// ── Config ────────────────────────────────────────────────────────────────────

export const validateLocalRoot = (path: string) =>
  invoke<LocalRootInfo>("validate_local_root", { path });

export const setLocalRoot = (path: string) => invoke<void>("set_local_root", { path });

export const getLocalRoot = () => invoke<string | null>("get_local_root");

export const getHomeDir = () => invoke<string>("get_home_dir");

export const getDbSyncConfig = (key: string) =>
  invoke<string | null>("get_db_sync_config", { key });

export const setDbSyncConfig = (key: string, value: string) =>
  invoke<void>("set_db_sync_config", { key, value });

// ── File state (DB) ───────────────────────────────────────────────────────────

export const getAllFileStates = () => invoke<FileState[]>("get_all_file_states");

export const upsertFileState = (params: {
  remoteId: string;
  localPath: string;
  etag: string | null;
  modifiedAt: number | null;
  sizeBytes: number | null;
  syncState: string;
}) => invoke<void>("upsert_file_state", params as Record<string, unknown>);

export const setFileSyncState = (remoteId: string, syncState: string) =>
  invoke<void>("set_file_sync_state", { remoteId, syncState });

export const getFileStateByRemoteId = (remoteId: string) =>
  invoke<FileState | null>("get_file_state_by_remote_id", { remoteId });

export const getFileStateByLocalPath = (localPath: string) =>
  invoke<FileState | null>("get_file_state_by_local_path", { localPath });

export const deleteFileState = (remoteId: string) =>
  invoke<void>("delete_file_state", { remoteId });

export const clearAllFileStates = () => invoke<void>("clear_all_file_states");

// ── Local files ───────────────────────────────────────────────────────────────

export const ensureLocalDir = (absPath: string) =>
  invoke<void>("ensure_local_dir", { absPath });

export const listLocalDir = (absPath: string) =>
  invoke<string[]>("list_local_dir", { absPath });

export const readLocalFile = (absPath: string) =>
  invoke<Uint8Array<ArrayBuffer>>("read_local_file", { absPath });

export const writeLocalFile = (absPath: string, contentB64: string) =>
  invoke<void>("write_local_file", { absPath, contentB64 });

export const truncateLocalFile = (absPath: string) =>
  invoke<void>("truncate_local_file", { absPath });

export const writeLocalFileChunk = (absPath: string, contentB64: string) =>
  invoke<void>("write_local_file_chunk", { absPath, contentB64 });

export const trashLocalFile = (absPath: string) =>
  invoke<void>("trash_local_file", { absPath });

export const deleteLocalFile = (absPath: string) =>
  invoke<void>("delete_local_file", { absPath });

export const deleteLocalDir = (absPath: string) =>
  invoke<void>("delete_local_dir", { absPath });

export const statLocalFile = (absPath: string) =>
  invoke<FileStat>("stat_local_file", { absPath });

export const renameLocalFile = (fromPath: string, toPath: string) =>
  invoke<void>("rename_local_file", { fromPath, toPath });

export const listDirRecursive = (absPath: string) =>
  invoke<LocalFileEntry[]>("list_dir_recursive", { absPath });

// ── UI / tray ─────────────────────────────────────────────────────────────────

export const showNotification = (title: string, body: string) =>
  invoke<void>("show_notification", { title, body });

export const getAutostartEnabled = () => invoke<boolean>("get_autostart_enabled");

export const enableAutostart = () => invoke<void>("enable_autostart");

export const disableAutostart = () => invoke<void>("disable_autostart");

export const updateTrayStatus = (payload: TrayStatusPayload) =>
  invoke<void>("update_tray_status", { ...payload } as Record<string, unknown>);

export const getTrayStatus = () =>
  invoke<TrayStatusPayload | null>("get_tray_status");

export const showMainWindow = () => invoke<void>("show_main_window");

export const emitPauseToggle = () => invoke<void>("emit_pause_toggle");

// ── Watcher ───────────────────────────────────────────────────────────────────

export const startFileWatcher = (path: string) =>
  invoke<void>("start_file_watcher", { path });

export const stopFileWatcher = () => invoke<void>("stop_file_watcher");
