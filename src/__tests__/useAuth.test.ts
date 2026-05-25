import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAuth } from "../hooks/useAuth";

// --- Mocks ---

vi.mock("../lib/ipcApi", () => ({
  getKeyPassword: vi.fn(),
  getSessionTokens: vi.fn(),
  getAuthStatus: vi.fn(),
  logout: vi.fn(),
  storeKeyPassword: vi.fn(),
}));

vi.mock("../lib/drive", () => ({
  deriveKeyPassword: vi.fn(),
  initDriveClient: vi.fn(),
  releaseDriveClient: vi.fn(),
  refreshTokens: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  startLogin: vi.fn(),
  startLoginWithCaptcha: vi.fn(),
  submitTotp: vi.fn(),
  HumanVerificationError: class HumanVerificationError extends Error {
    hvToken: string;
    methods: string[];
    constructor(hvToken: string, methods: string[]) {
      super("Human verification required");
      this.name = "HumanVerificationError";
      this.hvToken = hvToken;
      this.methods = methods;
    }
  },
  AuthExpiredError: class AuthExpiredError extends Error {
    status: number;
    constructor(status: number) {
      super(`Session expired (HTTP ${status})`);
      this.name = "AuthExpiredError";
      this.status = status;
    }
  },
}));

import { getSessionTokens, getAuthStatus, getKeyPassword } from "../lib/ipcApi";
import {
  startLogin as apiStartLogin,
  startLoginWithCaptcha,
  submitTotp as apiSubmitTotp,
  HumanVerificationError,
} from "../lib/auth";
import { deriveKeyPassword, initDriveClient } from "../lib/drive";

const TOKENS = {
  uid: "uid1",
  accessToken: "at1",
  refreshToken: "rt1",
  userId: "usr1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthStatus).mockResolvedValue({ loggedIn: false, userId: null });
  vi.mocked(getSessionTokens).mockResolvedValue(null);
  vi.mocked(getKeyPassword).mockResolvedValue(null);
});

// --- Tests ---

describe("useAuth — initial state", () => {
  it("starts in loading state before refresh completes", () => {
    // Do NOT await anything — check synchronous initial value
    const { result } = renderHook(() => useAuth());
    expect(result.current.state).toBe("loading");
    expect(result.current.loggedIn).toBe(false);
  });
});

describe("useAuth — refresh on mount", () => {
  it("transitions to loggedOut when no session tokens exist", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    expect(result.current.loggedIn).toBe(false);
    expect(result.current.tokens).toBeUndefined();
  });

  it("transitions to loggedIn when session tokens and key password exist", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(TOKENS);
    vi.mocked(getKeyPassword).mockResolvedValue("kp1");

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedIn"));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tokens?.accessToken).toBe("at1");
    expect(result.current.keyPassword).toBe("kp1");
    expect(result.current.userId).toBe("usr1");
  });

  it("transitions to loggedIn with tokens but no keyPassword (will unlock)", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(TOKENS);
    vi.mocked(getKeyPassword).mockResolvedValue(null);

    const { result } = renderHook(() => useAuth());
    // State should be loggedIn (tokens present) but keyPassword undefined
    await waitFor(() => expect(result.current.state).toBe("loggedIn"));
    expect(result.current.keyPassword).toBeUndefined();
  });
});
