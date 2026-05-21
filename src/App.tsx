import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoginForm } from "./components/LoginForm";
import { initDriveClient, deriveKeyPassword, releaseDriveClient } from "./lib/drive";
import { startSync, setSyncStatusCallback } from "./lib/sync";
import type { SyncStatus } from "./lib/sync";
import "./App.css";

interface AuthStatus {
  loggedIn: boolean;
  userId: string | null;
}

interface SessionTokens {
  uid: string;
  accessToken: string;
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

function UnlockForm({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await invoke<SessionTokens | null>("get_session_tokens");
      if (!tokens) throw new Error("Ingen lagret sesjon — logg inn på nytt");
      const keyPassword = await deriveKeyPassword(password, tokens.accessToken, tokens.uid);
      await initDriveClient({ uid: tokens.uid, accessToken: tokens.accessToken, keyPassword });
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
        <h1 className="login-title">Proton Drive Sync</h1>
        <p className="disclaimer-banner">
          Skriv inn passordet ditt for å låse opp Drive-tilgang.
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field">
            <label htmlFor="unlock-password">Passord</label>
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
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? "Låser opp…" : "Lås opp"}
          </button>
          <button type="button" className="back-btn" onClick={handleLogout}>
            Bytt konto
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

function MainView() {
  const [syncPath, setSyncPath] = useState<string>("");
  const [localEvents, setLocalEvents] = useState<LocalEvent[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ active: [], errors: [] });
  const [fileStates, setFileStates] = useState<FileState[]>([]);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const stopSyncRef = useRef<(() => void) | null>(null);

  // Load autostart state once.
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

  // Resolve sync path, start engine, register status callback, set up listeners.
  useEffect(() => {
    let cancelled = false;
    let unlistenLocal: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    async function init() {
      const path = await invoke<string>("get_sync_path");
      if (cancelled) return;
      setSyncPath(path);

      // Register status callback before starting sync.
      setSyncStatusCallback((s) => {
        if (!cancelled) setSyncStatus({ ...s });
      });

      // Start sync engine.
      const stop = await startSync(path);
      if (cancelled) { stop(); return; }
      stopSyncRef.current = stop;

      // Inotify event log (purely for display — actual handling is in sync.ts).
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

      // Poll DB file list every 3 s.
      pollInterval = setInterval(async () => {
        if (cancelled) return;
        try {
          const files = await invoke<FileState[]>("get_all_file_states");
          if (!cancelled) setFileStates(files);
        } catch {
          /* ignore */
        }
      }, 3_000);
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
      unlistenLocal?.();
      if (pollInterval !== null) clearInterval(pollInterval);
      stopSyncRef.current?.();
      stopSyncRef.current = null;
    };
  }, []);

  const handleLogout = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    window.location.reload();
  };

  return (
    <main className="container">
      <div className="topbar">
        <h1>Proton Drive Sync</h1>
        <button className="logout-btn" onClick={handleLogout}>Logg ut</button>
      </div>

      {/* Sync status */}
      <div className="status-card">
        <div className="status-row">
          <span className={`status-dot ${syncStatus.active.length > 0 ? "running" : ""}`} />
          <span>
            {syncStatus.active.length > 0
              ? `Synkroniserer ${syncStatus.active.length} element(er)…`
              : "Kjører — sync-motor aktiv"}
          </span>
        </div>
        <div className="sync-path">
          Mappe: <code>{syncPath || "laster…"}</code>
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
            <strong style={{ color: "#ef4444", fontSize: "0.82rem" }}>Feil:</strong>
            <ul style={{ margin: "0.2rem 0 0", padding: "0 0 0 1.2rem", fontSize: "0.8rem", color: "#ef4444" }}>
              {syncStatus.errors.slice(-5).map((e, i) => (
                <li key={i}>{e.path}: {e.error}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* DB file list */}
      <div className="events-card">
        <h2>Synkroniserte filer</h2>
        {fileStates.length === 0 ? (
          <p className="no-events">Ingen filer registrert i databasen ennå.</p>
        ) : (
          <ul className="event-list">
            {fileStates.map((f) => {
              const badge = syncStateBadge(f.syncState);
              return (
                <li key={f.remoteId} className="event-item" style={{ gap: "0.5rem" }}>
                  <span
                    style={{
                      padding: "1px 7px",
                      borderRadius: "9999px",
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      background: badge.color + "30",
                      color: badge.color,
                      border: `1px solid ${badge.color}60`,
                      whiteSpace: "nowrap",
                    }}
                  >
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

      {/* Settings */}
      <div className="events-card">
        <h2>Innstillinger</h2>
        <div className="setting-row">
          <div>
            <div className="setting-label">Start ved innlogging</div>
            <div className="setting-hint">Start Proton Drive Sync automatisk når du logger inn på GNOME.</div>
          </div>
          <button
            className={`toggle-btn ${autostartEnabled ? "on" : ""}`}
            onClick={handleAutostartToggle}
            disabled={autostartLoading}
            aria-pressed={autostartEnabled}
          >
            {autostartEnabled ? "På" : "Av"}
          </button>
        </div>
      </div>

      {/* Inotify event log */}
      <div className="events-card">
        <h2>Lokale filendringer (inotify)</h2>
        {localEvents.length === 0 ? (
          <p className="no-events">Ingen endringer oppdaget ennå.</p>
        ) : (
          <ul className="event-list">
            {localEvents.map((e, i) => (
              <li key={i} className="event-item">
                <span className="event-time">{e.time}</span>
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: "4px",
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    background:
                      e.kind === "create"
                        ? "#22c55e30"
                        : e.kind === "delete"
                        ? "#ef444430"
                        : "#eab30830",
                    color:
                      e.kind === "create"
                        ? "#22c55e"
                        : e.kind === "delete"
                        ? "#ef4444"
                        : "#eab308",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.kind}
                </span>
                <span className="event-path">{e.absPath}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="disclaimer">
        Uoffisiell tredjepartsapp — ikke støttet av Proton.
      </p>
    </main>
  );
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading");

  useEffect(() => {
    invoke<AuthStatus>("get_auth_status").then((status) => {
      if (!status.loggedIn) {
        setAppState("loggedOut");
      } else {
        // Session restored from keyring — need user password to derive key password
        setAppState("unlocking");
      }
    });
  }, []);

  if (appState === "loading") return <div className="loading">Laster…</div>;
  if (appState === "loggedOut") {
    return (
      <LoginForm
        onLoginSuccess={() => setAppState("ready")}
      />
    );
  }
  if (appState === "unlocking") {
    return <UnlockForm onUnlocked={() => setAppState("ready")} />;
  }

  return <MainView />;
}
