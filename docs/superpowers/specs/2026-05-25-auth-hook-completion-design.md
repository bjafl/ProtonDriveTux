# Auth Hook Completion — Design Spec

**Date:** 2026-05-25  
**Scope:** Fix and complete `useAuth`, `useHumanVerification`, `App`, `LoginForm`, `UnlockForm`

---

## Problem Summary

The auth hooks were started but left in a broken state. The core issues:

1. `useAuth` — `useCallback` wraps state derivation but result is discarded; `authInfo` is never updated
2. `useAuth._doRefresh` — calls `getSessionTokens()` but ignores the result; `tokensRef` is never populated on load
3. `useAuth` — `HumanVerificationError` is never caught; no `retryWithCaptcha`, `submitTotp`, or `submitMailboxPassword` exposed
4. `App.tsx` — destructures `status`, `loading`, `error` which don't exist on the hook's return
5. `LoginForm.tsx` — `useEffect` is broken (sync callback with `await`), references `err`, `handleCaptchaBack`, `initSdk` that are all undefined; `Partial2FA` not imported
6. `UnlockForm.tsx` — destructures `accessToken` directly; should be `tokens?.accessToken`

---

## Architecture

`useAuth` is the single source of truth for auth state. All components consume it; no component calls auth APIs directly.

### State Management

All mutable auth data lives in refs (avoids stale closures in async callbacks). A `deriveAuthInfo()` helper reads all refs and returns a complete `AuthInfo`. Every ref mutation is immediately followed by `setAuthInfo(deriveAuthInfo())`.

```
ref mutation → deriveAuthInfo() → setAuthInfo() → React re-render
```

No `stateVer` counter needed — remove it.

### Refs

| Ref | Type | Purpose |
|-----|------|---------|
| `tokensRef` | `SessionTokens \| null` | Active session tokens |
| `keyPasswordRef` | `string \| null` | Derived key password |
| `errorRef` | `AuthErrorInfo \| null` | Last auth error |
| `loginStateRef` | `LoginState \| null` | Current step in login flow; null = idle |
| `hvDataRef` | `{ hvToken: string; methods: string[] } \| null` | Data from `HumanVerificationError` |
| `credentialsRef` | `{ username: string; password: string; remember: boolean } \| null` | Stored for captcha retry and TOTP key derivation |
| `refreshPromiseRef` | `Promise<void> \| null` | Deduplicates concurrent refresh calls |

### LoginState Machine

```
loading
  └─ on refresh → loggedIn | loggedOut | error

loggedOut
  └─ startLogin() → loginStarted
       ├─ HumanVerificationError → pendingHv
       │    └─ retryWithCaptcha() → loginStarted (loop)
       ├─ twoFactorRequired → pendingTotp
       │    └─ submitTotp() → pendingSrp → loggedIn
       ├─ dualPasswordMode → pendingDualPassword
       │    └─ submitMailboxPassword() → pendingSrp → loggedIn
       └─ success → pendingSrp → loggedIn

loggedIn
  └─ logout() → loggedOut
  └─ refresh token expired → error
```

---

## `useAuth` — Complete API

### Return Shape

```ts
{
  // AuthInfo fields (spread):
  loggedIn: boolean
  userId: string | null
  state: LoginState
  tokens?: SessionTokens
  keyPassword?: string
  error?: AuthErrorInfo
  // HV data (only set when state === "pendingHv"):
  hvToken?: string
  hvMethods?: string[]
  // Methods:
  startLogin(username: string, password: string, remember?: boolean): Promise<void>
  submitTotp(totp: string): Promise<void>
  submitMailboxPassword(password: string): Promise<void>
  retryWithCaptcha(captchaToken: string): Promise<void>
  unlock(password: string, remember?: boolean): Promise<boolean>
  logout(): Promise<boolean>
  refresh(options?: { refreshTokens?: boolean; keyPassword?: boolean }): Promise<void>
}
```

### `deriveAuthInfo()`

Reads refs and returns `AuthInfo`. State priority (first match wins):

1. `loginStateRef.current` if non-null → use that state
2. tokens present + `accessToken` set → `"loggedIn"`
3. `refreshPromiseRef.current` set → `"refreshing"`
4. `errorRef.current` set → `"error"`
5. else → `"loggedOut"`

HV fields (`hvToken`, `hvMethods`) are returned from `hvDataRef` when `state === "pendingHv"`.

### `startLogin(username, password, remember?)`

1. Guard: if `loginPromiseRef.current` is set, await it and return
2. Store `credentialsRef = { username, password }`
3. Set `loginStateRef = "loginStarted"` → `setAuthInfo(deriveAuthInfo())`
4. Call `apiStartLogin(username, password)` — catches `HumanVerificationError`:
   - Store `hvDataRef = { hvToken, methods }`, set `loginStateRef = "pendingHv"` → update
   - Return (wait for `retryWithCaptcha`)
