import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { useAuthContext } from "../lib/authContext";
import { useHumanVerification } from "../hooks/useHumanVerification";
import { CaptchaWaitingFrame } from "./CaptchaWaitingFrame";
import { TotpForm } from "./TotpForm";
import { MailboxPwdForm } from "./MailboxPwdForm";
import { LoginForm } from "./LoginForm";

interface Props {
  onLoginSuccess: () => void;
}

type Step = "credentials" | "captcha" | "totp" | "mailbox";
interface LoginFormState {
  step: Step;
  loading: boolean;
  statusUi?: string;
  // hvMethods?: string[]
  error?: string;
}
export function LoginFrame({ onLoginSuccess }: Props) {
  const [state, setState] = useState<LoginFormState>({
    step: "credentials",
    loading: false,
  });

  function setPartialState(props: Partial<LoginFormState>) {
    setState((prev) => ({ ...prev, ...props }));
  }

  const {
    startLogin,
    submitTotp,
    submitMailboxPassword,
    retryWithCaptcha,
    state: loginState,
    error: authError,
    hvToken,
    hvMethods: authHvMethods,
  } = useAuthContext();
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
      setPartialState({
        loading: true,
        statusUi: t.loggingIn,
        error: undefined,
      });
    } else if (loginState === "pendingTotp") {
      setPartialState({ loading: false, step: "totp", statusUi: undefined });
    } else if (loginState === "pendingDualPassword") {
      setPartialState({ loading: false, step: "mailbox", statusUi: undefined });
    } else if (loginState === "pendingHv" && hvToken && authHvMethods) {
      setPartialState({ loading: false, step: "captcha", statusUi: undefined });
      // setHvMethods(authHvMethods);
      openCaptchaWindow(hvToken, authHvMethods);
    } else if (loginState === "error" && authError) {
      setPartialState({
        loading: false,
        error: authError.message,
        statusUi: undefined,
      });
    } else if (loginState === "loggedIn") {
      onLoginSuccess();
    }
  }, [
    loginState,
    authError,
    hvToken,
    authHvMethods,
    openCaptchaWindow,
    onLoginSuccess,
    t,
  ]);

  // Submit captcha solution back to auth hook
  useEffect(() => {
    if (solvedCaptchaToken) {
      retryWithCaptcha(solvedCaptchaToken);
    }
  }, [solvedCaptchaToken, retryWithCaptcha]);

  const handleCredentials = (data: { username: string; password: string }) => {
    setPartialState({ error: undefined, statusUi: undefined });
    startLogin(data.username, data.password);
  };

  const handleTotp = (data: { totp: string }) => {
    setPartialState({ error: undefined, statusUi: undefined });
    submitTotp(data.totp);
  };

  const handleMailboxPassword = (data: { mailboxPassword: string }) => {
    setPartialState({ error: undefined, loading: true });
    submitMailboxPassword(data.mailboxPassword);
  };

  const handleCaptchaBack = () => {
    closeCaptchaWindow();
    setPartialState({ step: "credentials", error: undefined });
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

        {state.step === "credentials" && (
          <LoginForm
            onSubmit={handleCredentials}
            error={state.error}
            statusUi={state.statusUi}
          />
        )}

        {state.step === "captcha" && (
          <CaptchaWaitingFrame
            hvMethods={authHvMethods}
            statusUi={state.loading ? state.statusUi : undefined}
            error={state.error}
            onBackClick={handleCaptchaBack}
          />
        )}

        {state.step === "totp" && (
          <TotpForm
            loggingIn={state.loading}
            onBackClick={() =>
              setPartialState({ step: "credentials", error: undefined })
            }
            onSubmit={handleTotp}
          />
        )}

        {state.step === "mailbox" && (
          <MailboxPwdForm
            onBackClick={() =>
              setPartialState({ step: "credentials", error: undefined })
            }
            onSubmit={handleMailboxPassword}
            unlocking={state.loading}
          />
        )}
      </div>
    </div>
  );
}
