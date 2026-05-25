import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { useAuth } from "../hooks/useAuth";
import { useHumanVerification } from "../hooks/useHumanVerification";

interface Props {
  onLoginSuccess: () => void;
}

type Step = "credentials" | "captcha" | "totp" | "mailbox";

export function LoginForm({ onLoginSuccess }: Props) {
  const [step, setStep] = useState<Step>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mailboxPassword, setMailboxPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hvMethods, setHvMethods] = useState<string[]>([]);

  const {
    startLogin,
    submitTotp,
    submitMailboxPassword,
    retryWithCaptcha,
    state: loginState,
    error: authError,
    hvToken,
    hvMethods: authHvMethods,
  } = useAuth();
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();
  const {
    openCaptchaWindow,
    closeCaptchaWindow,
    solvedToken: solvedCaptchaToken,
  } = useHumanVerification(theme);

  // Drive UI state from auth state machine
  useEffect(() => {
    if (loginState === "loginStarted" || loginState === "pendingSrp") {
      setLoading(true);
      setStatus(t.loggingIn);
      setError(null);
    } else if (loginState === "pendingTotp") {
      setStep("totp");
      setLoading(false);
      setStatus(null);
    } else if (loginState === "pendingDualPassword") {
      setStep("mailbox");
      setLoading(false);
      setStatus(null);
    } else if (loginState === "pendingHv" && hvToken && authHvMethods) {
      setHvMethods(authHvMethods);
      setStep("captcha");
      setLoading(false);
      setStatus(null);
      openCaptchaWindow(hvToken, authHvMethods);
    } else if (loginState === "error" && authError) {
      setError(authError.message);
      setLoading(false);
      setStatus(null);
    } else if (loginState === "loggedIn") {
      onLoginSuccess();
    }
  }, [loginState, authError, hvToken, authHvMethods, openCaptchaWindow, onLoginSuccess, t]);

  // Submit captcha solution back to auth hook
  useEffect(() => {
    if (solvedCaptchaToken) {
      retryWithCaptcha(solvedCaptchaToken);
    }
  }, [solvedCaptchaToken, retryWithCaptcha]);

  const handleCredentials = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    startLogin(username, password);
  };

  const handleTotp = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    void submitTotp(totp);
  };

  const handleMailboxPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    void submitMailboxPassword(mailboxPassword);
  };

  const handleCaptchaBack = () => {
    closeCaptchaWindow();
    setStep("credentials");
    setError(null);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.4rem",
            marginBottom: "-0.5rem",
          }}
        >
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? t.lightMode : t.darkMode}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="icon-btn" onClick={toggleLang}>
            {t.langToggle}
          </button>
        </div>

        <h1 className="login-title">{t.appName}</h1>

        <p className="disclaimer-banner">{t.unofficialBanner}</p>

        {step === "credentials" && (
          <form onSubmit={handleCredentials} className="login-form">
            <div className="field">
              <label htmlFor="username">{t.username}</label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="bruker@proton.me"
                required
                disabled={loading}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t.password}</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
              />
            </div>
            {status && <p className="hint">{status}</p>}
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? (status ?? t.loggingIn) : t.loginBtn}
            </button>
          </form>
        )}

        {step === "captcha" && (
          <div className="captcha-wrap">
            <p className="hint">{t.captchaHint}</p>
            <p className="hint">
              {t.captchaMethods}{" "}
              <code>{hvMethods.join(", ") || "unknown"}</code>
            </p>
            {loading && <p className="hint">{status}</p>}
            {error && <p className="login-error">{error}</p>}
            <button
              type="button"
              className="back-btn"
              onClick={handleCaptchaBack}
            >
              {t.back}
            </button>
          </div>
        )}

        {step === "totp" && (
          <form onSubmit={handleTotp} className="login-form">
            <div className="field">
              <label htmlFor="totp">{t.totp}</label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="123456"
                maxLength={6}
                required
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                className="back-btn"
                onClick={() => {
                  setStep("credentials");
                  setTotp("");
                  setError(null);
                }}
              >
                {t.back}
              </button>
            </div>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? t.loggingIn : t.confirmBtn}
            </button>
          </form>
        )}

        {step === "mailbox" && (
          <form onSubmit={handleMailboxPassword} className="login-form">
            <p className="hint">{t.mailboxHint}</p>
            <div className="field">
              <label htmlFor="mailbox-password">{t.mailboxPassword}</label>
              <input
                id="mailbox-password"
                type="password"
                autoComplete="current-password"
                value={mailboxPassword}
                onChange={(e) => setMailboxPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                className="back-btn"
                onClick={() => {
                  setStep("credentials");
                  setMailboxPassword("");
                  setError(null);
                }}
              >
                {t.back}
              </button>
            </div>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? t.unlocking : t.unlockBtn}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
