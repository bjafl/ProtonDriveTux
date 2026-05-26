import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import { useAuthContext } from "../lib/authContext";
import { UnlockForm } from "./UnlockForm";

export function UnlockFrame({ onUnlocked }: { onUnlocked: () => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [unlocking, setUnlocking] = useState(false);
  const { tokens, logout, unlock, error: authError } = useAuthContext();
  const { t } = useLang();

  useEffect(() => {
    if (authError) setError(authError.message);
  }, [authError]);

  const handleSubmit = async (data: { password: string; remember: boolean }) => {
    setError(undefined);
    setUnlocking(true);
    try {
      if (!tokens?.accessToken) {
        setError("No active session — please log in again");
        return;
      }
      const ok = await unlock(data.password, data.remember);
      if (ok) onUnlocked();
      // if !ok and tokens were cleared, App redirects to login via auth state
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="login-title">{t.appName}</h1>
        <p className="disclaimer-banner">{t.unlockHint}</p>
        <UnlockForm
          onSubmit={handleSubmit}
          onLogout={logout}
          error={error}
          unlocking={unlocking}
        />
      </div>
    </div>
  );
}
