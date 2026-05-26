import { useCallback, useEffect, useState } from "react";
import { LoginFrame } from "./components/LoginFrame";
import { Onboarding, isOnboardingNeeded } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { useLang } from "./lib/i18n";
import { UnlockFrame } from "./components/UnlockFrame";
import "./App.css";
import { useAuthContext } from "./lib/authContext";

type AppState = "loading" | "unlocking" | "loggedOut" | "onboarding" | "ready";

export function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const {
    loggedIn,
    state: authState,
    tokens,
    keyPassword,
    error: authError,
    logout,
  } = useAuthContext();
  const { t } = useLang();

  const handleSessionExpired = useCallback(async () => {
    await logout();
    setAppState("loggedOut");
  }, [logout]);

  useEffect(() => {
    if (authState === "loading" || authState === "refreshing") return;
    if (!loggedIn) {
      setAppState("loggedOut");
      return;
    }
    if (authError?.type === "expired") {
      void handleSessionExpired();
      return;
    }
    if (!keyPassword) {
      setAppState("unlocking");
      return;
    }
    isOnboardingNeeded().then((needed) =>
      setAppState(needed ? "onboarding" : "ready"),
    );
  }, [
    authState,
    loggedIn,
    tokens,
    keyPassword,
    authError,
    handleSessionExpired,
  ]);

  const goToNextState = async () => {
    setAppState((await isOnboardingNeeded()) ? "onboarding" : "ready");
  };

  if (appState === "loading") return <div className="loading">{t.loading}</div>;
  if (appState === "loggedOut") {
    return <LoginFrame onLoginSuccess={goToNextState} />;
  }
  if (appState === "onboarding") {
    return <Onboarding onComplete={() => setAppState("ready")} />;
  }
  if (appState === "unlocking") {
    return <UnlockFrame onUnlocked={goToNextState} />;
  }

  return (
    <Dashboard
      onSessionExpired={handleSessionExpired}
      onOpenOnboarding={() => setAppState("onboarding")}
    />
  );
}
