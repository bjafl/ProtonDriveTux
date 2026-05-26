import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLang } from "../lib/i18n";

type MailboxPwdFormValues = { mailboxPassword: string };

export function MailboxPwdForm({
  error,
  onBackClick,
  onSubmit,
  unlocking = false,
}: {
  error?: string;
  unlocking?: boolean;
  onBackClick: () => void;
  onSubmit: (data: MailboxPwdFormValues) => void;
}) {
  const { t } = useLang();

  const schema = z.object({
    mailboxPassword: z.string().min(1, { message: t.validationRequired }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<MailboxPwdFormValues>({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="login-form">
      <p className="hint">{t.mailboxHint}</p>
      <div className="field">
        <label htmlFor="mailbox-password">{t.mailboxPassword}</label>
        <input
          {...register("mailboxPassword")}
          id="mailbox-password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          disabled={unlocking}
          autoFocus
        />
        {formErrors.mailboxPassword && (
          <p className="login-error">{formErrors.mailboxPassword.message}</p>
        )}
        <button type="button" className="back-btn" onClick={onBackClick}>
          {t.back}
        </button>
      </div>
      {error && <p className="login-error">{error}</p>}
      <button type="submit" className="login-btn" disabled={unlocking}>
        {unlocking ? t.unlocking : t.unlockBtn}
      </button>
    </form>
  );
}
