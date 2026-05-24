import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileState } from "../lib/sync";

interface FileStatesHookResult {
  fileStates: FileState[];
  refreshFileStates: () => Promise<void>;
}

export function useFileStates(): FileStatesHookResult {
  const [fileStates, setFileStates] = useState<FileState[]>([]);

  const refreshFileStates = useCallback(async () => {
    try {
      const files = await invoke<FileState[]>("get_all_file_states");
      setFileStates(files);
    } catch { /* ignore */ }
  }, []);

  return { fileStates, refreshFileStates };
}
