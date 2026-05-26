import { ErrorLevel } from "./logging";

export type LoginState =
  | "loading"
  | "loggedOut"
  | "loginStarted"
  | "pendingHv"
  | "pendingTotp"
  | "pendingSrp"
  | "pendingDualPassword"
  | "loggedIn"
  | "refreshing"
  | "error";

export interface AuthStatus {
  loggedIn: boolean;
  userId: string | null;
}

export interface AuthInfo extends AuthStatus {
  state?: LoginState;
  tokens?: SessionTokens;
  keyPassword?: string;
  error?: AuthErrorInfo;
  hvToken?: string;
  hvMethods?: string[];
}

export interface SessionTokens {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export interface Partial2FA {
  uid: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export type AuthErrorType =
  | "expired"
  | "refreshFailed"
  | "logoutError"
  | "loginError"
  | "unknown";

export interface AuthErrorInfo {
  level: ErrorLevel;
  type: AuthErrorType;
  message: string;
  error?: Error;
}
