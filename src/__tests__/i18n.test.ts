import { describe, it, expect } from "vitest";
import { T } from "../lib/translations";
import type { Translations } from "../lib/translations";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STRING_KEYS: Array<keyof Translations> = [
  "appName", "loading", "disclaimer", "unofficialBanner",
  "username", "password", "loginBtn", "loggingIn", "totp", "confirmBtn", "back",
  "mailboxPassword", "mailboxHint", "unlockHint", "unlockBtn", "unlocking",
  "rememberUnlock", "switchAccount", "captchaHint", "captchaMethods",
  "logout", "syncIdle", "localFolder", "driveFolder", "errors",
  "syncedFiles", "noFiles", "settings", "autostart", "autostartHint",
  "on", "off", "localChanges", "noChanges", "darkMode", "lightMode", "langToggle",
  "onboardingWelcomeTitle", "onboardingWelcomeBody",
  "onboardingLocalRootTitle", "onboardingLocalRootHint", "onboardingLocalRootBrowse",
  "onboardingFolderSelectTitle", "onboardingFolderSelectHint",
  "onboardingStartSync", "onboardingNext", "onboardingBack",
  "localRootUnderHome", "localRootIsHome", "localRootIsSystemDir",
  "folderTreeLoading", "folderTreeEmpty",
  "conflictTitle", "conflictColName", "conflictColLocalSize", "conflictColLocalDate",
  "conflictColRemoteSize", "conflictColRemoteDate", "conflictColKeep",
  "conflictKeepLocal", "conflictKeepRemote",
  "conflictBulkNewest", "conflictBulkLargest", "conflictBulkAllLocal", "conflictConfirm",
  "changeSyncSettings", "notConfigured",
];

const FUNCTION_KEYS: Array<keyof Translations> = [
  "syncingItems",
  "onboardingLocalRootNonEmptyWarning",
  "conflictSubtitle",
];

// ── Completeness ──────────────────────────────────────────────────────────────

describe("translations completeness", () => {
  for (const lang of ["no", "en"] as const) {
    describe(`T.${lang}`, () => {
      it("has all string keys as non-empty strings", () => {
        for (const key of STRING_KEYS) {
          const value = T[lang][key];
          expect(typeof value, `key "${key}"`).toBe("string");
          expect((value as string).length, `key "${key}"`).toBeGreaterThan(0);
        }
      });

      it("has all function keys as functions returning non-empty strings", () => {
        for (const key of FUNCTION_KEYS) {
          const fn = T[lang][key] as (n: number) => string;
          expect(typeof fn, `key "${key}"`).toBe("function");
          const result = fn(3);
          expect(typeof result, `key "${key}" return type`).toBe("string");
          expect(result.length, `key "${key}" return value`).toBeGreaterThan(0);
        }
      });
    });
  }
});

// ── Specific function outputs ─────────────────────────────────────────────────

describe("T.no function keys", () => {
  it("syncingItems interpolates the count", () => {
    expect(T.no.syncingItems(5)).toContain("5");
    expect(T.no.syncingItems(1)).toContain("1");
  });

  it("onboardingLocalRootNonEmptyWarning interpolates the count", () => {
    expect(T.no.onboardingLocalRootNonEmptyWarning(42)).toContain("42");
  });

  it("conflictSubtitle interpolates the count", () => {
    expect(T.no.conflictSubtitle(7)).toContain("7");
  });
});

describe("T.en function keys", () => {
  it("syncingItems interpolates the count", () => {
    expect(T.en.syncingItems(5)).toContain("5");
  });

  it("onboardingLocalRootNonEmptyWarning interpolates the count", () => {
    expect(T.en.onboardingLocalRootNonEmptyWarning(10)).toContain("10");
  });

  it("conflictSubtitle interpolates the count", () => {
    expect(T.en.conflictSubtitle(0)).toContain("0");
  });
});

// ── Language toggle markers ───────────────────────────────────────────────────

describe("langToggle values", () => {
  it("T.no.langToggle is EN (points to the other language)", () => {
    expect(T.no.langToggle).toBe("EN");
  });

  it("T.en.langToggle is NO (points to the other language)", () => {
    expect(T.en.langToggle).toBe("NO");
  });
});
