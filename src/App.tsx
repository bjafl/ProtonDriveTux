import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoginForm } from "./components/LoginForm";
import { initDriveClient, deriveKeyPassword, releaseDriveClient } from "./lib/drive";
import { SmokeTest } from "./components/SmokeTest";
import "./App.css";

interface AuthStatus {
  loggedIn: boolean;
  userId: string | null;
}

interface SessionTokens {
  uid: string;
  accessToken: string;
}

interface SyncEvent {
  path: string;
  time: string;
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

function MainView() {
  const [syncPath, setSyncPath] = useState<string>("");
  const [events, setEvents] = useState<SyncEvent[]>([]);

  useEffect(() => {
    invoke<string>("get_sync_path").then(setSyncPath);

    let unlistenFn: (() => void) | null = null;
    listen<string>("sync://local-change", (e) => {
      setEvents((prev) =>
        [{ path: e.payload, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 30)
      );
    }).then((fn) => { unlistenFn = fn; });

    return () => { unlistenFn?.(); };
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

      <div className="status-card">
        <div className="status-row">
          <span className="status-dot running" />
          <span>Kjører — inotify-watcher aktiv</span>
        </div>
        <div className="sync-path">
          Mappe: <code>{syncPath || "laster…"}</code>
        </div>
        {syncPath && (
          <p className="hint">
            Opprett <code>{syncPath}</code> og legg til filer for å teste.
          </p>
        )}
      </div>

      <SmokeTest />

      <div className="events-card">
        <h2>Filendringer (inotify smoke test)</h2>
        {events.length === 0 ? (
          <p className="no-events">Ingen endringer oppdaget ennå.</p>
        ) : (
          <ul className="event-list">
            {events.map((e, i) => (
              <li key={i} className="event-item">
                <span className="event-time">{e.time}</span>
                <span className="event-path">{e.path}</span>
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
