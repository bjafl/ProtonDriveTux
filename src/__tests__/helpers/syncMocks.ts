import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import type { FileState } from "../../lib/sync";

export type IpcHandler = (payload: Record<string, unknown>) => unknown;
export type IpcOverrides = Partial<Record<string, IpcHandler>>;

const DEFAULT_HANDLERS: Record<string, IpcHandler> = {
  get_local_root: () => "/home/test/ProtonDrive",
  get_db_sync_config: () => null,
  set_db_sync_config: () => null,
  get_all_file_states: () => [] as FileState[],
  get_file_state_by_remote_id: () => null,
  get_file_state_by_local_path: () => null,
  stat_local_file: () => null,
  upsert_file_state: () => null,
  delete_file_state: () => null,
  delete_local_file: () => null,
  delete_local_dir: () => null,
  rename_local_file: () => null,
  ensure_local_dir: () => null,
  show_notification: () => null,
  update_tray_status: () => null,
  list_local_dir: () => [] as string[],
  list_dir_recursive: () => [],
};

export function setupIpcMocks(overrides: IpcOverrides = {}): void {
  const handlers = { ...DEFAULT_HANDLERS, ...overrides };
  mockIPC((cmd, payload) => {
    const handler = handlers[cmd];
    if (handler) return handler((payload ?? {}) as Record<string, unknown>);
    throw new Error(`Unmocked IPC command called in test: "${cmd}"`);
  });
}

export function teardownIpcMocks(): void {
  clearMocks();
}

// Drive SDK vi.fn() stubs — assign to vi.mocked(importedFn) in test files
export const mockGetNode = vi.fn();
export const mockGetFileUploader = vi.fn();
export const mockGetFileRevisionUploader = vi.fn();
export const mockStreamDownloadToPath = vi.fn();
export const mockTrashNode = vi.fn();
export const mockFindOrCreateFolder = vi.fn();
export const mockListFolderChildren = vi.fn();
export const mockGetSyncRoot = vi.fn();
export const mockPersistEventAnchor = vi.fn();
export const mockSubscribeToTreeEvents = vi.fn();
