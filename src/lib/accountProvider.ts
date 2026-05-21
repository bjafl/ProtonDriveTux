import { CryptoProxy } from "@protontech/crypto";
import type { PrivateKeyReference, PublicKeyReference as PublicKey } from "@protontech/crypto";
import { fetch } from "./tauriFetch";
import type {
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
} from "@protontech/drive-sdk";

const BASE_URL = import.meta.env.VITE_PROTON_API_BASE ?? "https://mail.proton.me/api";
const APP_VERSION = import.meta.env.VITE_PROTON_APP_VERSION ?? "external-drive-protondrive@0.1.0-alpha";

interface UserKey {
  ID: string;
  PrivateKey: string;
  Active: number;
  Primary: number;
}

interface AddressKey {
  ID: string;
  PrivateKey: string;
  Token?: string;     // present when key is encrypted with user key (older accounts)
  Signature?: string;
  Active: number;
  Primary: number;
}

interface Address {
  ID: string;
  Email: string;
  Keys: AddressKey[];
}

interface PublicKeysResponse {
  RecipientType: number;
  Keys: Array<{ Flags: number; PublicKey: string }>;
}

async function apiFetch(path: string, token: string, uid: string): Promise<unknown> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-pm-uid": uid,
      "x-pm-appversion": APP_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) throw new Error(`API ${path} failed: ${resp.status}`);
  return resp.json();
}

async function fetchAndDecryptUserKeys(
  keyPassword: string,
  token: string,
  uid: string,
): Promise<PrivateKeyReference[]> {
  const data = (await apiFetch("/core/v4/users", token, uid)) as {
    User: { Keys: UserKey[] };
  };
  const decrypted: PrivateKeyReference[] = [];
  for (const k of data.User.Keys) {
    if (!k.Active) continue;
    try {
      const key = await CryptoProxy.importPrivateKey({ armoredKey: k.PrivateKey, passphrase: keyPassword });
      decrypted.push(key);
    } catch {
      // skip undecryptable user keys
    }
  }
  return decrypted;
}

async function decryptAddressKey(
  armoredKey: string,
  encryptedToken: string | undefined,
  userKeys: PrivateKeyReference[],
  keyPassword: string,
): Promise<PrivateKeyReference> {
  // Token-encrypted address key (older accounts): decrypt token with user key first.
  if (encryptedToken && userKeys.length > 0) {
    try {
      const { data: passphrase } = await CryptoProxy.decryptMessage({
        armoredMessage: encryptedToken,
        decryptionKeys: userKeys,
      });
      return CryptoProxy.importPrivateKey({ armoredKey, passphrase });
    } catch {
      // fall through to direct key password
    }
  }
  return CryptoProxy.importPrivateKey({ armoredKey, passphrase: keyPassword });
}

async function buildAddress(
  address: Address,
  userKeys: PrivateKeyReference[],
  keyPassword: string,
): Promise<ProtonDriveAccountAddress> {
  const keys: ProtonDriveAccountAddress["keys"] = [];
  for (const k of address.Keys) {
    if (!k.Active) continue;
    try {
      const key = await decryptAddressKey(k.PrivateKey, k.Token, userKeys, keyPassword);
      keys.push({ id: k.ID, key });
    } catch {
      // skip undecryptable address keys
    }
  }
  const primaryIndex = address.Keys.findIndex((k) => k.Primary === 1);
  return {
    email: address.Email,
    addressId: address.ID,
    primaryKeyIndex: primaryIndex >= 0 ? primaryIndex : 0,
    keys,
  };
}

export function createAccountProvider(
  getAccessToken: () => string,
  getUid: () => string,
  getKeyPassword: () => string,
): ProtonDriveAccount {
  let cachedAddresses: ProtonDriveAccountAddress[] | null = null;
  const publicKeyCache = new Map<string, PublicKey[]>();

  async function fetchAddresses(): Promise<ProtonDriveAccountAddress[]> {
    if (cachedAddresses) return cachedAddresses;
    const token = getAccessToken();
    const uid = getUid();
    const keyPassword = getKeyPassword();

    // User keys must be decrypted first — they unlock token-encrypted address keys.
    const userKeys = await fetchAndDecryptUserKeys(keyPassword, token, uid);

    const data = (await apiFetch("/core/v4/addresses", token, uid)) as {
      Addresses: Address[];
    };
    cachedAddresses = await Promise.all(
      data.Addresses.map((a) => buildAddress(a, userKeys, keyPassword)),
    );
    return cachedAddresses;
  }

  return {
    async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
      const addresses = await fetchAddresses();
      const primary = addresses.find((a) => a.keys.length > 0);
      if (!primary) throw new Error("No usable primary address found");
      return primary;
    },

    async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
      return fetchAddresses();
    },

    async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
      const addresses = await fetchAddresses();
      const found = addresses.find(
        (a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId,
      );
      if (!found) throw new Error(`Address not found: ${emailOrAddressId}`);
      return found;
    },

    async hasProtonAccount(email: string): Promise<boolean> {
      try {
        const token = getAccessToken();
        const uid = getUid();
        const data = (await apiFetch(
          `/core/v4/users/available?Name=${encodeURIComponent(email)}`,
          token,
          uid,
        )) as { Code: number };
        return data.Code !== 1000; // 1000 = available (= no account exists)
      } catch {
        return false;
      }
    },

    async getPublicKeys(email: string, forceRefresh = false): Promise<PublicKey[]> {
      if (!forceRefresh && publicKeyCache.has(email)) {
        return publicKeyCache.get(email)!;
      }
      try {
        const token = getAccessToken();
        const uid = getUid();
        const data = (await apiFetch(
          `/core/v4/keys?Email=${encodeURIComponent(email)}`,
          token,
          uid,
        )) as PublicKeysResponse;
        const keys: PublicKey[] = [];
        for (const k of data.Keys ?? []) {
          try {
            const key = await CryptoProxy.importPublicKey({ armoredKey: k.PublicKey });
            keys.push(key);
          } catch {
            // skip invalid keys
          }
        }
        publicKeyCache.set(email, keys);
        return keys;
      } catch {
        return [];
      }
    },
  };
}
