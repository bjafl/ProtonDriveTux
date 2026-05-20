/**
 * All Proton Drive SDK interaction goes through this module.
 * Isolates the SDK behind a stable API so breaking SDK changes only touch here.
 */
import {
  MemoryCache,
  NullFeatureFlagProvider,
  ProtonDriveClient,
  type DriveListener,
  type EventSubscription,
  type FileDownloader,
  type FileUploader,
  type MaybeNode,
  type NodeOrUid,
  type NodeType,
  type UploadMetadata,
} from "@protontech/drive-sdk";

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
  keyPassword: string;
}

let driveClient: ProtonDriveClient | null = null;
let currentSession: DriveSession | null = null;

export async function initDriveClient(session: DriveSession): Promise<void> {
  await initCrypto();

  currentSession = session;

  const httpClient = createHttpClient(
    () => currentSession?.accessToken ?? null,
    () => currentSession?.uid ?? null,
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
  });
}

export function getDriveClient(): ProtonDriveClient {
  if (!driveClient) throw new Error("Drive client not initialized — call initDriveClient first");
  return driveClient;
}

export function releaseDriveClient(): void {
  driveClient = null;
  currentSession = null;
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

export async function createFolder(
  parentNodeUid: NodeOrUid,
  name: string,
  modificationTime?: Date,
): Promise<MaybeNode> {
  return getDriveClient().createFolder(parentNodeUid, name, modificationTime);
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
