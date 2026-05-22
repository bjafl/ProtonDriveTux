import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoginForm } from "./components/LoginForm";
import { initDriveClient, deriveKeyPassword, refreshTokens, releaseDriveClient, setSessionExpiredCallback } from "./lib/drive";
import { startSync, setSyncStatusCallback } from "./lib/sync";
import { defaultSyncPath } from "./lib/paths";
import type { SyncStatus } from "./lib/sync";
import { useLang } from "./lib/i18n";
import { useTheme } from "./lib/theme";
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

interface WatchEvent {
  absPath: string;
  kind: "create" | "modify" | "delete";
}

interface LocalEvent {
  absPath: string;
  kind: string;
  time: string;
}

interface FileState {
  remoteId: string;
  localPath: string;
  etag: string | null;
  modifiedAt: number | null;
  sizeBytes: number | null;
  syncState: string;
}

type AppState = "loading" | "unlocking" | "loggedOut" | "ready";

function isAuthFailure(err: unknown): boolean {
  return /failed: [4]\d\d/.test(String(err));
}

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
      if (!tokens) throw new Error("Ingen lagret sesjon — logg inn på nytt");

      // The stored access token may be expired — proactively refresh before
      // calling deriveKeyPassword (which hits /core/v4/keys/salts and fails
      // with 403 on an expired token).
      let { accessToken, refreshToken } = tokens;
      try {
        const refreshed = await refreshTokens(tokens.uid, tokens.refreshToken, tokens.userId);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
      } catch (refreshErr) {
        if (isAuthFailure(refreshErr)) {
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

function syncStateBadge(state: string): { label: string; color: string } {
  switch (state) {
    case "synced":
      return { label: "synced", color: "#22c55e" };
    case "pending_upload":
    case "pending_download":
      return { label: state.replace("pending_", ""), color: "#eab308" };
    case "conflict":
      return { label: "conflict", color: "#f97316" };
    case "error":
      return { label: "error", color: "#ef4444" };
    case "deleted":
      return { label: "deleted", color: "#94a3b8" };
    default:
      return { label: state, color: "#94a3b8" };
  }
}

function MainView({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [syncPath, setSyncPath] = useState<string>("");
  const [localEvents, setLocalEvents] = useState<LocalEvent[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ active: [], errors: [] });
  const [fileStates, setFileStates] = useState<FileState[]>([]);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const stopSyncRef = useRef<(() => void) | null>(null);
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    invoke<boolean>("get_autostart_enabled").then(setAutostartEnabled).catch(console.error);
  }, []);

  const handleAutostartToggle = async () => {
    setAutostartLoading(true);
    try {
      if (autostartEnabled) {
        await invoke("disable_autostart");
        setAutostartEnabled(false);
      } else {
        await invoke("enable_autostart");
        setAutostartEnabled(true);
      }
    } catch (err) {
      console.error("Autostart toggle failed:", err);
    } finally {
      setAutostartLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unlistenLocal: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    // Wire up session-expired callback so a dead refresh token triggers re-login.
    setSessionExpiredCallback(onSessionExpired);

    async function init() {
      const localRoot = await invoke<string | null>("get_local_root");
      if (cancelled) return;

      // No root configured yet — onboarding will set one.
      if (!localRoot) {
        setSyncPath(await defaultSyncPath());
        return;
      }
      setSyncPath(localRoot);

      setSyncStatusCallback((s) => {
        if (!cancelled) setSyncStatus({ ...s });
      });

      await invoke("start_file_watcher", { path: localRoot }).catch(console.error);
      const stop = await startSync();
      if (cancelled) { stop(); return; }
      stopSyncRef.current = stop;

      unlistenLocal = await listen<WatchEvent>("sync://local-change", (e) => {
        if (cancelled) return;
        setLocalEvents((prev) =>
          [
            {
              absPath: e.payload.absPath,
              kind: e.payload.kind,
              time: new Date().toLocaleTimeString(),
            },
            ...prev,
          ].slice(0, 30),
        );
      });

      pollInterval = setInterval(async () => {
        if (cancelled) return;
        try {
          const files = await invoke<FileState[]>("get_all_file_states");
          if (!cancelled) setFileStates(files);
        } catch { /* ignore */ }
      }, 3_000);
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
      setSessionExpiredCallback(null);
      unlistenLocal?.();
      if (pollInterval !== null) clearInterval(pollInterval);
      stopSyncRef.current?.();
      stopSyncRef.current = null;
    };
  }, [onSessionExpired]);

  const handleLogout = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    window.location.reload();
  };

  return (
    <main className="container">
      <div className="topbar">
        <h1>{t.appName}</h1>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <button className="icon-btn" onClick={toggleTheme} title={theme === "dark" ? t.lightMode : t.darkMode}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="icon-btn" onClick={toggleLang}>{t.langToggle}</button>
          <button className="logout-btn" onClick={handleLogout}>{t.logout}</button>
        </div>
      </div>

      <div className="status-card">
        <div className="status-row">
          <span className={`status-dot ${syncStatus.active.length > 0 ? "running" : ""}`} />
          <span>
            {syncStatus.active.length > 0
              ? t.syncingItems(syncStatus.active.length)
              : t.syncIdle}
          </span>
        </div>
        <div className="sync-path">
          {t.localFolder} <code>{syncPath || t.loading}</code>
        </div>
        <div className="sync-path">
          {t.driveFolder} <code>My files</code>
        </div>
        {syncStatus.active.length > 0 && (
          <ul style={{ margin: "0.4rem 0 0", padding: "0 0 0 1.2rem", fontSize: "0.82rem" }}>
            {syncStatus.active.map((a, i) => (
              <li key={i} style={{ opacity: 0.8 }}>{a}</li>
            ))}
          </ul>
        )}
        {syncStatus.errors.length > 0 && (
          <div style={{ marginTop: "0.5rem" }}>
            <strong style={{ color: "#ef4444", fontSize: "0.82rem" }}>{t.errors}</strong>
            <ul style={{ margin: "0.2rem 0 0", padding: "0 0 0 1.2rem", fontSize: "0.8rem", color: "#ef4444" }}>
              {syncStatus.errors.slice(-5).map((e, i) => (
                <li key={i}>{e.path}: {e.error}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="events-card">
        <h2>{t.syncedFiles}</h2>
        {fileStates.length === 0 ? (
          <p className="no-events">{t.noFiles}</p>
        ) : (
          <ul className="event-list">
            {fileStates.map((f) => {
              const badge = syncStateBadge(f.syncState);
              return (
                <li key={f.remoteId} className="event-item" style={{ gap: "0.5rem" }}>
                  <span style={{ padding: "1px 7px", borderRadius: "9999px", fontSize: "0.72rem", fontWeight: 600, background: badge.color + "30", color: badge.color, border: `1px solid ${badge.color}60`, whiteSpace: "nowrap" }}>
                    {badge.label}
                  </span>
                  <span className="event-path" style={{ flex: 1 }}>
                    {f.localPath.split("/").pop()}
                  </span>
                  {f.sizeBytes != null && (
                    <span style={{ opacity: 0.5, fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                      {(f.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="events-card">
        <h2>{t.settings}</h2>
        <div className="setting-row" style={{ marginBottom: "0.75rem" }}>
          <div>
            <div className="setting-label">{t.autostart}</div>
            <div className="setting-hint">{t.autostartHint}</div>
          </div>
          <button
            className={`toggle-btn ${autostartEnabled ? "on" : ""}`}
            onClick={handleAutostartToggle}
            disabled={autostartLoading}
            aria-pressed={autostartEnabled}
          >
            {autostartEnabled ? t.on : t.off}
          </button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">{theme === "dark" ? t.darkMode : t.lightMode}</div>
          </div>
          <button className={`toggle-btn ${theme === "dark" ? "on" : ""}`} onClick={toggleTheme}>
            {theme === "dark" ? t.on : t.off}
          </button>
        </div>
      </div>

      <div className="events-card">
        <h2>{t.localChanges}</h2>
        {localEvents.length === 0 ? (
          <p className="no-events">{t.noChanges}</p>
        ) : (
          <ul className="event-list">
            {localEvents.map((e, i) => (
              <li key={i} className="event-item">
                <span className="event-time">{e.time}</span>
                <span style={{ padding: "1px 6px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: 600, background: e.kind === "create" ? "#22c55e30" : e.kind === "delete" ? "#ef444430" : "#eab30830", color: e.kind === "create" ? "#22c55e" : e.kind === "delete" ? "#ef4444" : "#eab308", whiteSpace: "nowrap" }}>
                  {e.kind}
                </span>
                <span className="event-path">{e.absPath}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="disclaimer">{t.disclaimer}</p>
    </main>
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
            if (isAuthFailure(refreshErr)) {
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
          setAppState("ready");
          return;
        }
      } catch (err) {
        console.warn("[App] Auto-unlock failed, falling back to unlock form:", err);
      }
      setAppState("unlocking");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (appState === "loading") return <div className="loading">{t.loading}</div>;
  if (appState === "loggedOut") {
    return <LoginForm onLoginSuccess={() => setAppState("ready")} />;
  }
  if (appState === "unlocking") {
    return (
      <UnlockForm
        onUnlocked={() => setAppState("ready")}
        onSessionExpired={handleSessionExpired}
      />
    );
  }

  return <MainView onSessionExpired={handleSessionExpired} />;
}
