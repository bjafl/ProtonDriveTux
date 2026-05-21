# PLAN — Proton Drive Linux Sync Client

Fra nåværende Tauri v2-skjelett til fungerende beta.
Opprettet: 2026-05-19

---

## Milepæler

| Fase | Mål | Status |
|------|-----|--------|
| 0 | Tauri shell: tray, inotify, konfig | ✅ |
| 1 | SRP-innlogging + GNOME Keyring | ✅ |
| 2 | JS SDK integrert, fil-transfer fungerer | 🔄 |
| 3 | Bi-direksjonell sync-motor | 🔲 |
| 4 | UI, notifications, autostart, AppImage | 🔲 |

---

## Fase 0 — Tauri shell

**Mål:** Kjørbar app med tray-ikon og bevist inotify-pipeline.

### 0.1 Konfigurer appen
- [x] `tauri.conf.json`: rename `productName` → `Proton Drive Sync`, `identifier` → `net.flode.proton-drive-sync`
- [x] `.env.local`: `PROTON_APP_VERSION=external-drive-protondrive_linux@0.1.0-alpha`

### 0.2 System tray
- [x] `tauri = { version = "2", features = ["tray-icon"] }` i Cargo.toml
- [x] `lib.rs`: opprett tray-ikon ved oppstart med meny: **Åpne**, **Avslutt**
- [x] Lukke vinduet → skjul til tray (ikke kill prosessen)
- [x] `--minimized` CLI-flag: start uten å vise vinduet

### 0.3 inotify smoke test
- [x] Legg til `notify = "6"` i Cargo.toml
- [x] Opprett `src-tauri/src/watcher.rs`: watch `~/ProtonDrive` med `RecommendedWatcher`
- [x] Debounce events 300 ms (samle rask skriving til én event)
- [x] Emit Tauri-event `sync://local-change` med path til frontend
- [x] `lib.rs`: start watcher i bakgrunnen ved oppstart
- [x] Frontend: vis siste mottatte event i UI (smoke test-visning)

**Avhengigheter:** ingen
**Blokkerer:** Fase 1

---

## Fase 1 — SRP-autentisering + Keyring

**Mål:** Bruker kan logge inn med Proton-konto. Tokens lagres i GNOME Keyring.

### 1.1 SRP-implementasjon (Rust)
- [ ] Legg til `srp`, `sha2`, `bcrypt`, `num-bigint` i Cargo.toml
- [ ] Opprett `src-tauri/src/auth.rs`:
  - `GET /auth/info?Username={user}` → hent salt, server_ephemeral, srpSession
  - Beregn SRP client proof (bcrypt-salt + SHA-512)
  - `POST /auth` → access_token, refresh_token, UID
  - `POST /auth/2fa` hvis TOTP aktivert
- [ ] Alle requests setter `x-pm-appversion`-header (fra env)
- [ ] Legg til `reqwest` (async HTTP) i Cargo.toml

### 1.2 GNOME Keyring
- [ ] Legg til `secret-service` crate i Cargo.toml
- [ ] Opprett `src-tauri/src/keyring.rs`:
  - `store_session(uid, access_token, refresh_token)`
  - `load_session()` → `Option<Session>`
  - `clear_session()`
- [ ] Token refresh: if 401, prøv refresh endpoint, oppdater keyring

### 1.3 IPC-kommandoer (auth)
- [ ] Opprett `src-tauri/src/commands.rs`:
  - `login(username, password, totp?) -> Result<(), AuthError>`
  - `logout() -> Result<(), AuthError>`
  - `get_auth_status() -> AuthStatus` (`LoggedIn` | `LoggedOut`)
- [ ] Registrer i `generate_handler!`

### 1.4 Login UI
- [ ] Opprett `src/components/LoginForm.tsx`: brukernavn, passord, valgfri TOTP
- [ ] Vis tydelig: _"Dette er en uoffisiell tredjepartsapp ikke støttet av Proton."_
- [ ] Håndter feil: feil passord, 2FA påkrevd, nettverksfeil

