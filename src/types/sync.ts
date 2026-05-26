export interface FileState {
  remoteId: string;
  localPath: string;
  etag: string | null;
  modifiedAt: number | null;
  sizeBytes: number | null;
  syncState: string;
}

export interface FileStat {
  mtimeMs: number;
  sizeBytes: number;
  isDir: boolean;
}

export interface LocalFileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface LocalRootInfo {
  valid: boolean;
  exists: boolean;
  isEmpty: boolean;
  fileCount: number;
  error: string | null;
}

export interface TrayRecentFile {
  name: string;
  direction: "up" | "down";
}

export interface TrayStatusPayload {
  paused: boolean;
  syncing: boolean;
  activeCount: number;
  recentFiles: TrayRecentFile[];
  errorCount: number;
}
