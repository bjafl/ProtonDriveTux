# Auth Hook Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken `useAuth` state machine and wire all auth components through it so no component calls auth APIs directly.

**Architecture:** `useAuth` holds all mutable auth state in refs; `deriveAuthInfo()` reads them and produces `AuthInfo`; every ref mutation calls `setAuthInfo(deriveAuthInfo())`. Components observe `state` and call hook methods — no direct API calls.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Tauri IPC

---

## File Map

| File | Action |
|------|--------|
| `src/hooks/useAuth.ts` | Full rewrite |
| `src/__tests__/useAuth.test.ts` | New — hook state machine tests |
| `src/App.tsx` | Fix destructuring + auth effect |
| `src/components/LoginForm.tsx` | Remove broken logic, wire to hook |
| `src/components/UnlockForm.tsx` | One-line fix (`accessToken` → `tokens?.accessToken`) |

---

## Task 1: Install @testing-library/react and write core state tests

**Files:**
- Modify: `package.json`
- Create: `src/__tests__/useAuth.test.ts`

- [ ] **Step 1: Install testing library**

```bash
cd /home/bjafl/source/proton-drive-workspace/proton-drive-linux-sync
pnpm add -D @testing-library/react
```

Expected: `@testing-library/react` added to devDependencies.

- [ ] **Step 2: Write failing tests for core state behaviour**

Create `src/__tests__/useAuth.test.ts`:

```typescript
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
import { startLogin as apiStartLogin, startLoginWithCaptcha, submitTotp as apiSubmitTotp, HumanVerificationError } from "../lib/auth";
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
```

- [ ] **Step 3: Run tests — expect failures**

```bash
pnpm test src/__tests__/useAuth.test.ts
```

Expected: FAIL — `useAuth` import errors or state never resolves.

---

## Task 2: Rewrite `useAuth.ts` — refs, deriveAuthInfo, refresh

**Files:**
- Modify: `src/hooks/useAuth.ts`

- [ ] **Step 4: Rewrite `useAuth.ts` core (keep startLogin/unlock/logout stubs for now)**

Replace the entire file:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AuthErrorInfo,
  type AuthErrorType,
  type AuthInfo,
  type LoginState,
  type SessionTokens,
} from "../types/auth";
import {
  refreshTokens as apiRefreshTokens,
  releaseDriveClient,
  deriveKeyPassword,
  initDriveClient,
} from "../lib/drive";
import { AuthExpiredError, HumanVerificationError } from "../lib/auth";
import {
  logout as ipcLogout,
  getKeyPassword,
  storeKeyPassword,
  getAuthStatus,
  getSessionTokens,
} from "../lib/ipcApi";
import type { ErrorLevel } from "../types/logging";
import {
  startLogin as apiStartLogin,
  startLoginWithCaptcha,
  submitTotp as apiSubmitTotp,
} from "../lib/auth";

class NoTokensError extends Error {}

interface HvData {
  hvToken: string;
  methods: string[];
}

interface Credentials {
  username: string;
  password: string;
  remember: boolean;
}

