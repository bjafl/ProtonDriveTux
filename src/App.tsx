import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoginForm } from "./components/LoginForm";
import { Onboarding, isOnboardingNeeded } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { releaseDriveClient } from "./lib/drive";
import { useLang } from "./lib/i18n";
import { UnlockForm } from "./components/UnlockForm";
import "./App.css";
import { useAuth } from "./hooks/useAuth";

type AppState = "loading" | "unlocking" | "loggedOut" | "onboarding" | "ready";

export function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const {
    status: authStatus,
    loading: authLoading,
    error: authError,
    refresh: refreshAuth,
  } = useAuth();
  const { t } = useLang();

  const handleSessionExpired = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    setAppState("loggedOut");
  };

  // Refresh auth on mount
  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    if (!authStatus || !authStatus.loggedIn) {
      setAppState("loggedOut");
    } else if (authLoading) {
      setAppState("unlocking");
    } else if (authError) {
      handleSessionExpired();
    }
    isOnboardingNeeded().then((onboardNeeded) =>
      onboardNeeded ? "onboarding" : "ready",
    );
  }, [authStatus, authLoading, authError]);

  const goToNextState = async () => {
    setAppState((await isOnboardingNeeded()) ? "onboarding" : "ready");
  };

  if (appState === "loading") return <div className="loading">{t.loading}</div>;
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
        // onSessionExpired={handleSessionExpired}
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
