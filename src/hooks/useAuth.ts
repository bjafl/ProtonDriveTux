import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthErrorType,
  AuthInfo,
  type AuthErrorInfo,
  type AuthStatus,
  type LoginState,
  type SessionTokens,
} from "../types/auth";
import {
  refreshTokens as apiRefreshTokens,
  releaseDriveClient,
  deriveKeyPassword,
  initDriveClient,
} from "../lib/drive";
import { AuthExpiredError, LoginResult } from "../lib/auth";
import {
  logout as ipcLogout,
  getKeyPassword,
  storeKeyPassword,
  getAuthStatus,
  getSessionTokens,
} from "../lib/ipcApi";
import { ErrorLevel } from "../types/logging";
import { startLogin as apiStartLogin, submitTotp } from "../lib/auth";

class NoTokensError extends Error {}
// class LoadingError extends Error {}

export function useAuth() {
  const [authInfo, setAuthInfo] = useState<AuthInfo>({
    loggedIn: false,
    userId: null,
    state: "loading",
  });
  const tokensRef = useRef<SessionTokens | null>(null);
  const errorRef = useRef<AuthErrorInfo | null>(null);
  const keyPasswordRef = useRef<string | null>(null);
  const loginStateRef = useRef<LoginState | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const loginPromiseRef = useRef<Promise<LoginResult> | null>(null);
  // const statusRef = useRef<AuthStatus | null>(null);
  // const [tokens, setTokens] = useState<SessionTokens | null>(null);
  // const [error, setError] = useState<AuthErrorInfo | null>(null);
  // const [loading, setLoading] = useState(true);
  // const [state, setState] = useState<LoginState>("loading");
  // const [status, setStatus] = useState<AuthStatus | null>(null);
  // const [keyPassword, setKeyPassword] = useState<string | null>(null);

  const [stateVer, setStateVer] = useState(0);
  function _refreshState() {
    setStateVer((prev) => prev + 1);
  }
  useCallback(() => {
    const tokens = tokensRef.current ?? undefined;
    const error = errorRef.current ?? undefined;
    const keyPassword = keyPasswordRef.current ?? undefined;
    let state: LoginState = "loggedOut";
    if (loginStateRef.current) {
      state = loginStateRef.current;
    } else {
      if (tokens && tokens.accessToken) {
        state = "loggedIn";
      } else if (error != null) {
        state = "error";
      } else if (refreshPromiseRef.current !== null) {
        state = "refreshing";
      } else if (loginPromiseRef.current !== null) {
        state = "loginStarted";
      }
    }
    setAuthInfo({
      loggedIn: state === "loggedIn",
      userId: tokens?.userId ?? null,
      tokens,
      keyPassword,
      state,
      error,
    });
  }, [stateVer]);

  function _updateError({
    level = "error",
    type = "unknown",
    message,
    error,
  }: {
    level?: ErrorLevel;
    type?: AuthErrorType;
    message?: string;
    error?: unknown;
  }) {
    const info: AuthErrorInfo = {
      level,
      type,
      message: message ? message : error ? String(error) : "",
      error: error instanceof Error ? error : undefined,
    };
    errorRef.current = info;
  }

  const startLogin = useCallback(
    async (
      username: string,
      password: string,
      remember = false,
    ): Promise<void> => {
      if (loginPromiseRef.current) {
        await loginPromiseRef.current; //TODO
        return;
      }
      loginPromiseRef.current = apiStartLogin(username, password);
      loginStateRef.current = "loginStarted";
      _refreshState();
      const { twoFactorRequired, dualPasswordMode, ...tokens } =
        await loginPromiseRef.current;
      loginPromiseRef.current = null;
      tokensRef.current = tokens;
      if (twoFactorRequired) {
        loginStateRef.current = "pendingTotp";
        _refreshState();
        return;
      }
      if (dualPasswordMode) {
        loginStateRef.current = "pendingDualPassword";
        _refreshState();
        return;
      }
      loginStateRef.current = "pendingSrp";
      _refreshState();
      await _deriveKeyPassword(password, remember);
      loginStateRef.current = null;
    },
    [],
  );

  async function _deriveKeyPassword(password: string, remember = false) {
    const tokens = tokensRef.current;
    if (!tokens) throw new NoTokensError();
    try {
      const newKeyPwd = await deriveKeyPassword(
        password,
        tokens.uid,
        tokens.accessToken,
      );
      await initDriveClient({
        ...tokens,
        keyPassword: newKeyPwd,
      });
      if (remember) {
        await storeKeyPassword(newKeyPwd).catch(console.error);
      }
      keyPasswordRef.current = newKeyPwd;
      return true;
    } catch (error: unknown) {
      if (error instanceof AuthExpiredError) {
        // setError({
        //   level: "error",
        //   type: "expired",
        //   message: err.message,
        // });
        await _refreshTokens();
        return _deriveKeyPassword(password, remember);
      } else {
        _updateError({
          type: "loginError",
          error,
        });
      }
    }
    return false;
  }

  async function _getKeyPassword() {
    try {
      const newKeyPwd = await getKeyPassword();
      keyPasswordRef.current = newKeyPwd;
    } catch (error) {
      _updateError({
        type: "expired",
        error,
      });
    }
  }

  async function _doRefresh(refreshTokens = false, keyPassword = false) {
    if (keyPassword || keyPasswordRef.current == null) {
      await _getKeyPassword();
    }
    await Promise.all([getAuthStatus(), getSessionTokens()]);
    if (refreshTokens) {
      await _refreshTokens();
    }
  }

  const refresh = useCallback(
    async ({ refreshTokens = false, keyPassword = false } = {}) => {
      if (refreshPromiseRef.current) {
        return await refreshPromiseRef.current;
      }
      refreshPromiseRef.current = _doRefresh(refreshTokens, keyPassword);
      _refreshState();
      await refreshPromiseRef.current;
      _refreshState();
    },
    [],
  );

  const _refreshTokens = useCallback(async () => {
    if (!tokensRef.current) throw new NoTokensError();
    try {
      const refreshed = await apiRefreshTokens(
        tokensRef.current.uid,
        tokensRef.current.refreshToken,
        tokensRef.current.userId,
      );
      const newTokens: SessionTokens = { ...tokensRef.current, ...refreshed };
      tokensRef.current = newTokens;
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        // Refresh token rejected — session is dead, must re-login.
        _updateError({
          type: "expired",
          error,
        });
        return logout();
      }
      _updateError({
        level: "warn",
        type: "refreshFailed",
        error,
      });
    }
  }, []);

  const unlock = useCallback(
    async (password: string, rememberPass: boolean = false) => {
      await _refreshTokens();
      return _deriveKeyPassword(password, rememberPass);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await ipcLogout();
      return true;
    } catch (error) {
      _updateError({
        error,
      });
    } finally {
      releaseDriveClient();
    }
    return false;
  }, []);

  // Initial token fetch
  useEffect(() => {
    refresh();
  }, []);

  return {
    ...authInfo,
    logout,
    startLogin,
    unlock,
    refresh,
  };
}