**Avhengigheter:** Fase 0
**Blokkerer:** Fase 2

---

## Fase 2 — JS SDK-integrasjon

**Mål:** SDK initialisert og fil kan lastes opp/ned manuelt.

### 2.1 Bygg og wire SDK
- [x] Bygg SDK: `cd ../sdk/js/sdk && npm install && npm run build`
- [x] Legg til SDK som lokal dependency i `package.json`:
  ```json
  "@protontech/drive-sdk": "file:../sdk/js/sdk"
  ```
- [x] Installer `@protontech/crypto` (peer dependency)

### 2.2 HTTP-klient wrapper
- [x] Opprett `src/lib/httpClient.ts`: implementer `ProtonDriveHTTPClient`
  - Setter `x-pm-appversion`-header på alle requests
  - Setter `Authorization: Bearer {access_token}` fra session
  - `fetchJson` og `fetchBlob` med timeout og AbortSignal-støtte

### 2.3 Account provider
- [x] Opprett `src/lib/accountProvider.ts`: implementer `ProtonDriveAccount`
  - `getOwnPrimaryAddress()`: kall `/core/v4/addresses` med session tokens
  - `getOwnAddresses()`: alle adresser
  - `getOwnAddress(emailOrId)`: filtrer
  - `hasProtonAccount(email)`: kall `/core/v4/users/available` eller lignende
  - `getPublicKeys(email)`: kall `/core/v4/keys?Email={email}`
  - Dekrypter adressenøkler med key_password (avledet fra user password + key salt)

### 2.4 Crypto-modul
- [x] Opprett `src/lib/cryptoModule.ts`: init `CryptoProxy` fra `@protontech/crypto`
  - Bruker `Api` (direkte, ikke WebWorker) — passende for Tauri WebView
  - Opprett `src/lib/srpModule.ts`: implementer `SRPModule` via `@protontech/crypto/srp`

### 2.5 SDK-wrapper (drive.ts)
- [x] Opprett `src/lib/drive.ts`: **alt SDK-kall skjer herfra**
  - `initDriveClient(session)` → `ProtonDriveClient`
  - `deriveKeyPassword(password, accessToken, uid)` → kaller `/core/v4/keys/salts`
  - `subscribeToDriveEvents(listener)` → `EventSubscription`
  - `getSyncRoot()`, `listFolderChildren()`, `getFileUploader()`, `getFileDownloader()`
- [x] Login-flyt returnerer `{uid, accessToken}` fra Rust → JS avleder `keyPassword`
- [x] Unlock-skjerm ved session-restore fra keyring (passord re-innskrives)

### 2.6 Smoke test upload/download
- [ ] Legg til en "Test opplasting"-knapp i UI
- [ ] Last opp en liten testfil til rot-mappen
- [ ] Last ned igjen og verifiser innhold

**Avhengigheter:** Fase 1
**Blokkerer:** Fase 3

---

## Fase 3 — Bi-direksjonell sync-motor

**Mål:** Endringer i lokal mappe synkroniseres automatisk, og remote-endringer lastes ned.

### 3.1 SQLite state-database
- [ ] Legg til `rusqlite` i Cargo.toml
- [ ] Opprett `src-tauri/src/db.rs`:
  - Opprett tabeller `files` og `sync_config` (se CLAUDE.md for schema)
  - `upsert_file(remote_id, local_path, etag, size, state)`
  - `get_file_by_remote_id(id)`, `get_file_by_local_path(path)`
  - `set_sync_config(key, value)`, `get_sync_config(key)`
  - `get_pending_uploads()`, `get_pending_downloads()`

