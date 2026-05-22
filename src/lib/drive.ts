/**
 * All Proton Drive SDK interaction goes through this module.
 * Isolates the SDK behind a stable API so breaking SDK changes only touch here.
 */
import {
  MemoryCache,
  NullFeatureFlagProvider,
  ProtonDriveClient,
  NodeType,
  type DriveListener,
  type EventSubscription,
  type FileDownloader,
  type FileUploader,
  type LatestEventIdProvider,
  type MaybeNode,
  type NodeOrUid,
  type UploadMetadata,
} from "@protontech/drive-sdk";
import { invoke } from "@tauri-apps/api/core";

import { fetch } from "./tauriFetch";
import { createAccountProvider } from "./accountProvider";
import { createHttpClient } from "./httpClient";
import { initCrypto, createOpenPGPCryptoModule } from "./cryptoModule";
import { createSrpModule, computeKeyPassword } from "./srpModule";

const BASE_URL = import.meta.env.VITE_PROTON_API_BASE ?? "https://mail.proton.me/api";
const APP_VERSION =
  import.meta.env.VITE_PROTON_APP_VERSION ?? "external-drive-protondrive@0.1.0-alpha";

export interface DriveSession {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  keyPassword: string;
}

let driveClient: ProtonDriveClient | null = null;
let currentSession: DriveSession | null = null;
let _onSessionExpired: (() => void) | null = null;

/** Called by the UI to register a handler for when the refresh token is rejected. */
export function setSessionExpiredCallback(cb: (() => void) | null): void {
  _onSessionExpired = cb;
}

// Reads/writes event anchors from the Tauri DB so subscriptions resume after restart.
const latestEventIdProvider: LatestEventIdProvider = {
  async getLatestEventId(treeEventScopeId: string): Promise<string | null> {
    return invoke<string | null>("get_db_sync_config", {
      key: `event_anchor_${treeEventScopeId}`,
    });
  },
};

export async function persistEventAnchor(treeEventScopeId: string, eventId: string): Promise<void> {
  if (!eventId || eventId === "none") return;
  await invoke("set_db_sync_config", {
    key: `event_anchor_${treeEventScopeId}`,
    value: eventId,
  });
}

/**
 * Refreshes the access token using the stored refresh token.
 * Updates currentSession in-place so existing httpClient closures see the new token.
 * Persists the new tokens to the Rust keyring.
 */
async function refreshSession(): Promise<void> {
  if (!currentSession) throw new Error("No session to refresh");
  const { uid, refreshToken, userId } = currentSession;

  const resp = await fetch(`${BASE_URL}/auth/v4/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pm-appversion": APP_VERSION,
      "x-pm-uid": uid,
      Authorization: `Bearer ${refreshToken}`,
    },
    body: JSON.stringify({ UID: uid, RefreshToken: refreshToken }),
  });

  if (!resp.ok) {
    // 4xx means the refresh token itself is rejected — session is dead.
    if (resp.status >= 400 && resp.status < 500) {
      _onSessionExpired?.();
    }
    throw new Error(`Token refresh failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    AccessToken: string;
    RefreshToken: string;
    UID: string;
  };

  currentSession.accessToken = data.AccessToken;
  currentSession.refreshToken = data.RefreshToken;

  await invoke("store_tokens", {
    uid,
    accessToken: data.AccessToken,
    refreshToken: data.RefreshToken,
    userId,
  });
}

/**
 * Refreshes tokens using only a refresh token (no currentSession required).
 * Used during the unlock flow, before initDriveClient has been called.
 * Returns the new tokens and persists them to the keyring.
 */
