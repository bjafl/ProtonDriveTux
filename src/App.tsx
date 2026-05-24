import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoginForm } from "./components/LoginForm";
import { Onboarding, isOnboardingNeeded } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { initDriveClient, deriveKeyPassword, refreshTokens, releaseDriveClient } from "./lib/drive";
import { AuthExpiredError } from "./lib/auth";
import { useLang } from "./lib/i18n";
import "./App.css";

interface AuthStatus {
  loggedIn: boolean;
  userId: string | null;
}

interface SessionTokens {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

type AppState ="loading" | "unlocking" | "loggedOut" | "onboarding" | "ready";


function UnlockForm({ onUnlocked, onSessionExpired }: { onUnlocked: () => void; onSessionExpired: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);
  const { t } = useLang();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await invoke<SessionTokens | null>("get_session_tokens");
      if (!tokens) throw new Error("No stored session — please log in again");

      // The stored access token may be expired — proactively refresh before
      // calling deriveKeyPassword (which hits /core/v4/keys/salts and fails
      // with 403 on an expired token).
      let { accessToken, refreshToken } = tokens;
      try {
        const refreshed = await refreshTokens(tokens.uid, tokens.refreshToken, tokens.userId);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
      } catch (refreshErr) {
        if (refreshErr instanceof AuthExpiredError) {
          // Refresh token rejected — session is dead, must re-login.
          await invoke("logout").catch(console.error);
          releaseDriveClient();
          onSessionExpired();
          return;
        }
        console.warn("[unlock] Token refresh failed, proceeding with stored token:", refreshErr);
      }

      const keyPassword = await deriveKeyPassword(password, accessToken, tokens.uid);
      await initDriveClient({
        uid: tokens.uid,
        accessToken,
        refreshToken,
        userId: tokens.userId,
        keyPassword,
      });
      if (remember) {
        await invoke("store_key_password", { keyPassword }).catch(console.error);
      }
      onUnlocked();
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        onSessionExpired();
        return;
      }
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    window.location.reload();
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="login-title">{t.appName}</h1>
        <p className="disclaimer-banner">{t.unlockHint}</p>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field">
            <label htmlFor="unlock-password">{t.password}</label>
            <input
              id="unlock-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={loading}
              autoFocus
            />
          </div>
          <label className="field-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t.rememberUnlock}
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? t.unlocking : t.unlockBtn}
          </button>
          <button type="button" className="back-btn" onClick={handleLogout}>
            {t.switchAccount}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const { t } = useLang();

  const handleSessionExpired = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    setAppState("loggedOut");
  };

  useEffect(() => {
    invoke<AuthStatus>("get_auth_status").then(async (status) => {
      if (!status.loggedIn) {
        setAppState("loggedOut");
        return;
      }
      // Try to auto-unlock with stored key password.
      try {
        const [keyPassword, tokens] = await Promise.all([
          invoke<string | null>("get_key_password"),
          invoke<SessionTokens | null>("get_session_tokens"),
        ]);
        if (keyPassword && tokens) {
          let { accessToken, refreshToken } = tokens;
          try {
            const refreshed = await refreshTokens(tokens.uid, tokens.refreshToken, tokens.userId);
            accessToken = refreshed.accessToken;
            refreshToken = refreshed.refreshToken;
          } catch (refreshErr) {
            if (refreshErr instanceof AuthExpiredError) {
              await handleSessionExpired();
              return;
            }
            // Transient error — proceed with stored token.
          }
          await initDriveClient({
            uid: tokens.uid,
            accessToken,
            refreshToken,
            userId: tokens.userId,
            keyPassword,
          });
          setAppState((await isOnboardingNeeded()) ? "onboarding" : "ready");
          return;
        }
      } catch (err) {
        console.warn("[App] Auto-unlock failed, falling back to unlock form:", err);
      }
      setAppState("unlocking");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (appState === "loading") return <div className="loading">{t.loading}</div>;
  const goToNextState = async () => {
    setAppState((await isOnboardingNeeded()) ? "onboarding" : "ready");
  };

  if (appState === "loggedOut") {
    return <LoginForm onLoginSuccess={goToNextState} />;
  }
  if (appState === "onboarding") {
    return <Onboarding onComplete={() => setAppState("ready")} />;
  }
  if (appState === "unlocking") {
    return (
      <UnlockForm
        onUnlocked={goToNextState}
        onSessionExpired={handleSessionExpired}
      />
    );
  }

  return (
    <Dashboard
      onSessionExpired={handleSessionExpired}
      onOpenOnboarding={() => setAppState("onboarding")}
    />
  );
}
