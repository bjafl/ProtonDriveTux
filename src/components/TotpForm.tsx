import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLang } from "../lib/i18n";

type TotpFormValues = { totp: string };

export function TotpForm({
  error,
  onBackClick,
  onSubmit,
  loggingIn = false,
}: {
  error?: string;
  loggingIn?: boolean;
  onBackClick: () => void;
  onSubmit: (data: TotpFormValues) => void;
}) {
  const { t } = useLang();

  const schema = z.object({
    totp: z
      .string()
      .min(1, { message: t.validationTotpCode })
      .max(6, { message: t.validationTotpCode })
      .regex(/^\d+$/, { message: t.validationTotpCode }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<TotpFormValues>({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="login-form">
      <div className="field">
        <label htmlFor="totp">{t.totp}</label>
        <input
          {...register("totp")}
          id="totp"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          disabled={loggingIn}
          autoFocus
        />
        {formErrors.totp && (
          <p className="login-error">{formErrors.totp.message}</p>
        )}
        <button type="button" className="back-btn" onClick={onBackClick}>
          {t.back}
        </button>
      </div>
      {error && <p className="login-error">{error}</p>}
      <button type="submit" className="login-btn" disabled={loggingIn}>
        {loggingIn ? t.loggingIn : t.confirmBtn}
      </button>
    </form>
  );
}
