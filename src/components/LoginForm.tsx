import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLang } from "../lib/i18n";

type LoginFormValues = { username: string; password: string };

export function LoginForm({
  error,
  statusUi,
  onSubmit,
  loggingIn = false,
}: {
  error?: string;
  statusUi?: string;
  loggingIn?: boolean;
  onSubmit: (data: LoginFormValues) => void;
}) {
  const { t } = useLang();

  const schema = z.object({
    username: z.string().email({ message: t.validationInvalidEmail }),
    password: z.string().min(1, { message: t.validationRequired }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="login-form">
      <div className="field">
        <label htmlFor="username">{t.username}</label>
        <input
          {...register("username")}
          id="username"
          type="email"
          autoComplete="username"
          placeholder="bruker@proton.me"
          disabled={loggingIn}
        />
        {formErrors.username && (
          <p className="login-error">{formErrors.username.message}</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="password">{t.password}</label>
        <input
          {...register("password")}
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          disabled={loggingIn}
        />
        {formErrors.password && (
          <p className="login-error">{formErrors.password.message}</p>
        )}
      </div>
      {statusUi && <p className="hint">{statusUi}</p>}
      {error && <p className="login-error">{error}</p>}
      <button type="submit" className="login-btn" disabled={loggingIn}>
        {loggingIn ? (statusUi ?? t.loggingIn) : t.loginBtn}
      </button>
    </form>
  );
}
