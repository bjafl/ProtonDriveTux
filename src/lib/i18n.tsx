import { createContext, useContext, useState } from "react";

type Lang = "no" | "en";

export type Translations = {
  appName: string;
  loading: string;
  disclaimer: string;
  unofficialBanner: string;
  username: string;
  password: string;
  loginBtn: string;
  loggingIn: string;
  totp: string;
  confirmBtn: string;
  back: string;
  mailboxPassword: string;
  mailboxHint: string;
  unlockHint: string;
  unlockBtn: string;
  unlocking: string;
  rememberUnlock: string;
  switchAccount: string;
  captchaHint: string;
  captchaMethods: string;
  logout: string;
  syncingItems: (n: number) => string;
  syncIdle: string;
  localFolder: string;
  driveFolder: string;
  errors: string;
  syncedFiles: string;
  noFiles: string;
  settings: string;
  autostart: string;
  autostartHint: string;
  on: string;
  off: string;
  localChanges: string;
  noChanges: string;
  darkMode: string;
  lightMode: string;
  langToggle: string;
};

const T: Record<Lang, Translations> = {
  no: {
    appName: "Proton Drive Sync",
    loading: "Laster…",
    disclaimer: "Uoffisiell tredjepartsapp — ikke støttet av Proton.",
    unofficialBanner: "Dette er en uoffisiell tredjepartsapp ikke offisielt støttet av Proton.",
    // Login
    username: "Brukernavn",
    password: "Passord",
    loginBtn: "Logg inn",
    loggingIn: "Logger inn…",
    totp: "Engangskode (2FA)",
    confirmBtn: "Bekreft",
    back: "← Tilbake",
    mailboxPassword: "Postboks-passord",
    mailboxHint: "Kontoen din bruker separat postboks-passord. Skriv inn postboks-passordet for å låse opp krypteringsnøkler.",
    // Unlock
    unlockHint: "Skriv inn passordet ditt for å låse opp Drive-tilgang.",
    unlockBtn: "Lås opp",
    unlocking: "Låser opp…",
    rememberUnlock: "Husk opplåsing",
    switchAccount: "Bytt konto",
    // Captcha
    captchaHint: "Proton krever verifisering. Fullfør utfordringen i vinduet som åpnet seg.",
    captchaMethods: "Metoder:",
    // Main view
    logout: "Logg ut",
    syncingItems: (n: number) => `Synkroniserer ${n} element(er)…`,
    syncIdle: "Kjører — sync-motor aktiv",
    localFolder: "Lokal mappe:",
    driveFolder: "Drive-mappe:",
    errors: "Feil:",
    syncedFiles: "Synkroniserte filer",
    noFiles: "Ingen filer registrert i databasen ennå.",
    settings: "Innstillinger",
    autostart: "Start ved innlogging",
    autostartHint: "Start Proton Drive Sync automatisk når du logger inn på GNOME.",
    on: "På",
    off: "Av",
    localChanges: "Lokale filendringer (inotify)",
    noChanges: "Ingen endringer oppdaget ennå.",
    darkMode: "Mørkt",
    lightMode: "Lyst",
    langToggle: "EN",
  },
  en: {
    appName: "Proton Drive Sync",
    loading: "Loading…",
    disclaimer: "Unofficial third-party app — not supported by Proton.",
    unofficialBanner: "This is an unofficial third-party app not officially supported by Proton.",
    // Login
    username: "Username",
    password: "Password",
    loginBtn: "Log in",
    loggingIn: "Logging in…",
    totp: "One-time code (2FA)",
    confirmBtn: "Confirm",
    back: "← Back",
    mailboxPassword: "Mailbox password",
    mailboxHint: "Your account uses a separate mailbox password. Enter it to unlock your encryption keys.",
    // Unlock
    unlockHint: "Enter your password to unlock Drive access.",
    unlockBtn: "Unlock",
    unlocking: "Unlocking…",
    rememberUnlock: "Remember unlock",
    switchAccount: "Switch account",
    // Captcha
    captchaHint: "Proton requires verification. Complete the challenge in the window that opened.",
    captchaMethods: "Methods:",
    // Main view
    logout: "Log out",
    syncingItems: (n: number) => `Syncing ${n} item(s)…`,
    syncIdle: "Running — sync engine active",
    localFolder: "Local folder:",
    driveFolder: "Drive folder:",
    errors: "Errors:",
    syncedFiles: "Synced files",
    noFiles: "No files registered in the database yet.",
    settings: "Settings",
    autostart: "Start on login",
    autostartHint: "Start Proton Drive Sync automatically when you log in to GNOME.",
    on: "On",
    off: "Off",
    localChanges: "Local file changes (inotify)",
    noChanges: "No changes detected yet.",
    darkMode: "Dark",
    lightMode: "Light",
    langToggle: "NO",
  },
} as const;

interface LangContextValue {
  lang: Lang;
  t: Translations;
  toggleLang: () => void;
}

const LangContext = createContext<LangContextValue>({
  lang: "no",
  t: T.no,
  toggleLang: () => {},
});

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const stored = localStorage.getItem("lang") as Lang | null;
    if (stored === "no" || stored === "en") return stored;
    return navigator.language.startsWith("no") ? "no" : "en";
  });

  const toggleLang = () =>
    setLang((l) => {
      const next: Lang = l === "no" ? "en" : "no";
      localStorage.setItem("lang", next);
      return next;
    });

  return (
    <LangContext.Provider value={{ lang, t: T[lang], toggleLang }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
