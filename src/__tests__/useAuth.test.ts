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

// --- Task 3: startLogin state machine tests ---

const LOGIN_RESULT_BASE = {
  uid: "uid1",
  accessToken: "at1",
  refreshToken: "rt1",
  userId: "usr1",
  twoFactorRequired: false,
  dualPasswordMode: false,
};

describe("useAuth — startLogin", () => {
  it("transitions loginStarted → loggedIn for a straight login", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue(LOGIN_RESULT_BASE);
    vi.mocked(deriveKeyPassword).mockResolvedValue("kp1");
    vi.mocked(initDriveClient).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));

    act(() => { result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("loginStarted");

    await waitFor(() => expect(result.current.state).toBe("loggedIn"));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tokens?.accessToken).toBe("at1");
    expect(result.current.keyPassword).toBe("kp1");
  });

  it("transitions to pendingTotp when 2FA is required", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      twoFactorRequired: true,
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));

    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingTotp");
  });

  it("transitions to pendingDualPassword when dualPasswordMode is true", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      dualPasswordMode: true,
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));

    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingDualPassword");
  });

  it("transitions to pendingHv and exposes hvToken/hvMethods", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockRejectedValue(
      new HumanVerificationError("hv-tok-123", ["captcha"]),
    );

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));

    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingHv");
    expect(result.current.hvToken).toBe("hv-tok-123");
    expect(result.current.hvMethods).toEqual(["captcha"]);
  });

  it("sets state to error on unexpected login failure", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockRejectedValue(new Error("network failure"));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));

    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("error");
    expect(result.current.error?.message).toContain("network failure");
  });
});

// --- Task 4: submitTotp, submitMailboxPassword, retryWithCaptcha tests ---

describe("useAuth — submitTotp", () => {
  it("completes login after TOTP: pendingTotp → loggedIn", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      twoFactorRequired: true,
    });
    vi.mocked(apiSubmitTotp).mockResolvedValue(undefined);
    vi.mocked(deriveKeyPassword).mockResolvedValue("kp1");
    vi.mocked(initDriveClient).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingTotp");

    await act(async () => { await result.current.submitTotp("123456"); });
    expect(result.current.state).toBe("loggedIn");
    expect(result.current.keyPassword).toBe("kp1");
    expect(vi.mocked(apiSubmitTotp)).toHaveBeenCalledWith(
      "uid1",
      "at1",
      "rt1",
      "usr1",
      "123456",
    );
  });

  it("sets state to error when TOTP submission fails", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      twoFactorRequired: true,
    });
    vi.mocked(apiSubmitTotp).mockRejectedValue(new Error("invalid TOTP"));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingTotp");

    await act(async () => { await result.current.submitTotp("000000"); });
    expect(result.current.state).toBe("error");
    expect(result.current.error?.message).toContain("invalid TOTP");
  });
});

describe("useAuth — submitMailboxPassword", () => {
  it("completes login after mailbox password: pendingDualPassword → loggedIn", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      dualPasswordMode: true,
    });
    vi.mocked(deriveKeyPassword).mockResolvedValue("kp-mailbox");
    vi.mocked(initDriveClient).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingDualPassword");

    await act(async () => { await result.current.submitMailboxPassword("mailbox-pass"); });
    expect(result.current.state).toBe("loggedIn");
    expect(result.current.keyPassword).toBe("kp-mailbox");
    // Verify mailbox password was used for key derivation, not login password
    expect(vi.mocked(deriveKeyPassword)).toHaveBeenCalledWith(
      "mailbox-pass",
      "uid1",
      "at1",
    );
  });

  it("sets state to error when key derivation fails", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockResolvedValue({
      ...LOGIN_RESULT_BASE,
      dualPasswordMode: true,
    });
    vi.mocked(deriveKeyPassword).mockRejectedValue(new Error("wrong mailbox password"));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingDualPassword");

    await act(async () => { await result.current.submitMailboxPassword("bad-pass"); });
    expect(result.current.state).toBe("error");
    expect(result.current.error?.message).toContain("wrong mailbox password");
  });
});

describe("useAuth — retryWithCaptcha", () => {
  it("retries login with captcha token and succeeds", async () => {
    vi.mocked(getSessionTokens).mockResolvedValue(null);
    vi.mocked(apiStartLogin).mockRejectedValue(
      new HumanVerificationError("hv-tok", ["captcha"]),
    );
    vi.mocked(startLoginWithCaptcha).mockResolvedValue(LOGIN_RESULT_BASE);
    vi.mocked(deriveKeyPassword).mockResolvedValue("kp1");
    vi.mocked(initDriveClient).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("loggedOut"));
    await act(async () => { await result.current.startLogin("user@proton.me", "pass"); });
    expect(result.current.state).toBe("pendingHv");

    await act(async () => { await result.current.retryWithCaptcha("solved-captcha-token"); });
    expect(result.current.state).toBe("loggedIn");
    expect(vi.mocked(startLoginWithCaptcha)).toHaveBeenCalledWith(
      "user@proton.me",
      "pass",
      "solved-captcha-token",
    );
  });
});