### 3.2 Sync-motor (sync.rs)
- [ ] Opprett `src-tauri/src/sync.rs`:
  - `SyncEngine` struct med `AppHandle`, DB-referanse, mpsc-kanal
  - Lokal→remote flyt:
    1. Mottar `LocalChange` fra watcher (debounced)
    2. Sjekk mot DB: ny fil, endret eller slettet?
    3. Les fil → send til `drive.ts` via IPC → upload
    4. Oppdater DB: `sync_state = synced`, lagre `etag`
  - Remote→lokal flyt:
    1. Mottar `DriveEvent` fra SDK (`NodeCreated`, `NodeUpdated`, `NodeDeleted`)
    2. Sammenlign `etag` mot DB
    3. Dersom endret: last ned via SDK, skriv til lokal sti
    4. Oppdater DB

### 3.3 Event-bro Rust ↔ JS
- [ ] IPC-kommando: `start_sync(local_root: String) -> Result<(), SyncError>`
- [ ] IPC-kommando: `stop_sync()`
- [ ] IPC-kommando: `get_sync_status() -> SyncStatus`
- [ ] Tauri-event `sync://status-changed` → frontend oppdaterer UI
- [ ] Tauri-event `sync://error` → frontend viser feilmelding

### 3.4 Konfliktdeteksjon (v1: last-write-wins)
- [ ] Hvis lokal og remote er endret siden siste sync: velg nyeste `modified_at`
- [ ] Sett `sync_state = conflict` i DB (logg, men fortsett)
- [ ] Dokumenter som kjent begrensning

### 3.5 Feilhåndtering og retry
- [ ] Nettverksfeil: exponential backoff (1s, 2s, 4s, max 60s)
- [ ] Persistent feil (3 forsøk): sett `sync_state = error`, emit event til UI
- [ ] Rate limiting (429): respekter `Retry-After`-header

**Avhengigheter:** Fase 2
**Blokkerer:** Fase 4

---

## Fase 4 — UI, notifications, autostart

**Mål:** Polert brukeropplevelse, klar for beta-distribusjon.

### 4.1 Status-UI
- [ ] Opprett `src/components/SyncStatus.tsx`:
  - Viser: synkroniserer / oppdatert / feil / pauset
  - Liste over siste sync-hendelser (n siste)
  - Knapp: Pause / Fortsett sync

### 4.2 Innstillinger
- [ ] Opprett `src/components/Settings.tsx`:
  - Velg lokal sync-mappe (fil-dialog via `tauri-plugin-dialog`)
  - Vis konto-info (e-post, lagringsforbruk)
  - Logg ut

### 4.3 Desktop-notifikasjoner
- [ ] Legg til `notify-rust` i Cargo.toml
- [ ] Notifiser ved: fullført opplasting av stor fil (>10 MB), sync-feil, konflikter

### 4.4 Autostart
- [ ] Opprett `~/.config/autostart/proton-drive-sync.desktop` ved første oppstart
- [ ] Start med `--minimized` flag

### 4.5 AppImage-bygg
- [ ] Verifiser `cargo tauri build` → AppImage genereres
- [ ] Test installasjon på ren Ubuntu 22.04
- [ ] Dokumenter avhengigheter: `libayatana-appindicator3-1`, `libwebkit2gtk-4.1`

**Avhengigheter:** Fase 3

---

## Tekniske noter

### Kritiske avhengigheter (Cargo.toml)
```toml
notify = "6"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
rusqlite = { version = "0.31", features = ["bundled"] }
secret-service = "3"
notify-rust = "4"
thiserror = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### SDK breaking change (slutten 2026/tidlig 2027)
Ny crypto-modell kommer. All SDK-kontakt isolert i `src/lib/drive.ts` — oppdatering krever bare endringer der.

### GNOME tray
Krever `gnome-shell-extension-appindicator` (Ubuntu: installert som standard fra 22.04).
Fallback: vis statusvindu dersom tray ikke tilgjengelig.

### Sikkerhet
- Aldri lagre passord — kun session tokens i keyring
- SRP: følg WebClients-implementasjonen nøye, ikke improviser krypto
- `x-pm-appversion` settes alltid: `external-drive-protondrive_linux@{ver}-alpha`
