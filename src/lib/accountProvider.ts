import { CryptoProxy } from "@protontech/crypto";
import type { PublicKeyReference as PublicKey } from "@protontech/crypto";
import { fetch } from "./tauriFetch";
import type {
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
} from "@protontech/drive-sdk";

const BASE_URL = import.meta.env.VITE_PROTON_API_BASE ?? "https://mail.proton.me/api";
const APP_VERSION = import.meta.env.VITE_PROTON_APP_VERSION ?? "external-drive-protondrive@0.1.0-alpha";

interface AddressKey {
  ID: string;
  PrivateKey: string; // armored
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

async function decryptAddressKey(armoredKey: string, keyPassword: string) {
  return CryptoProxy.importPrivateKey({ armoredKey, passphrase: keyPassword });
}

async function buildAddress(
  address: Address,
  keyPassword: string,
): Promise<ProtonDriveAccountAddress> {
  const keys: ProtonDriveAccountAddress["keys"] = [];
  for (const k of address.Keys) {
    try {
      const key = await decryptAddressKey(k.PrivateKey, keyPassword);
      keys.push({ id: k.ID, key });
    } catch {
      // Skip keys we can't decrypt
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
    const data = (await apiFetch("/core/v4/addresses", token, uid)) as {
      Addresses: Address[];
    };
    cachedAddresses = await Promise.all(
      data.Addresses.map((a) => buildAddress(a, keyPassword)),
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
        return data.Code !== 1000; // 1000 = available (no account)
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
            // Skip invalid keys
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
