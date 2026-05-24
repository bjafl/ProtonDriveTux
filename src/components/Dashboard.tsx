import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileState } from "../lib/sync";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { useSyncStatus } from "../hooks/useSyncStatus";

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

export function Dashboard({
  onSessionExpired,
  onOpenOnboarding,
}: {
  onSessionExpired: () => void;
  onOpenOnboarding: () => void;
}) {
  const [fileStates, setFileStates] = useState<FileState[]>([]);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();

  const refreshFileStates = async () => {
    try {
      const files = await invoke<FileState[]>("get_all_file_states");
      setFileStates(files);
    } catch { /* ignore */ }
  };

  const {
    syncStatus, syncPaused, syncPath, driveFolders, localEvents, syncingFull,
    handleLogout, handleFullSync, togglePause,
  } = useSyncStatus(onSessionExpired, refreshFileStates);

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
          <span className={`status-dot ${!syncPaused && syncStatus.active.length > 0 ? "running" : ""}`} />
          <span>
            {syncPaused
              ? "⏸ " + t.pauseSync
              : syncStatus.active.length > 0
              ? t.syncingItems(syncStatus.active.length)
              : t.syncIdle}
          </span>
          <div style={{ display: "flex", gap: "0.4rem", marginLeft: "auto" }}>
            <button
              className="back-btn"
              style={{ fontSize: "0.8rem" }}
              onClick={togglePause}
              title={syncPaused ? t.resumeSync : t.pauseSync}
            >
              {syncPaused ? "▶" : "⏸"} {syncPaused ? t.resumeSync : t.pauseSync}
            </button>
            <button
              className="back-btn"
              style={{ fontSize: "0.8rem" }}
              onClick={handleFullSync}
              disabled={syncingFull || syncStatus.active.length > 0 || syncPaused}
              title={t.syncNow}
            >
              {syncingFull ? "⟳" : "↺"} {t.syncNow}
            </button>
          </div>
        </div>
        <div className="sync-path">
          {t.localFolder} <code>{syncPath || t.loading}</code>
        </div>
        <div className="sync-path">
          {t.driveFolder}{" "}
          <code>{driveFolders.length > 0 ? driveFolders.join(", ") : t.loading}</code>
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
        <div className="setting-row" style={{ marginTop: "0.75rem" }}>
          <div>
            <div className="setting-label">{t.changeSyncSettings}</div>
          </div>
          <button className="back-btn" onClick={onOpenOnboarding}>
            ⚙
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
