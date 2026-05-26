/**
 * Raw translation strings — no React imports, fully testable in node.
 */

export type Lang = "no" | "en";

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
  syncNow: string;
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
  onboardingRootLabel: string;
  onboardingRootNone: string;
  onboardingRootFiles: string;
  onboardingRootAll: string;
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
  // Form validation
  validationInvalidEmail: string;
  validationRequired: string;
  validationTotpCode: string;
  // Settings
  changeSyncSettings: string;
  notConfigured: string;
  // Pause / resume
  pauseSync: string;
  resumeSync: string;
};

export const T: Record<Lang, Translations> = {
  no: {
    appName: "Proton Drive Sync",
    loading: "Laster…",
    disclaimer: "Uoffisiell tredjepartsapp — ikke støttet av Proton.",
    unofficialBanner: "Dette er en uoffisiell tredjepartsapp ikke offisielt støttet av Proton.",
    username: "Brukernavn",
    password: "Passord",
    loginBtn: "Logg inn",
    loggingIn: "Logger inn…",
    totp: "Engangskode (2FA)",
    confirmBtn: "Bekreft",
    back: "← Tilbake",
    mailboxPassword: "Postboks-passord",
    mailboxHint: "Kontoen din bruker separat postboks-passord. Skriv inn postboks-passordet for å låse opp krypteringsnøkler.",
    unlockHint: "Skriv inn passordet ditt for å låse opp Drive-tilgang.",
    unlockBtn: "Lås opp",
    unlocking: "Låser opp…",
    rememberUnlock: "Husk opplåsing",
    switchAccount: "Bytt konto",
    captchaHint: "Proton krever verifisering. Fullfør utfordringen i vinduet som åpnet seg.",
    captchaMethods: "Metoder:",
    logout: "Logg ut",
    syncingItems: (n: number) => `Synkroniserer ${n} element(er)…`,
    syncIdle: "Kjører — sync-motor aktiv",
    syncNow: "Synk nå",
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
    onboardingWelcomeTitle: "Velkommen til Proton Drive Sync",
    onboardingWelcomeBody: "La oss sette opp synkronisering. Du velger hvilken lokal mappe og hvilke Drive-mapper som skal synkroniseres.",
    onboardingLocalRootTitle: "Velg lokal synkmappe",
    onboardingLocalRootHint: "Filer fra Drive lastes ned hit. Mappen opprettes automatisk hvis den ikke finnes.",
    onboardingLocalRootBrowse: "Bla gjennom…",
    onboardingLocalRootNonEmptyWarning: (count: number) => `Mappen inneholder ${count} fil(er). Eksisterende filer slås sammen med Drive-innholdet.`,
    onboardingFolderSelectTitle: "Velg Drive-mapper å synkronisere",
    onboardingFolderSelectHint: "Klikk på ○ for å velge. ● = bare direkte filer, ⬤ = inkluder undermapper. Du kan fortsette uten å velge noen.",
    onboardingRootLabel: "Min Disk (rot):",
    onboardingRootNone: "Ingen",
    onboardingRootFiles: "Bare filer",
    onboardingRootAll: "Alt",
    onboardingStartSync: "Start synkronisering →",
    onboardingNext: "Neste →",
    onboardingBack: "← Tilbake",
    localRootUnderHome: "Mappen må ligge inne i hjemmemappen din.",
    localRootIsHome: "Du kan ikke synkronisere direkte inn i hjemmemappen.",
    localRootIsSystemDir: "Systemmappe kan ikke brukes.",
    folderTreeLoading: "Laster Drive-mapper…",
    folderTreeEmpty: "Ingen mapper funnet.",
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
    validationInvalidEmail: "Ugyldig e-postadresse",
    validationRequired: "Kan ikke være tomt",
    validationTotpCode: "Skriv inn en gyldig kode (maks 6 siffer)",
    changeSyncSettings: "Endre synkinnstillinger",
    notConfigured: "Ikke konfigurert",
    pauseSync: "Sett på pause",
    resumeSync: "Gjenoppta",
  },
  en: {
    appName: "Proton Drive Sync",
    loading: "Loading…",
    disclaimer: "Unofficial third-party app — not supported by Proton.",
    unofficialBanner: "This is an unofficial third-party app not officially supported by Proton.",
    username: "Username",
    password: "Password",
    loginBtn: "Log in",
    loggingIn: "Logging in…",
    totp: "One-time code (2FA)",
    confirmBtn: "Confirm",
    back: "← Back",
    mailboxPassword: "Mailbox password",
    mailboxHint: "Your account uses a separate mailbox password. Enter it to unlock your encryption keys.",
    unlockHint: "Enter your password to unlock Drive access.",
    unlockBtn: "Unlock",
    unlocking: "Unlocking…",
    rememberUnlock: "Remember unlock",
    switchAccount: "Switch account",
    captchaHint: "Proton requires verification. Complete the challenge in the window that opened.",
    captchaMethods: "Methods:",
    logout: "Log out",
    syncingItems: (n: number) => `Syncing ${n} item(s)…`,
    syncIdle: "Running — sync engine active",
    syncNow: "Sync now",
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
    onboardingWelcomeTitle: "Welcome to Proton Drive Sync",
    onboardingWelcomeBody: "Let's set up synchronization. You'll choose a local folder and which Drive folders to sync.",
    onboardingLocalRootTitle: "Choose local sync folder",
    onboardingLocalRootHint: "Drive files will be downloaded here. The folder will be created automatically if it doesn't exist.",
    onboardingLocalRootBrowse: "Browse…",
    onboardingLocalRootNonEmptyWarning: (count: number) => `This folder contains ${count} file(s). Existing files will be merged with your Drive content.`,
    onboardingFolderSelectTitle: "Choose Drive folders to sync",
    onboardingFolderSelectHint: "Click ○ to select. ● = direct files only, ⬤ = include subfolders. You can continue without selecting any.",
    onboardingRootLabel: "My Drive (root):",
    onboardingRootNone: "None",
    onboardingRootFiles: "Files only",
    onboardingRootAll: "All",
    onboardingStartSync: "Start Sync →",
    onboardingNext: "Next →",
    onboardingBack: "← Back",
    localRootUnderHome: "Folder must be inside your home directory.",
    localRootIsHome: "You cannot sync directly into your home directory.",
    localRootIsSystemDir: "System directories cannot be used.",
    folderTreeLoading: "Loading Drive folders…",
    folderTreeEmpty: "No folders found.",
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
    validationInvalidEmail: "Invalid email address",
    validationRequired: "Can't be blank",
    validationTotpCode: "Enter a valid code (max 6 digits)",
    changeSyncSettings: "Change sync settings",
    notConfigured: "Not configured",
    pauseSync: "Pause sync",
    resumeSync: "Resume sync",
  },
} as const;
