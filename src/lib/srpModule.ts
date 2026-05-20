import { getSrp, computeKeyPassword, generateKeySalt } from "@protontech/crypto/srp";

// SRPModule shape matches sdk/src/crypto/interface.ts (not re-exported from top-level)
export interface SRPModule {
  getSrp: (
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string,
  ) => Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }>;
  getSrpVerifier: (password: string) => Promise<{ modulusId: string; version: number; salt: string; verifier: string }>;
  computeKeyPassword: (password: string, salt: string) => Promise<string>;
  generateKeySalt: () => string;
}

export function createSrpModule(): SRPModule {
  return {
    getSrp: async (version, modulus, serverEphemeral, salt, password) => {
      const result = await getSrp(
        { Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
        { password },
      );
      return {
        clientProof: result.clientProof,
        clientEphemeral: result.clientEphemeral,
        expectedServerProof: result.expectedServerProof,
      };
    },

    getSrpVerifier: async (_password) => {
      // Not needed for our auth flow — Rust handles SRP login
      throw new Error("getSrpVerifier not supported — auth is handled by the Rust layer");
    },

    computeKeyPassword,
    generateKeySalt,
  };
}

export { computeKeyPassword };