5. Store `tokensRef` from result
6. Branch on `twoFactorRequired` → `pendingTotp`, `dualPasswordMode` → `pendingDualPassword`
7. On straight success → `pendingSrp` → `_deriveKeyPassword(password, remember)` → clear loginState → update

### `submitTotp(totp)`

1. Assert tokens exist
2. Call `auth.submitTotp(uid, accessToken, refreshToken, userId, totp)` (persists tokens to Rust keyring)
3. Set `loginStateRef = "pendingSrp"` → update
4. Call `_deriveKeyPassword(credentialsRef.current.password, credentialsRef.current.remember)` (credentials stored from `startLogin`)
5. Clear `loginStateRef` + `credentialsRef` → update

### `submitMailboxPassword(password)`

1. Assert tokens exist
2. Set `loginStateRef = "pendingSrp"` → update
3. Call `_deriveKeyPassword(password)` (the mailbox password IS the key password for dual-password accounts)
4. Clear `loginStateRef` + `credentialsRef` → update

### `retryWithCaptcha(captchaToken)`

1. Assert `credentialsRef` exists
2. Call `startLoginWithCaptcha(username, password, captchaToken)` (same branching as `startLogin` step 4+)
3. Clear `hvDataRef` → proceed as normal login result

### `_doRefresh(refreshTokens?, keyPassword?)`

1. Call `getSessionTokens()` — store result in `tokensRef.current`
2. Call `getAuthStatus()` for sanity check
3. If `keyPassword || keyPasswordRef.current == null` → call `_getKeyPassword()`
4. If `refreshTokens` → call `_refreshTokens()`
5. `setAuthInfo(deriveAuthInfo())`

---

## `App.tsx` — Fix Destructuring and Effect

Fix destructuring to match actual hook return:
```ts
const { loggedIn, state, tokens, error: authError, refresh: refreshAuth } = useAuth();
```

Fix the auth effect to correctly derive `appState`:
- `state === "loading"` → `"loading"`
- `!loggedIn` → `"loggedOut"` (after loading)
- `!tokens?.keyPassword` and loggedIn → `"unlocking"`
- else → check `isOnboardingNeeded()` → `"onboarding"` | `"ready"`

Fix the `isOnboardingNeeded()` call in `useEffect` — currently the promise result is discarded. Call `setAppState` inside the `.then()`.

Remove direct `invoke("logout")` call — use `logout()` from `useAuth`.

---

## `LoginForm.tsx` — Clean Rewrite of Logic

Remove:
- `partial` state and `Partial2FA` import
- All commented-out old handler code
- The broken async `useEffect`
- Direct `submitTotp`, `startLoginWithCaptcha`, `initSdk` calls

Add methods from `useAuth`:
```ts
const { startLogin, submitTotp, submitMailboxPassword, retryWithCaptcha,
        state: loginState, error: authError, hvToken, hvMethods } = useAuth();
```

### Effects

**Step routing** — sync `useEffect` on `loginState`:
```
"loginStarted"      → setLoading(true)
"pendingTotp"       → setStep("totp"), setLoading(false)
"pendingDualPassword" → setStep("mailbox"), setLoading(false)
"pendingHv"         → setStep("captcha"), setLoading(false), openCaptchaWindow(hvToken, hvMethods)
"error"             → setError(authError?.message), setLoading(false)
```

**Captcha solved** — `useEffect` on `solvedCaptchaToken`:
```ts
if (solvedCaptchaToken) {
  retryWithCaptcha(solvedCaptchaToken);
}
```

**Login success** — `useEffect` on `loginState`:
```ts
if (loginState === "loggedIn") onLoginSuccess();
```

(All three can be one effect with guards.)

### Handlers

- `handleCredentials` — calls `startLogin(username, password)`; no direct API calls
- `handleTotp` — calls `submitTotp(totp)`
- `handleMailboxPassword` — calls `submitMailboxPassword(mailboxPassword)`
- `handleCaptchaBack` — calls `closeCaptchaWindow()`, sets step back to `"credentials"`

---

## `UnlockForm.tsx` — One-line fix

```ts
// before:
const { accessToken, logout, unlock, error: authError } = useAuth();

// after:
const { tokens, logout, unlock, error: authError } = useAuth();
// and guard:
if (!tokens?.accessToken) throw new Error("No stored session — please log in again");
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/hooks/useAuth.ts` | Full rewrite of state management; add `submitTotp`, `submitMailboxPassword`, `retryWithCaptcha` |
| `src/App.tsx` | Fix destructuring and auth effect |
| `src/components/LoginForm.tsx` | Remove broken code; wire to hook methods; add effects |
| `src/components/UnlockForm.tsx` | `accessToken` → `tokens?.accessToken` |

No new files. No changes to `useHumanVerification.ts` or `useTauriEventListener.ts` — they are correct.

---

## Not In Scope

- UI styling changes
- Adding remember-me logic to `submitTotp` / `submitMailboxPassword` (hook already accepts `remember` param in `startLogin`; the stored password is reused internally)
- Error recovery UX beyond surfacing `authError.message`
