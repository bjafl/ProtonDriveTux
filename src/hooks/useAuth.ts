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
  hvMethods: string[];
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
  const loginStateRef = useRef<LoginState | null>("loading"); //For special cases, else state is derived.
  const hvDataRef = useRef<HvData | null>(null);
  const credentialsRef = useRef<Credentials | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const [authInfo, setAuthInfo] = useState<AuthInfo>({
    loggedIn: false,
    userId: null,
    state: "loading",
  });

  function _deriveAuthInfo(): AuthInfo {
    const tokens = tokensRef.current ? { ...tokensRef.current } : undefined;
    const error = errorRef.current ? { ...errorRef.current } : undefined;
    const keyPassword = keyPasswordRef.current ?? undefined;

    let state: LoginState;
    if (loginStateRef.current !== null) {
      state = loginStateRef.current;
    } else if (error != null) {
      state = "error";
    } else if (tokens?.accessToken) {
      state = "loggedIn";
    } else if (refreshPromiseRef.current !== null) {
      state = "refreshing";
    } else {
      state = "loggedOut";
    }

    const hvData = state === "pendingHv" ? { ...hvDataRef.current } : null;

    return {
      loggedIn: state === "loggedIn",
      userId: tokens?.userId ?? null,
      tokens,
      keyPassword,
      state,
      error,
      ...hvData,
    };
  }

  function _updateAuthInfoState() {
    setAuthInfo(_deriveAuthInfo());
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
    if (!tokensRef.current)
      throw new NoTokensError("Tokens missing - cant't refresh");
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

  const _deriveKeyPassword = useCallback(
    async (password: string, remember = false): Promise<boolean> => {
      console.log("[deriveKeyPwd]", {
        tokens: { ...tokensRef.current },
        passwordLen: password.length,
        remember,
      });
      if (!tokensRef.current)
        throw new NoTokensError("Tokens missing - can't derive keypassword");
      try {
        const { uid, accessToken, ...tokensRest } = tokensRef.current;
        const newKeyPwd = await deriveKeyPassword(password, accessToken, uid);
        await initDriveClient({
          keyPassword: newKeyPwd,
          uid,
          accessToken,
          ...tokensRest,
        });
        if (remember) {
          await storeKeyPassword(newKeyPwd).catch(console.error);
        }
        keyPasswordRef.current = newKeyPwd;
        return true;
      } catch (error: unknown) {
        if (error instanceof AuthExpiredError) {
          console.log("[derive keypwd] auth expired");
          await _refreshTokens();
          return _deriveKeyPassword(password, remember);
        }
        _updateError({ type: "loginError", error });
        return false;
      }
    },
    [_refreshTokens],
  );

  const refresh = useCallback(
    async ({
      refreshTokens = false,
      keyPassword = false,
    }: {
      refreshTokens?: boolean;
      keyPassword?: boolean;
    } = {}): Promise<void> => {
      if (refreshPromiseRef.current) {
        return refreshPromiseRef.current;
      }
      refreshPromiseRef.current = _doRefresh(refreshTokens, keyPassword);
      _updateAuthInfoState();
      await refreshPromiseRef.current;
      refreshPromiseRef.current = null;
      loginStateRef.current = null;
      _updateAuthInfoState();
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
      _updateAuthInfoState();
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
          _updateAuthInfoState();
          return;
        }
        if (result.dualPasswordMode) {
          loginStateRef.current = "pendingDualPassword";
          _updateAuthInfoState();
          return;
        }
        loginStateRef.current = "pendingSrp";
        _updateAuthInfoState();
        await _deriveKeyPassword(password, remember);
        loginStateRef.current = null;
        _updateAuthInfoState();
      } catch (error: unknown) {
        if (error instanceof HumanVerificationError) {
          hvDataRef.current = {
            hvToken: error.hvToken,
            hvMethods: error.methods,
          };
          loginStateRef.current = "pendingHv";
          _updateAuthInfoState();
          return;
        }
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        _updateAuthInfoState();
      }
    },
    [],
  );

  const submitTotp = useCallback(async (totp: string): Promise<void> => {
    console.log("[submitTotp]", { tokens: { ...tokensRef.current } });
    if (!tokensRef.current)
      throw new NoTokensError("Tokens missing - cant submit totp");
    const { uid, accessToken, refreshToken, userId } = tokensRef.current;
    try {
      await apiSubmitTotp(uid, accessToken, refreshToken, userId, totp);
      loginStateRef.current = "pendingSrp";
      _updateAuthInfoState();
      console.log("[submitTotp - after totp ok]", {
        tokens: { ...tokensRef.current },
      });
      const creds = credentialsRef.current;
      await _deriveKeyPassword(creds?.password ?? "", creds?.remember ?? false);
      loginStateRef.current = null;
      credentialsRef.current = null;
      _updateAuthInfoState();
    } catch (error: unknown) {
      _updateError({ type: "loginError", error });
      loginStateRef.current = null;
      _updateAuthInfoState();
    }
  }, []);

  const submitMailboxPassword = useCallback(
    async (password: string): Promise<void> => {
      if (!tokensRef.current)
        throw new NoTokensError("Tokens missing - can't submit mailbox pwd");
      try {
        loginStateRef.current = "pendingSrp";
        _updateAuthInfoState();
        await _deriveKeyPassword(
          password,
          credentialsRef.current?.remember ?? false,
        );
        loginStateRef.current = null;
        credentialsRef.current = null;
        _updateAuthInfoState();
      } catch (error: unknown) {
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        _updateAuthInfoState();
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
      _updateAuthInfoState();
      try {
        const result = await startLoginWithCaptcha(
          username,
          password,
          captchaToken,
        );
        tokensRef.current = {
          uid: result.uid,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
        };
        if (result.twoFactorRequired) {
          loginStateRef.current = "pendingTotp";
          _updateAuthInfoState();
          return;
        }
        if (result.dualPasswordMode) {
          loginStateRef.current = "pendingDualPassword";
          _updateAuthInfoState();
          return;
        }
        loginStateRef.current = "pendingSrp";
        _updateAuthInfoState();
        await _deriveKeyPassword(password, remember);
        loginStateRef.current = null;
        credentialsRef.current = null;
        _updateAuthInfoState();
      } catch (error: unknown) {
        if (error instanceof HumanVerificationError) {
          hvDataRef.current = {
            hvToken: error.hvToken,
            hvMethods: error.methods,
          };
          loginStateRef.current = "pendingHv";
          _updateAuthInfoState();
          return;
        }
        _updateError({ type: "loginError", error });
        loginStateRef.current = null;
        _updateAuthInfoState();
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
      _updateAuthInfoState();
      return true;
    } catch (error) {
      _updateError({ error });
      _updateAuthInfoState();
    } finally {
      releaseDriveClient();
    }
    return false;
  }, []);

  useEffect(() => {
    if (authInfo.state === "loading") {
      refresh();
    }
  }, [authInfo.state]);

  useEffect(() => {
    if (!authInfo.error) console.log("error cleared");
    console.log(authInfo.error);
  }, [authInfo.error]);
  useEffect(() => {
    if (!authInfo.state) console.log("state cleared");
    console.log(authInfo.state);
  }, [authInfo.state]);

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
