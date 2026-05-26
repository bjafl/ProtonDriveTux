import { useLang } from "../lib/i18n";

export function CaptchaWaitingFrame({
  hvMethods,
  statusUi,
  error,
  onBackClick,
}: {
  hvMethods?: string[];
  statusUi?: string;
  error?: string;
  onBackClick: () => void;
}) {
  const { t } = useLang();

  return (
    <div className="captcha-wrap">
      <p className="hint">{t.captchaHint}</p>
      <p className="hint">
        {t.captchaMethods} <code>{hvMethods?.join(", ") || "unknown"}</code>
      </p>
      {statusUi && <p className="hint">{statusUi}</p>}
      {error && <p className="login-error">{error}</p>}
      <button type="button" className="back-btn" onClick={onBackClick}>
        {t.back}
      </button>
    </div>
  );
}
