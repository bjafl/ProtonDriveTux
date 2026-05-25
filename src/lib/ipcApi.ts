import { invoke } from "@tauri-apps/api/core";
import { AuthStatus, SessionTokens } from "../types/auth";

export const getKeyPassword = async () =>
  invoke<string | null>("get_key_password");
export const getSessionTokens = async () =>
  invoke<SessionTokens | null>("get_session_tokens");
export const getAuthStatus = async () =>
  await invoke<AuthStatus>("get_auth_status");
export const logout = async () => invoke("logout");
export const storeKeyPassword = async (keyPassword: string) =>
  invoke<void>("store_key_password", { keyPassword });
export const openCaptchaWindow = async (args: {
  token: string;
  methods: string[];
  theme: "dark" | "light";
}) => invoke<void>("open_captcha_window", args);
export const closeCaptchaWindow = async () =>
  invoke<void>("close_captcha_window");
// export const a = async () =>
