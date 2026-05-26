/**
 * Onboarding wizard — shown on first launch or when local root is not configured.
 *
 * Steps:
 *   0: Welcome
 *   1: Choose local root folder
 *   2: Choose Drive folders to sync
 *   2b: Conflict resolution (only when local root is non-empty and Drive has files)
 */
import { useEffect, useState } from "react";
import {
  validateLocalRoot,
  clearAllFileStates,
  setLocalRoot as ipcSetLocalRoot,
  setDbSyncConfig,
  getLocalRoot,
} from "../lib/ipcApi";
import { getSyncRoot } from "../lib/drive";
import { FolderTree } from "./FolderTree";
import { ConflictWizard } from "./ConflictWizard";
import type { SelectedFolderRecord } from "../lib/sync";
import type { LocalRootInfo } from "../types/sync";
import { defaultSyncPath } from "../lib/paths";
import { useLang } from "../lib/i18n";

type Step = "welcome" | "localRoot" | "folderSelect" | "conflict";

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [localRoot, setLocalRoot] = useState("");
  const [localRootInput, setLocalRootInput] = useState("");
  const [localRootInfo, setLocalRootInfo] = useState<LocalRootInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [driveRootUid, setDriveRootUid] = useState<string | null>(null);
  const [selectedFolders, setSelectedFolders] = useState<SelectedFolderRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const { t } = useLang();

  // Pre-fill localRootInput with the default path.
  useEffect(() => {
    defaultSyncPath().then(setLocalRootInput).catch(console.error);
  }, []);

  // Load Drive root UID when entering folder select step.
  useEffect(() => {
    if (step !== "folderSelect" || driveRootUid) return;
    getSyncRoot()
      .then((result) => {
        if (result.ok) setDriveRootUid(result.value.uid);
      })
      .catch(console.error);
  }, [step, driveRootUid]);

  async function validateRoot(path: string): Promise<LocalRootInfo | null> {
    if (!path.trim()) return null;
    setValidating(true);
    try {
      return await validateLocalRoot(path.trim());
    } catch {
      return null;
    } finally {
      setValidating(false);
    }
  }

  async function handleLocalRootNext() {
    const path = localRootInput.trim();
    const info = await validateRoot(path);
    setLocalRootInfo(info);
    if (!info?.valid) return;
    setLocalRoot(path);
    setStep("folderSelect");
  }

  async function handleFolderSelectNext() {
    // Save local root to DB (creates dir if needed).
    // Clear all stale file states first so the new sync session starts clean — without
    // this, the engine would see old paths as conflicts with the new root's files.
    setSaving(true);
    try {
      await clearAllFileStates();
      await ipcSetLocalRoot(localRoot);
      await setDbSyncConfig("selected_folders", JSON.stringify(selectedFolders));
    } catch (err) {
      console.error("[onboarding] save failed:", err);
      setSaving(false);
      return;
    }
    setSaving(false);

    // If non-empty local root, show conflict wizard.
    if (localRootInfo?.exists && !localRootInfo.isEmpty) {
      setStep("conflict");
    } else {
      onComplete();
    }
  }

  // ── Step renders ───────────────────────────────────────────────────────────

  if (step === "welcome") {
    return (
      <div className="login-wrap">
        <div className="login-card onboarding-card">
          <h1 className="login-title">{t.onboardingWelcomeTitle}</h1>
          <p className="hint">{t.onboardingWelcomeBody}</p>
          <p className="disclaimer-banner">{t.unofficialBanner}</p>
          <button className="login-btn" onClick={() => setStep("localRoot")}>
            {t.onboardingNext}
          </button>
        </div>
      </div>
    );
  }

  if (step === "localRoot") {
    const info = localRootInfo;
    return (
      <div className="login-wrap">
        <div className="login-card onboarding-card">
          <h1 className="login-title">{t.onboardingLocalRootTitle}</h1>
          <p className="hint">{t.onboardingLocalRootHint}</p>

          <div className="field">
            <label htmlFor="local-root-input">{t.localFolder}</label>
            <input
              id="local-root-input"
              type="text"
              value={localRootInput}
              onChange={(e) => {
                setLocalRootInput(e.target.value);
                setLocalRootInfo(null);
              }}
              placeholder="/home/user/ProtonDrive"
              disabled={validating}
              autoFocus
            />
          </div>

          {info && !info.valid && (
            <p className="login-error">{info.error ?? t.localRootUnderHome}</p>
          )}
          {info?.valid && !info.isEmpty && (
            <p className="disclaimer-banner">
              {t.onboardingLocalRootNonEmptyWarning(info.fileCount)}
            </p>
          )}

          <div className="onboarding-nav">
            <button className="back-btn" onClick={() => setStep("welcome")}>
              {t.onboardingBack}
            </button>
            <button
              className="login-btn"
              onClick={handleLocalRootNext}
              disabled={validating || !localRootInput.trim()}
            >
              {validating ? t.loading : t.onboardingNext}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "folderSelect") {
    // Derive current root mode from selectedFolders.
    const rootEntry = driveRootUid
      ? selectedFolders.find((f) => f.uid === driveRootUid)
      : undefined;
    const rootMode: "none" | "files" | "recursive" = rootEntry
      ? rootEntry.mode
      : "none";

    function setRootMode(mode: "none" | "files" | "recursive") {
      if (!driveRootUid) return;
      if (mode === "none") {
        setSelectedFolders((prev) => prev.filter((f) => f.uid !== driveRootUid));
      } else {
        setSelectedFolders((prev) => {
          const without = prev.filter((f) => f.uid !== driveRootUid);
          return [{ uid: driveRootUid!, name: "My Files", drivePath: "", mode }, ...without];
        });
      }
    }

    return (
      <div className="login-wrap">
        <div className="login-card onboarding-card onboarding-card--wide">
          <h1 className="login-title">{t.onboardingFolderSelectTitle}</h1>
          <p className="hint">{t.onboardingFolderSelectHint}</p>

          {driveRootUid ? (
            <>
              <div className="root-mode-row">
                <span className="root-mode-label">{t.onboardingRootLabel}</span>
                <div className="root-mode-btns">
                  {(
                    [
                      ["none", t.onboardingRootNone],
                      ["files", t.onboardingRootFiles],
                      ["recursive", t.onboardingRootAll],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={`root-mode-btn${rootMode === mode ? " root-mode-btn--active" : ""}`}
                      onClick={() => setRootMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="folder-tree-wrap">
                <FolderTree
                  driveRootUid={driveRootUid}
                  value={selectedFolders}
                  onChange={setSelectedFolders}
                />
              </div>
            </>
          ) : (
            <p className="no-events">{t.loading}</p>
          )}

          <div className="onboarding-nav">
            <button className="back-btn" onClick={() => setStep("localRoot")} disabled={saving}>
              {t.onboardingBack}
            </button>
            <button className="login-btn" onClick={handleFolderSelectNext} disabled={saving || !driveRootUid}>
              {saving ? t.loading : t.onboardingStartSync}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // step === "conflict"
  return (
    <div className="login-wrap">
      <div className="login-card onboarding-card onboarding-card--wide">
        <ConflictWizard
          localRoot={localRoot}
          selectedFolders={selectedFolders}
          onComplete={onComplete}
          onBack={() => setStep("folderSelect")}
        />
      </div>
    </div>
  );
}

/** Returns true when onboarding needs to run (no local root set or path gone). */
export async function isOnboardingNeeded(): Promise<boolean> {
  const root = await getLocalRoot();
  if (!root) return true;
  const info = await validateLocalRoot(root);
  return !info.exists;
}
