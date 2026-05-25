import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import { useAuth } from "../hooks/useAuth";

export function UnlockForm({
  onUnlocked,
  // onSessionExpired,
}: {
  onUnlocked: () => void;
  // onSessionExpired: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);
  const { tokens, logout, unlock, error: authError } = useAuth();
  const { t } = useLang();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (!tokens?.accessToken)
        throw new Error("No stored session — please log in again");
      if (!(await unlock(password, remember))) {
        throw new Error("Login failed."); //TODO
      }
      onUnlocked();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authError) {
      console.error(authError); //TODO
    }
  }, [authError]);

  const handleLogout = async () => {
    await logout();
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
