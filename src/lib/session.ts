import { invoke } from "@tauri-apps/api/core";

export interface AuthSession {
  uid: string;
  access_token: string;
  refresh_token: string;
  user_id: string;
  two_factor_enabled: boolean;
}

export interface AuthStatus {
  loggedIn: boolean;
  userId: string | null;
  twoFactorEnabled: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("get_auth_status");
}
