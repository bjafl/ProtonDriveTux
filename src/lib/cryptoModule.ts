import { CryptoProxy } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { OpenPGPCryptoWithCryptoProxy } from "@protontech/drive-sdk";

let initialized = false;

export async function initCrypto(): Promise<void> {
  if (initialized) return;
  CryptoApi.init({});
  CryptoProxy.setEndpoint(new CryptoApi());
  initialized = true;
}

export function createOpenPGPCryptoModule() {
  return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

export { CryptoProxy };
