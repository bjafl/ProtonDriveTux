/**
 * Client-side path helpers.
 * HOME is retrieved at runtime from Rust so we never hardcode it.
 */
import { invoke } from "@tauri-apps/api/core";

let _homeDir: string | null = null;

export async function getHomeDir(): Promise<string> {
  if (_homeDir === null) {
    _homeDir = await invoke<string>("get_home_dir");
  }
  return _homeDir;
}

export async function defaultSyncPath(): Promise<string> {
  return `${await getHomeDir()}/ProtonDrive`;
}
