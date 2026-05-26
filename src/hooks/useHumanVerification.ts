import { useState, useCallback } from "react";
import {
  openCaptchaWindow as ipcOpenCaptchaWindow,
  closeCaptchaWindow as ipcCloseCaptchaWindow,
} from "../lib/ipcApi";
import { useTauriEventListener } from "./useTauriEventListener";

type Theme = "light" | "dark"; //todo
type CaptchaState = "idle" | "pending" | "solved" | "error" | "closed";

export function useHumanVerification(theme: Theme) {
  const [state, setState] = useState<CaptchaState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [solvedToken, setSolvedToken] = useState<string | null>(null);

  function handleCaptchaSolved(solvedToken: string) {
    setError(null);
    setState("solved");
    setSolvedToken(solvedToken);
  }
  const { registerListener, unregisterListener } =
    useTauriEventListener<string>(
      "captcha-token",
      (e) => handleCaptchaSolved(e.payload),
      { unregisterOnEvent: true },
    );

  const openCaptchaWindow = useCallback(
    async (hvToken: string, methods: string[]) => {
      registerListener();
      setError(null);
      setState("idle");

      try {
        await ipcOpenCaptchaWindow(hvToken, methods, theme);
        setState("pending");
      } catch (err) {
        unregisterListener();
        setState("error");
        setError(String(err));
      }
    },
    [],
  );

  // setError(null);
  //   setState("verifying");
  //   try {
  //     const result = await startLoginWithCaptcha(
  //       username,
  //       password,
  //       solvedToken,
  //     );
  //     if (result.twoFactorRequired) {
  //       setPartial({
  //         uid: result.uid,
  //         accessToken: result.accessToken,
  //         refreshToken: result.refreshToken,
  //         userId: result.userId,
  //       });
  //       setStep("totp");
  //       return;
  //     }
  //     await initSdk(
  //       result.uid,
  //       result.accessToken,
  //       result.refreshToken,
  //       result.userId,
  //       password,
  //     );
  //     onLoginSuccess();
  //   } catch (err: unknown) {
  //     setError(String(err));
  //     setStep("credentials");
  //   } finally {
  //     setLoading(false);
  //     setState(null);
  //   }
  // }
  const closeCaptchaWindow = useCallback(async () => {
    unregisterListener();
    await ipcCloseCaptchaWindow();
    setState("closed");
  }, []);
  return {
    state,
    error,
    solvedToken,
    openCaptchaWindow,
    closeCaptchaWindow,
  };
}
