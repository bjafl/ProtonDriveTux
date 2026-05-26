import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLang } from "../lib/i18n";

type UnlockFormValues = { password: string; remember: boolean };

export function UnlockForm({
  error,
  onSubmit,
  onLogout,
  unlocking = false,
}: {
  error?: string;
  unlocking?: boolean;
  onLogout: () => void;
  onSubmit: (data: UnlockFormValues) => void;
}) {
  const { t } = useLang();

  const schema = z.object({
    password: z.string().min(1, { message: t.validationRequired }),
    remember: z.boolean(),
  });

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<UnlockFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { remember: false },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="login-form">
      <div className="field">
        <label htmlFor="unlock-password">{t.password}</label>
        <input
          {...register("password")}
          id="unlock-password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          disabled={unlocking}
          autoFocus
        />
        {formErrors.password && (
          <p className="login-error">{formErrors.password.message}</p>
        )}
      </div>
      <label className="field-check">
        <input {...register("remember")} type="checkbox" disabled={unlocking} />
        {t.rememberUnlock}
      </label>
      {error && <p className="login-error">{error}</p>}
      <button type="submit" className="login-btn" disabled={unlocking}>
        {unlocking ? t.unlocking : t.unlockBtn}
      </button>
      <button type="button" className="back-btn" onClick={onLogout}>
        {t.switchAccount}
      </button>
    </form>
  );
}
