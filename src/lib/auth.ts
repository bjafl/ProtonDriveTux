/**
 * SRP login flow — all in JS using @protontech/crypto/srp.
 * Rust is only used for storing tokens in GNOME Keyring.
 */
import { getSrp } from "@protontech/crypto/srp";
import { invoke } from "@tauri-apps/api/core";
import { initCrypto } from "./cryptoModule";
import { fetch } from "./tauriFetch";

const BASE_URL =
  import.meta.env.VITE_PROTON_API_BASE ?? "https://mail.proton.me/api";
const APP_VERSION =
  import.meta.env.VITE_PROTON_APP_VERSION ??
  "external-drive-protondrive@0.1.0-alpha";

export const CAPTCHA_BASE = "https://verify.proton.me";

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-pm-appversion": APP_VERSION,
    ...extra,
  };
}

export class HumanVerificationError extends Error {
  constructor(
    public readonly hvToken: string,
    public readonly methods: string[],
  ) {
    super("Human verification required");
    this.name = "HumanVerificationError";
  }
}

/** Thrown when a session-critical request returns a 4xx — session is dead, must re-login. */
export class AuthExpiredError extends Error {
  constructor(public readonly status: number) {
    super(`Session expired (HTTP ${status})`);
    this.name = "AuthExpiredError";
  }
}

interface ApiErrorResponse {
  Code: number;
  Error?: string;
  Details?: {
    HumanVerificationToken?: string;
    HumanVerificationMethods?: string[];
  };
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const opts = {
    ...init,
    headers: {
      ...headers(),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
  const resp = await fetch(`${BASE_URL}${path}`, opts);
  const json = (await resp.json()) as ApiErrorResponse & T;

  if (json.Code === 9001) {
    const hvToken = json.Details?.HumanVerificationToken ?? "";
    const methods = json.Details?.HumanVerificationMethods ?? ["captcha"];
    throw new HumanVerificationError(hvToken, methods);
  }

  if (!resp.ok || (json.Code !== 1000 && json.Code !== 1001)) {
    throw new Error(json.Error ?? `HTTP ${resp.status}`);
  }
  return json;
}

interface AuthInfoResponse {
  Code: number;
  Modulus: string;
  ServerEphemeral: string;
  Version: number;
  Salt: string;
  SRPSession: string;
}

interface AuthResponse {
  Code: number;
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  UserID: string;
  "2FA": { Enabled: number };
  PasswordMode: number; // 1 = single password, 2 = dual (separate mailbox password)
}

export interface LoginResult {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  twoFactorRequired: boolean;
  /** True for legacy accounts where the mailbox password differs from the login password. */
  dualPasswordMode: boolean;
}

async function doSrpAuth(
  username: string,
  password: string,
  hvHeaders?: Record<string, string>,
): Promise<LoginResult> {
  const info = await apiFetch<AuthInfoResponse>(`/auth/v4/info`, {
    method: "POST",
    body: JSON.stringify({ Username: username }),
  });

  const { clientProof, clientEphemeral } = await getSrp(
    {
      Version: info.Version,
      Modulus: info.Modulus,
      ServerEphemeral: info.ServerEphemeral,
      Salt: info.Salt,
    },
    { username, password },
  );

  const auth = await apiFetch<AuthResponse>(`/auth/v4`, {
    method: "POST",
    headers: hvHeaders,
    body: JSON.stringify({
      Username: username,
      ClientEphemeral: clientEphemeral,
      ClientProof: clientProof,
      SRPSession: info.SRPSession,
    }),
  });

  if (auth.AccessToken && auth["2FA"].Enabled === 0) {
    await persistTokens(auth.UID, auth.AccessToken, auth.RefreshToken, auth.UserID);
  }

  return {
    uid: auth.UID,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
    userId: auth.UserID,
    twoFactorRequired: auth["2FA"].Enabled !== 0,
    dualPasswordMode: auth.PasswordMode === 2,
  };
}

export async function startLogin(username: string, password: string): Promise<LoginResult> {
  await initCrypto();
  return doSrpAuth(username, password);
}

export async function startLoginWithCaptcha(
  username: string,
  password: string,
  captchaToken: string,
): Promise<LoginResult> {
  return doSrpAuth(username, password, {
    "x-pm-human-verification-token": captchaToken,
    "x-pm-human-verification-token-type": "captcha",
  });
}

interface TwoFAResponse {
  Code: number;
}

export async function submitTotp(
  uid: string,
  accessToken: string,
  refreshToken: string,
  userId: string,
  totpCode: string,
): Promise<void> {
  await apiFetch<TwoFAResponse>(`/auth/v4/2fa`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-pm-uid": uid,
    },
    body: JSON.stringify({ TwoFactorCode: totpCode }),
  });

  await persistTokens(uid, accessToken, refreshToken, userId);
}

async function persistTokens(
  uid: string,
  accessToken: string,
  refreshToken: string,
  userId: string,
): Promise<void> {
  await invoke("store_tokens", { uid, accessToken, refreshToken, userId });
}

export async function doLogout(accessToken: string, uid: string): Promise<void> {
  try {
    await apiFetch(`/auth/v4`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}`, "x-pm-uid": uid },
    });
  } catch {
    // Best-effort — Rust will clear keyring regardless
  }
  await invoke("logout");
}
