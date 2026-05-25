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
