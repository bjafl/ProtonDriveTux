import { useState, useEffect } from "react";
import { getTrayStatus, showMainWindow, emitPauseToggle } from "../lib/ipcApi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TrayStatusPayload } from "../types/sync";

export function TrayPopup() {
  const [status, setStatus] = useState<TrayStatusPayload | null>(null);

  useEffect(() => {
    getTrayStatus().then((s) => {
      if (s) setStatus(s);
    });

    let statusUnlisten: (() => void) | null = null;
    let focusUnlisten: (() => void) | null = null;
    let cancelled = false;

    listen<TrayStatusPayload>("tray://status", (e) => setStatus(e.payload)).then((f) => {
      if (cancelled) f(); else statusUnlisten = f;
    });

    const win = getCurrentWindow();
    // Small delay so button clicks in the popup register before the window hides.
    win.onFocusChanged(({ payload: focused }) => {
      if (!focused) setTimeout(() => win.hide(), 150);
    }).then((f) => {
      if (cancelled) f(); else focusUnlisten = f;
    });

    return () => {
      cancelled = true;
      statusUnlisten?.();
      focusUnlisten?.();
    };
  }, []);

  function openMain() {
    showMainWindow().catch(console.error);
  }

  function togglePause() {
    emitPauseToggle().catch(console.error);
  }

  const paused = status?.paused ?? false;
  const syncing = status?.syncing ?? false;
  const errorCount = status?.errorCount ?? 0;
  const activeCount = status?.activeCount ?? 0;

  const statusEmoji = paused ? "⏸" : errorCount > 0 ? "⚠" : syncing ? "↕" : "✓";
  const statusText = paused
    ? "Sync paused"
    : syncing
    ? `Syncing ${activeCount} item${activeCount !== 1 ? "s" : ""}…`
    : errorCount > 0
    ? `${errorCount} error${errorCount !== 1 ? "s" : ""}`
    : "Up to date";

  const dotClass = paused
    ? "tp-dot tp-dot--paused"
    : errorCount > 0
    ? "tp-dot tp-dot--error"
    : syncing
    ? "tp-dot tp-dot--syncing"
    : "tp-dot tp-dot--ok";

  return (
    <div className="tp-root">
      {/* Header */}
      <div className="tp-header">
        <div className={dotClass} />
        <div className="tp-header-text">
          <span className="tp-app-name">Proton Drive Sync</span>
          <span className="tp-status-text">
            {statusEmoji} {statusText}
          </span>
        </div>
      </div>

      {/* Recent files */}
      <div className="tp-body">
        {status && status.recentFiles.length > 0 ? (
          <>
            <div className="tp-section-label">Recently synced</div>
            <ul className="tp-file-list">
              {status.recentFiles.slice(0, 8).map((f, i) => (
                <li key={i} className="tp-file-item">
                  <span className="tp-arrow">{f.direction === "up" ? "↑" : "↓"}</span>
                  <span className="tp-filename" title={f.name}>
                    {f.name}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="tp-empty">No recent activity</p>
        )}
      </div>

      {/* Actions */}
      <div className="tp-actions">
        <button className="tp-btn" onClick={togglePause}>
          {paused ? "▶  Resume" : "⏸  Pause"}
        </button>
        <button className="tp-btn tp-btn--primary" onClick={openMain}>
          Open app
        </button>
      </div>
    </div>
  );
}