export function useAuth() {
  const tokensRef = useRef<SessionTokens | null>(null);
  const errorRef = useRef<AuthErrorInfo | null>(null);
  const keyPasswordRef = useRef<string | null>(null);
  // Starts as "loading"; cleared to null after first refresh completes.
  const loginStateRef = useRef<LoginState | null>("loading");
  const hvDataRef = useRef<HvData | null>(null);
  const credentialsRef = useRef<Credentials | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const [authInfo, setAuthInfo] = useState<
    AuthInfo & { hvToken?: string; hvMethods?: string[] }
  >({ loggedIn: false, userId: null, state: "loading" });

  function deriveAuthInfo(): AuthInfo & { hvToken?: string; hvMethods?: string[] } {
    const tokens = tokensRef.current ?? undefined;
    const error = errorRef.current ?? undefined;
    const keyPassword = keyPasswordRef.current ?? undefined;

    let state: LoginState;
    if (loginStateRef.current !== null) {
      state = loginStateRef.current;
    } else if (tokens?.accessToken) {
      state = "loggedIn";
    } else if (refreshPromiseRef.current !== null) {
      state = "refreshing";
    } else if (error != null) {
      state = "error";
    } else {
      state = "loggedOut";
    }

    const hvData = state === "pendingHv" ? hvDataRef.current : null;

    return {
      loggedIn: state === "loggedIn",
      userId: tokens?.userId ?? null,
      tokens,
      keyPassword,
      state,
      error,
      hvToken: hvData?.hvToken,
      hvMethods: hvData?.methods,
    };
  }

  function _updateError({
    level = "error" as ErrorLevel,
    type = "unknown" as AuthErrorType,
    message,
    error,
  }: {
    level?: ErrorLevel;
    type?: AuthErrorType;
    message?: string;
    error?: unknown;
  }) {
    errorRef.current = {
      level,
      type,
      message: message ?? (error ? String(error) : ""),
      error: error instanceof Error ? error : undefined,
    };
  }

  async function _getKeyPassword(): Promise<void> {
    try {
      keyPasswordRef.current = await getKeyPassword();
    } catch (error) {
      _updateError({ type: "expired", error });
    }
  }

  async function _doRefresh(
    refreshTokensFlag = false,
    keyPasswordFlag = false,
  ): Promise<void> {
    const [, tokens] = await Promise.all([getAuthStatus(), getSessionTokens()]);
    if (tokens) {
      tokensRef.current = tokens;
    }
    if (keyPasswordFlag || keyPasswordRef.current == null) {
      await _getKeyPassword();
    }
    if (refreshTokensFlag) {
      await _refreshTokens();
    }
  }

  const _refreshTokens = useCallback(async (): Promise<void> => {
    if (!tokensRef.current) throw new NoTokensError();
    try {
      const refreshed = await apiRefreshTokens(
        tokensRef.current.uid,
        tokensRef.current.refreshToken,
        tokensRef.current.userId,
      );
      tokensRef.current = { ...tokensRef.current, ...refreshed };
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        _updateError({ type: "expired", error });
        await logout();
        return;
      }
      _updateError({ level: "warn", type: "refreshFailed", error });
    }
  }, []);

  async function _deriveKeyPassword(
    password: string,
    remember = false,
  ): Promise<boolean> {
    const tokens = tokensRef.current;
    if (!tokens) throw new NoTokensError();
    try {
      const newKeyPwd = await deriveKeyPassword(
        password,
        tokens.uid,
        tokens.accessToken,
      );
      await initDriveClient({ ...tokens, keyPassword: newKeyPwd });
      if (remember) {
        await storeKeyPassword(newKeyPwd).catch(console.error);
      }
      keyPasswordRef.current = newKeyPwd;
      return true;
    } catch (error: unknown) {
      if (error instanceof AuthExpiredError) {
        await _refreshTokens();
        return _deriveKeyPassword(password, remember);
      }
      _updateError({ type: "loginError", error });
      return false;
    }
  }

  const refresh = useCallback(
    async ({
      refreshTokens = false,
      keyPassword = false,
    }: { refreshTokens?: boolean; keyPassword?: boolean } = {}): Promise<void> => {
      if (refreshPromiseRef.current) {
        return refreshPromiseRef.current;
      }
      refreshPromiseRef.current = _doRefresh(refreshTokens, keyPassword);
      setAuthInfo(deriveAuthInfo());
      await refreshPromiseRef.current;
      refreshPromiseRef.current = null;
      loginStateRef.current = null;
      setAuthInfo(deriveAuthInfo());
    },
    [],
  );

  const startLogin = useCallback(
    async (
      username: string,
      password: string,
      remember = false,
    ): Promise<void> => {
      if (loginStateRef.current === "loginStarted") return;
      credentialsRef.current = { username, password, remember };
      errorRef.current = null;
      loginStateRef.current = "loginStarted";
      setAuthInfo(deriveAuthInfo());
      try {
        const result = await apiStartLogin(username, password);
        tokensRef.current = {
          uid: result.uid,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
        };
        if (result.twoFactorRequired) {
          loginStateRef.current = "pendingTotp";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        if (result.dualPasswordMode) {
          loginStateRef.current = "pendingDualPassword";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        loginStateRef.current = "pendingSrp";
        setAuthInfo(deriveAuthInfo());
        await _deriveKeyPassword(password, remember);
        loginStateRef.current = null;
        setAuthInfo(deriveAuthInfo());
      } catch (error: unknown) {
        if (error instanceof HumanVerificationError) {
          hvDataRef.current = { hvToken: error.hvToken, methods: error.methods };
          loginStateRef.current = "pendingHv";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        setAuthInfo(deriveAuthInfo());
      }
    },
    [],
  );

  const submitTotp = useCallback(async (totp: string): Promise<void> => {
    if (!tokensRef.current) throw new NoTokensError();
    const { uid, accessToken, refreshToken, userId } = tokensRef.current;
    try {
      await apiSubmitTotp(uid, accessToken, refreshToken, userId, totp);
      loginStateRef.current = "pendingSrp";
      setAuthInfo(deriveAuthInfo());
      const creds = credentialsRef.current;
      await _deriveKeyPassword(creds?.password ?? "", creds?.remember ?? false);
      loginStateRef.current = null;
      credentialsRef.current = null;
      setAuthInfo(deriveAuthInfo());
    } catch (error: unknown) {
      _updateError({ type: "loginError", error });
      loginStateRef.current = null;
      setAuthInfo(deriveAuthInfo());
    }
  }, []);

  const submitMailboxPassword = useCallback(
    async (password: string): Promise<void> => {
      if (!tokensRef.current) throw new NoTokensError();
      try {
        loginStateRef.current = "pendingSrp";
        setAuthInfo(deriveAuthInfo());
        await _deriveKeyPassword(
          password,
          credentialsRef.current?.remember ?? false,
        );
        loginStateRef.current = null;
        credentialsRef.current = null;
        setAuthInfo(deriveAuthInfo());
      } catch (error: unknown) {
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        setAuthInfo(deriveAuthInfo());
      }
    },
    [],
  );

  const retryWithCaptcha = useCallback(
    async (captchaToken: string): Promise<void> => {
      if (!credentialsRef.current) return;
      const { username, password, remember } = credentialsRef.current;
      hvDataRef.current = null;
      errorRef.current = null;
      loginStateRef.current = "loginStarted";
      setAuthInfo(deriveAuthInfo());
      try {
        const result = await startLoginWithCaptcha(username, password, captchaToken);
        tokensRef.current = {
          uid: result.uid,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
        };
        if (result.twoFactorRequired) {
          loginStateRef.current = "pendingTotp";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        if (result.dualPasswordMode) {
          loginStateRef.current = "pendingDualPassword";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        loginStateRef.current = "pendingSrp";
        setAuthInfo(deriveAuthInfo());
        await _deriveKeyPassword(password, remember);
        loginStateRef.current = null;
        credentialsRef.current = null;
        setAuthInfo(deriveAuthInfo());
      } catch (error: unknown) {
        if (error instanceof HumanVerificationError) {
          hvDataRef.current = { hvToken: error.hvToken, methods: error.methods };
          loginStateRef.current = "pendingHv";
          setAuthInfo(deriveAuthInfo());
          return;
        }
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        setAuthInfo(deriveAuthInfo());
      }
    },
    [],
  );

  const unlock = useCallback(
    async (password: string, rememberPass = false): Promise<boolean> => {
      await _refreshTokens();
      return _deriveKeyPassword(password, rememberPass);
    },
    [],
  );

  const logout = useCallback(async (): Promise<boolean> => {
    try {
      await ipcLogout();
      tokensRef.current = null;
      keyPasswordRef.current = null;
      errorRef.current = null;
      loginStateRef.current = null;
      hvDataRef.current = null;
      credentialsRef.current = null;
      setAuthInfo(deriveAuthInfo());
      return true;
    } catch (error) {
      _updateError({ error });
      setAuthInfo(deriveAuthInfo());
    } finally {
      releaseDriveClient();
    }
    return false;
  }, []);

  useEffect(() => {
    refresh();
  }, []);

  return {
    ...authInfo,
    startLogin,
    submitTotp,
    submitMailboxPassword,
    retryWithCaptcha,
    unlock,
    logout,
    refresh,
  };
}
```

- [ ] **Step 5: Run core state tests — expect them to pass**

```bash
pnpm test src/__tests__/useAuth.test.ts
```

Expected: 4 tests PASS. If `import` ordering causes mock-hoisting issues, move all `vi.mock(...)` calls before imports (vitest hoists them automatically, but explicit ordering helps).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAuth.ts src/__tests__/useAuth.test.ts package.json pnpm-lock.yaml
git commit -m "feat(auth): rewrite useAuth state machine with explicit setAuthInfo calls"
```

---

## Task 3: Add startLogin and HV tests

**Files:**
- Modify: `src/__tests__/useAuth.test.ts`

- [ ] **Step 7: Append login state machine tests to the test file**

Add the following after the existing `describe` blocks in `src/__tests__/useAuth.test.ts` (all imports are already at the top from Task 1):

```typescript
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
```

- [ ] **Step 8: Run all auth hook tests**

```bash
pnpm test src/__tests__/useAuth.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/__tests__/useAuth.test.ts
git commit -m "test(auth): add startLogin state machine tests"
```

---

## Task 4: Add submitTotp, submitMailboxPassword, retryWithCaptcha tests

**Files:**
- Modify: `src/__tests__/useAuth.test.ts`

- [ ] **Step 10: Append secondary-flow tests**

Add after existing `describe` blocks in `src/__tests__/useAuth.test.ts` (all imports are already at the top):

```typescript
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
```

- [ ] **Step 11: Run all auth hook tests**

```bash
pnpm test src/__tests__/useAuth.test.ts
```

Expected: all tests PASS.

- [ ] **Step 12: Commit**

```bash
git add src/__tests__/useAuth.test.ts
git commit -m "test(auth): add submitTotp, submitMailboxPassword, retryWithCaptcha tests"
```

---

## Task 5: Fix `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 13: Rewrite App.tsx**

Replace the entire file:

```typescript
import { useEffect, useState } from "react";
import { LoginForm } from "./components/LoginForm";
import { Onboarding, isOnboardingNeeded } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { useLang } from "./lib/i18n";
import { UnlockForm } from "./components/UnlockForm";
import "./App.css";
import { useAuth } from "./hooks/useAuth";

type AppState = "loading" | "unlocking" | "loggedOut" | "onboarding" | "ready";

export function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const {
    loggedIn,
    state: authState,
    tokens,
    error: authError,
    logout,
  } = useAuth();
  const { t } = useLang();

  const handleSessionExpired = async () => {
    await logout();
    setAppState("loggedOut");
  };

  useEffect(() => {
    if (authState === "loading" || authState === "refreshing") return;
    if (!loggedIn) {
      setAppState("loggedOut");
      return;
    }
    if (authError?.type === "expired") {
      handleSessionExpired();
      return;
    }
    if (!tokens?.keyPassword) {
      setAppState("unlocking");
      return;
    }
    isOnboardingNeeded().then((needed) =>
      setAppState(needed ? "onboarding" : "ready"),
    );
  }, [authState, loggedIn, tokens, authError]);

  const goToNextState = async () => {
    setAppState((await isOnboardingNeeded()) ? "onboarding" : "ready");
  };

  if (appState === "loading") return <div className="loading">{t.loading}</div>;
  if (appState === "loggedOut") {
    return <LoginForm onLoginSuccess={goToNextState} />;
  }
  if (appState === "onboarding") {
    return <Onboarding onComplete={() => setAppState("ready")} />;
  }
  if (appState === "unlocking") {
    return <UnlockForm onUnlocked={goToNextState} />;
  }

  return (
    <Dashboard
      onSessionExpired={handleSessionExpired}
      onOpenOnboarding={() => setAppState("onboarding")}
    />
  );
}
```

Changes from original:
- Removed `invoke` and `releaseDriveClient` imports (handled inside hook)
- Fixed destructuring to match hook return (`loggedIn`, `state`, `tokens`, `error`, `logout`)
- Removed redundant `refreshAuth()` call in mount effect (hook already refreshes on mount)
- Fixed auth effect: no longer discards `isOnboardingNeeded()` result
- `handleSessionExpired` now uses hook `logout()` instead of raw `invoke`

- [ ] **Step 14: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors in `App.tsx`. Fix any that appear before continuing.

- [ ] **Step 15: Commit**

```bash
git add src/App.tsx
git commit -m "fix(app): fix useAuth destructuring and auth state effect"
```

---

## Task 6: Rewrite `LoginForm.tsx` logic

**Files:**
- Modify: `src/components/LoginForm.tsx`

- [ ] **Step 16: Replace LoginForm.tsx**

Replace the entire file:

```typescript
import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { useAuth } from "../hooks/useAuth";
import { useHumanVerification } from "../hooks/useHumanVerification";

interface Props {
  onLoginSuccess: () => void;
}

type Step = "credentials" | "captcha" | "totp" | "mailbox";

export function LoginForm({ onLoginSuccess }: Props) {
  const [step, setStep] = useState<Step>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mailboxPassword, setMailboxPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hvMethods, setHvMethods] = useState<string[]>([]);

  const {
    startLogin,
    submitTotp,
    submitMailboxPassword,
    retryWithCaptcha,
    state: loginState,
    error: authError,
    hvToken,
    hvMethods: authHvMethods,
  } = useAuth();
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();
  const {
    openCaptchaWindow,
    closeCaptchaWindow,
    solvedToken: solvedCaptchaToken,
  } = useHumanVerification(theme);

  // Drive UI state from auth state machine
  useEffect(() => {
    if (loginState === "loginStarted" || loginState === "pendingSrp") {
      setLoading(true);
      setStatus(t.loggingIn);
      setError(null);
    } else if (loginState === "pendingTotp") {
      setStep("totp");
      setLoading(false);
      setStatus(null);
    } else if (loginState === "pendingDualPassword") {
      setStep("mailbox");
      setLoading(false);
      setStatus(null);
    } else if (loginState === "pendingHv" && hvToken && authHvMethods) {
      setHvMethods(authHvMethods);
      setStep("captcha");
      setLoading(false);
      setStatus(null);
      openCaptchaWindow(hvToken, authHvMethods);
    } else if (loginState === "error" && authError) {
      setError(authError.message);
      setLoading(false);
      setStatus(null);
    } else if (loginState === "loggedIn") {
      onLoginSuccess();
    }
  }, [loginState, authError]);

  // Submit captcha solution back to auth hook
  useEffect(() => {
    if (solvedCaptchaToken) {
      retryWithCaptcha(solvedCaptchaToken);
    }
  }, [solvedCaptchaToken]);

  const handleCredentials = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    startLogin(username, password);
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await submitTotp(totp);
    } catch (err: unknown) {
      setError(String(err));
      setLoading(false);
    }
  };

  const handleMailboxPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await submitMailboxPassword(mailboxPassword);
    } catch (err: unknown) {
      setError(String(err));
      setLoading(false);
    }
  };

  const handleCaptchaBack = () => {
    closeCaptchaWindow();
    setStep("credentials");
    setError(null);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.4rem",
            marginBottom: "-0.5rem",
          }}
        >
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? t.lightMode : t.darkMode}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="icon-btn" onClick={toggleLang}>
            {t.langToggle}
          </button>
        </div>

        <h1 className="login-title">{t.appName}</h1>

        <p className="disclaimer-banner">{t.unofficialBanner}</p>

        {step === "credentials" && (
          <form onSubmit={handleCredentials} className="login-form">
            <div className="field">
              <label htmlFor="username">{t.username}</label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="bruker@proton.me"
                required
                disabled={loading}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t.password}</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
              />
            </div>
            {status && <p className="hint">{status}</p>}
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? (status ?? t.loggingIn) : t.loginBtn}
            </button>
          </form>
        )}

        {step === "captcha" && (
          <div className="captcha-wrap">
            <p className="hint">{t.captchaHint}</p>
            <p className="hint">
              {t.captchaMethods}{" "}
              <code>{hvMethods.join(", ") || "unknown"}</code>
            </p>
            {loading && <p className="hint">{status}</p>}
            {error && <p className="login-error">{error}</p>}
            <button
              type="button"
              className="back-btn"
              onClick={handleCaptchaBack}
            >
              {t.back}
            </button>
          </div>
        )}

        {step === "totp" && (
          <form onSubmit={handleTotp} className="login-form">
            <div className="field">
              <label htmlFor="totp">{t.totp}</label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="123456"
                maxLength={6}
                required
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                className="back-btn"
                onClick={() => {
                  setStep("credentials");
                  setTotp("");
                  setError(null);
                }}
              >
                {t.back}
              </button>
            </div>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? t.loggingIn : t.confirmBtn}
            </button>
          </form>
        )}

        {step === "mailbox" && (
          <form onSubmit={handleMailboxPassword} className="login-form">
            <p className="hint">{t.mailboxHint}</p>
            <div className="field">
              <label htmlFor="mailbox-password">{t.mailboxPassword}</label>
              <input
                id="mailbox-password"
                type="password"
                autoComplete="current-password"
                value={mailboxPassword}
                onChange={(e) => setMailboxPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                className="back-btn"
                onClick={() => {
                  setStep("credentials");
                  setMailboxPassword("");
                  setError(null);
                }}
              >
                {t.back}
              </button>
            </div>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? t.unlocking : t.unlockBtn}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

Changes from original:
- Removed `partial` state, `Partial2FA` import, and all commented-out code
- Removed broken `async useEffect` with undefined `err`, `handleCaptchaBack`, `initSdk`
- Added `handleCredentials`, `handleTotp`, `handleMailboxPassword`, `handleCaptchaBack` — all via hook
- Added two `useEffect`s: one for state routing, one for captcha token
- TOTP and mailbox back buttons no longer reference `setPartial(null)`

- [ ] **Step 17: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors in `LoginForm.tsx`. Fix any that appear.

- [ ] **Step 18: Commit**

```bash
git add src/components/LoginForm.tsx
git commit -m "fix(login): rewrite LoginForm to use useAuth hook; remove direct API calls"
```

---

## Task 7: Fix `UnlockForm.tsx`

**Files:**
- Modify: `src/components/UnlockForm.tsx`

- [ ] **Step 19: Fix accessToken reference**

In `src/components/UnlockForm.tsx`, change line 16:

```typescript
// Before:
const { accessToken, logout, unlock, error: authError } = useAuth();

// After:
const { tokens, logout, unlock, error: authError } = useAuth();
```

And change line 24:

```typescript
// Before:
if (!accessToken)
  throw new Error("No stored session — please log in again");

// After:
if (!tokens?.accessToken)
  throw new Error("No stored session — please log in again");
```

- [ ] **Step 20: Type-check + full test suite**

```bash
pnpm tsc --noEmit && pnpm test
```

Expected: no type errors; all tests pass.

- [ ] **Step 21: Commit**

```bash
git add src/components/UnlockForm.tsx
git commit -m "fix(unlock): use tokens?.accessToken instead of nonexistent accessToken prop"
```

---

## Task 8: Final check

- [ ] **Step 22: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass (existing suite + new useAuth tests). Fix any regressions.

- [ ] **Step 23: Run Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust tests pass (no Rust changes were made).
