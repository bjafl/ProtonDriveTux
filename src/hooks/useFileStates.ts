import { useCallback, useState } from "react";
import { getAllFileStates } from "../lib/ipcApi";
import type { FileState } from "../lib/sync";

interface FileStatesHookResult {
  fileStates: FileState[];
  refreshFileStates: () => Promise<void>;
}

export function useFileStates(): FileStatesHookResult {
  const [fileStates, setFileStates] = useState<FileState[]>([]);

  const refreshFileStates = useCallback(async () => {
    try {
      const files = await getAllFileStates();
      setFileStates(files);
    } catch { /* ignore */ }
  }, []);

  return { fileStates, refreshFileStates };
}
