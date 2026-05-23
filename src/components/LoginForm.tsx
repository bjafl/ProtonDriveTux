import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  HumanVerificationError,
  startLogin,
  startLoginWithCaptcha,
  submitTotp,
} from "../lib/auth";
import { initDriveClient, deriveKeyPassword } from "../lib/drive";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";

interface Props {
  onLoginSuccess: () => void;
}

type Step = "credentials" | "captcha" | "totp" | "mailbox";

interface Partial2FA {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export function LoginForm({ onLoginSuccess }: Props) {
  const [step, setStep] = useState<Step>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [partial, setPartial] = useState<Partial2FA | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hvMethods, setHvMethods] = useState<string[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const { t, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  async function openCaptchaWindow(hvToken: string, methods: string[]) {
    unlistenRef.current?.();
    unlistenRef.current = null;

    const unlisten = await listen<string>("captcha-token", async (event) => {
      unlisten();
      unlistenRef.current = null;
      await handleCaptchaSolved(event.payload);
    });
    unlistenRef.current = unlisten;

    try {
      await invoke("open_captcha_window", {
        token: hvToken,
        methods,
        theme: theme === "dark" ? "dark" : "light",
      });
      setStep("captcha");
    } catch (err) {
      unlisten();
      unlistenRef.current = null;
      setError(String(err));
    }
  }

  async function handleCaptchaSolved(solvedToken: string) {
    setError(null);
    setLoading(true);
    setStatus("Verifying CAPTCHA…");
    try {
      const result = await startLoginWithCaptcha(username, password, solvedToken);
      if (result.twoFactorRequired) {
        setPartial({ uid: result.uid, accessToken: result.accessToken, refreshToken: result.refreshToken, userId: result.userId });
        setStep("totp");
        return;
      }
      await initSdk(result.uid, result.accessToken, result.refreshToken, result.userId, password);
      onLoginSuccess();
    } catch (err: unknown) {
      setError(String(err));
      setStep("credentials");
    } finally {
      setLoading(false);
      setStatus(null);
    }
  }

  async function initSdk(uid: string, accessToken: string, refreshToken: string, userId: string, pwd: string) {
    setStatus("Deriving key password…");
    const keyPassword = await deriveKeyPassword(pwd, accessToken, uid);
    setStatus("Initializing Drive client…");
    await initDriveClient({ uid, accessToken, refreshToken, userId, keyPassword });
  }

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      setStatus(t.loggingIn);
      const result = await startLogin(username, password);

      if (result.twoFactorRequired) {
        setPartial({ uid: result.uid, accessToken: result.accessToken, refreshToken: result.refreshToken, userId: result.userId });
        setStep("totp");
        setLoading(false);
        setStatus(null);
        return;
      }

      if (result.dualPasswordMode) {
        setPartial({ uid: result.uid, accessToken: result.accessToken, refreshToken: result.refreshToken, userId: result.userId });
        setStep("mailbox");
        setLoading(false);
        setStatus(null);
        return;
      }

      await initSdk(result.uid, result.accessToken, result.refreshToken, result.userId, password);
      onLoginSuccess();
    } catch (err: unknown) {
      if (err instanceof HumanVerificationError) {
        setLoading(false);
        setStatus(null);
        setHvMethods(err.methods);
        await openCaptchaWindow(err.hvToken, err.methods);
        return;
      }
      setError(String(err));
    } finally {
      setLoading(false);
      setStatus(null);
    }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partial) return;
    setError(null);
    setLoading(true);
    try {
      await submitTotp(partial.uid, partial.accessToken, partial.refreshToken, partial.userId, totp);
      await initSdk(partial.uid, partial.accessToken, partial.refreshToken, partial.userId, password);
      onLoginSuccess();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const [mailboxPassword, setMailboxPassword] = useState("");
  const handleMailboxPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partial) return;
    setError(null);
    setLoading(true);
    try {
      await initSdk(partial.uid, partial.accessToken, partial.refreshToken, partial.userId, mailboxPassword);
      onLoginSuccess();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  function handleCaptchaBack() {
    unlistenRef.current?.();
    unlistenRef.current = null;
    invoke("close_captcha_window").catch(() => {});
    setStep("credentials");
    setError(null);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.4rem", marginBottom: "-0.5rem" }}>
          <button className="icon-btn" onClick={toggleTheme} title={theme === "dark" ? t.lightMode : t.darkMode}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="icon-btn" onClick={toggleLang}>{t.langToggle}</button>
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
              {t.captchaMethods} <code>{hvMethods.join(", ") || "unknown"}</code>
            </p>
            {loading && <p className="hint">{status}</p>}
            {error && <p className="login-error">{error}</p>}
            <button type="button" className="back-btn" onClick={handleCaptchaBack}>
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
                onClick={() => { setStep("credentials"); setTotp(""); setError(null); setPartial(null); }}
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
                onClick={() => { setStep("credentials"); setMailboxPassword(""); setError(null); setPartial(null); }}
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