export async function refreshTokens(
  uid: string,
  refreshToken: string,
  userId: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const resp = await fetch(`${BASE_URL}/auth/v4/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pm-appversion": APP_VERSION,
      "x-pm-uid": uid,
      Authorization: `Bearer ${refreshToken}`,
    },
    body: JSON.stringify({ UID: uid, RefreshToken: refreshToken }),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const data = (await resp.json()) as { AccessToken: string; RefreshToken: string };

  await invoke("store_tokens", {
    uid,
    accessToken: data.AccessToken,
    refreshToken: data.RefreshToken,
    userId,
  });

  return { accessToken: data.AccessToken, refreshToken: data.RefreshToken };
}

export async function initDriveClient(session: DriveSession): Promise<void> {
  await initCrypto();

  currentSession = session;

  const httpClient = createHttpClient(
    () => currentSession?.accessToken ?? null,
    () => currentSession?.uid ?? null,
    () => refreshSession(),
  );

  const account = createAccountProvider(
    () => currentSession!.accessToken,
    () => currentSession!.uid,
    () => currentSession!.keyPassword,
  );

  driveClient = new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: createOpenPGPCryptoModule(),
    srpModule: createSrpModule(),
    featureFlagProvider: new NullFeatureFlagProvider(),
    latestEventIdProvider,
  });
}

export function getDriveClient(): ProtonDriveClient {
  if (!driveClient) throw new Error("Drive client not initialized — call initDriveClient first");
  return driveClient;
}

export function releaseDriveClient(): void {
  driveClient = null;
  currentSession = null;
  _onSessionExpired = null;
}

export async function getSyncRoot(): Promise<MaybeNode> {
  return getDriveClient().getMyFilesRootFolder();
}

export async function* listFolderChildren(
  nodeUid: NodeOrUid,
  filterOptions?: { type?: NodeType },
  signal?: AbortSignal,
) {
  yield* getDriveClient().iterateFolderChildren(nodeUid, filterOptions, signal);
}

export async function getNode(nodeUid: NodeOrUid): Promise<MaybeNode> {
  return getDriveClient().getNode(nodeUid);
}

export async function subscribeToDriveEvents(
  listener: DriveListener,
): Promise<EventSubscription> {
  return getDriveClient().subscribeToDriveEvents(listener);
}

export async function subscribeToTreeEvents(
  treeEventScopeId: string,
  listener: DriveListener,
): Promise<EventSubscription> {
  return getDriveClient().subscribeToTreeEvents(treeEventScopeId, listener);
}

export async function getFileDownloader(
  nodeUid: NodeOrUid,
  signal?: AbortSignal,
): Promise<FileDownloader> {
  return getDriveClient().getFileDownloader(nodeUid, signal);
}

export async function getFileUploader(
  parentFolderUid: NodeOrUid,
  name: string,
  metadata: UploadMetadata,
  signal?: AbortSignal,
): Promise<FileUploader> {
  return getDriveClient().getFileUploader(parentFolderUid, name, metadata, signal);
}

export async function getFileRevisionUploader(
  nodeUid: NodeOrUid,
  metadata: UploadMetadata,
  signal?: AbortSignal,
): Promise<FileUploader> {
  return getDriveClient().getFileRevisionUploader(nodeUid, metadata, signal);
}

export async function createFolder(
  parentNodeUid: NodeOrUid,
  name: string,
  modificationTime?: Date,
): Promise<MaybeNode> {
  return getDriveClient().createFolder(parentNodeUid, name, modificationTime);
}

/**
 * Finds an existing folder by name under the given parent, or creates it.
 * Returns the folder's MaybeNode.
 */
export async function findOrCreateFolder(
  parentUid: NodeOrUid,
  name: string,
): Promise<MaybeNode> {
  for await (const child of getDriveClient().iterateFolderChildren(parentUid, { type: NodeType.Folder })) {
    if (child.ok && child.value.name === name) {
      return child;
    }
  }
  return getDriveClient().createFolder(parentUid, name);
}

/**
 * Derive the key password from user password + primary key salt fetched from API.
 * Call this immediately after a successful Rust login.
 */
export async function deriveKeyPassword(
  password: string,
  accessToken: string,
  uid: string,
): Promise<string> {
  await initCrypto();

  const resp = await fetch(`${BASE_URL}/core/v4/keys/salts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-pm-uid": uid,
      "x-pm-appversion": APP_VERSION,
    },
  });
  if (!resp.ok) throw new Error(`Failed to fetch key salts: ${resp.status}`);
  const data = (await resp.json()) as {
    KeySalts: Array<{ ID: string; KeySalt: string | null }>;
  };

  const primarySalt = data.KeySalts.find((s) => s.KeySalt !== null);
  if (!primarySalt?.KeySalt) throw new Error("No key salt found");

  return computeKeyPassword(password, primarySalt.KeySalt);
}
