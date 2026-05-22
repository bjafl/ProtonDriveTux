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
  // Onboarding
  onboardingWelcomeTitle: string;
  onboardingWelcomeBody: string;
  onboardingLocalRootTitle: string;
  onboardingLocalRootHint: string;
  onboardingLocalRootBrowse: string;
  onboardingLocalRootNonEmptyWarning: (count: number) => string;
  onboardingFolderSelectTitle: string;
  onboardingFolderSelectHint: string;
  onboardingStartSync: string;
  onboardingNext: string;
  onboardingBack: string;
  // Local root validation errors
  localRootUnderHome: string;
  localRootIsHome: string;
  localRootIsSystemDir: string;
  // Folder tree
  folderTreeLoading: string;
  folderTreeEmpty: string;
  // Conflict wizard
  conflictTitle: string;
  conflictSubtitle: (count: number) => string;
  conflictColName: string;
  conflictColLocalSize: string;
  conflictColLocalDate: string;
  conflictColRemoteSize: string;
  conflictColRemoteDate: string;
  conflictColKeep: string;
  conflictKeepLocal: string;
  conflictKeepRemote: string;
  conflictBulkNewest: string;
  conflictBulkLargest: string;
  conflictBulkAllLocal: string;
  conflictConfirm: string;
  // Settings
  changeSyncSettings: string;
  notConfigured: string;
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
    // Onboarding
    onboardingWelcomeTitle: "Velkommen til Proton Drive Sync",
    onboardingWelcomeBody: "La oss sette opp synkronisering. Du velger hvilken lokal mappe og hvilke Drive-mapper som skal synkroniseres.",
    onboardingLocalRootTitle: "Velg lokal synkmappe",
    onboardingLocalRootHint: "Filer fra Drive lastes ned hit. Mappen opprettes automatisk hvis den ikke finnes.",
    onboardingLocalRootBrowse: "Bla gjennom…",
    onboardingLocalRootNonEmptyWarning: (count: number) => `Mappen inneholder ${count} fil(er). Eksisterende filer slås sammen med Drive-innholdet.`,
    onboardingFolderSelectTitle: "Velg Drive-mapper å synkronisere",
    onboardingFolderSelectHint: "Klikk på ○ for å velge. ● = bare direkte filer, ⬤ = inkluder undermapper. Du kan fortsette uten å velge noen.",
    onboardingStartSync: "Start synkronisering →",
    onboardingNext: "Neste →",
    onboardingBack: "← Tilbake",
    // Local root validation errors
    localRootUnderHome: "Mappen må ligge inne i hjemmemappen din.",
    localRootIsHome: "Du kan ikke synkronisere direkte inn i hjemmemappen.",
    localRootIsSystemDir: "Systemmappe kan ikke brukes.",
    // Folder tree
    folderTreeLoading: "Laster Drive-mapper…",
    folderTreeEmpty: "Ingen mapper funnet.",
    // Conflict wizard
    conflictTitle: "Løs filkonflikter",
    conflictSubtitle: (count: number) => `${count} fil(er) finnes både lokalt og på Drive med ulikt innhold.`,
    conflictColName: "Fil",
    conflictColLocalSize: "Lokal størrelse",
    conflictColLocalDate: "Lokal dato",
    conflictColRemoteSize: "Drive størrelse",
    conflictColRemoteDate: "Drive dato",
    conflictColKeep: "Behold",
    conflictKeepLocal: "Lokal",
    conflictKeepRemote: "Drive",
    conflictBulkNewest: "Behold nyeste",
    conflictBulkLargest: "Behold størst",
    conflictBulkAllLocal: "Behold alle lokale",
    conflictConfirm: "Bekreft og fortsett",
    // Settings
    changeSyncSettings: "Endre synkinnstillinger",
    notConfigured: "Ikke konfigurert",
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
    // Onboarding
    onboardingWelcomeTitle: "Welcome to Proton Drive Sync",
    onboardingWelcomeBody: "Let's set up synchronization. You'll choose a local folder and which Drive folders to sync.",
    onboardingLocalRootTitle: "Choose local sync folder",
    onboardingLocalRootHint: "Drive files will be downloaded here. The folder will be created automatically if it doesn't exist.",
    onboardingLocalRootBrowse: "Browse…",
    onboardingLocalRootNonEmptyWarning: (count: number) => `This folder contains ${count} file(s). Existing files will be merged with your Drive content.`,
    onboardingFolderSelectTitle: "Choose Drive folders to sync",
    onboardingFolderSelectHint: "Click ○ to select. ● = direct files only, ⬤ = include subfolders. You can continue without selecting any.",
    onboardingStartSync: "Start Sync →",
    onboardingNext: "Next →",
    onboardingBack: "← Back",
    // Local root validation errors
    localRootUnderHome: "Folder must be inside your home directory.",
    localRootIsHome: "You cannot sync directly into your home directory.",
    localRootIsSystemDir: "System directories cannot be used.",
    // Folder tree
    folderTreeLoading: "Loading Drive folders…",
    folderTreeEmpty: "No folders found.",
    // Conflict wizard
    conflictTitle: "Resolve file conflicts",
    conflictSubtitle: (count: number) => `${count} file(s) exist both locally and on Drive with different content.`,
    conflictColName: "File",
    conflictColLocalSize: "Local size",
    conflictColLocalDate: "Local date",
    conflictColRemoteSize: "Drive size",
    conflictColRemoteDate: "Drive date",
    conflictColKeep: "Keep",
    conflictKeepLocal: "Local",
    conflictKeepRemote: "Drive",
    conflictBulkNewest: "Keep newest",
    conflictBulkLargest: "Keep largest",
    conflictBulkAllLocal: "Keep all local",
    conflictConfirm: "Confirm & continue",
    // Settings
    changeSyncSettings: "Change sync settings",
    notConfigured: "Not configured",
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
