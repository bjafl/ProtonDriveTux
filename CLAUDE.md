# CLAUDE.md — Proton Drive Linux Sync Client

## Prosjektformål

Uoffisiell, ikke-kommersiell Proton Drive sync-klient for Linux (Ubuntu/GNOME-fokus), bygget med Tauri v2. Målet er en fungerende prototype som synkroniserer en lokal mappe mot Proton Drive med end-to-end-kryptering ivaretatt av Protons egne SDK.

Proton har varslet offisiell Linux-klient, men den er ikke ute ennå (mai 2026). Dette prosjektet fyller gapet og fungerer som læringsprosjekt for Tauri + Linux desktop-integrasjon.

---

## Repostruktur

```
protondrive-linux-client/   ← prosjektrot
├── CLAUDE.md
├── src-tauri/              ← Rust/Tauri backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         ← Tauri app entry point
│       ├── auth.rs         ← SRP-autentisering mot Proton API
│       ├── watcher.rs      ← inotify via notify-crate
│       ├── sync.rs         ← sync-motor, kø-system
│       ├── db.rs           ← SQLite state-database
│       ├── keyring.rs      ← GNOME Keyring via zbus
│       └── commands.rs     ← Tauri IPC commands
├── src/                    ← React/TypeScript frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   └── lib/
│       └── drive.ts        ← Wrapper rundt Proton Drive JS SDK
└── vendor/
    └── sdk/                ← Proton Drive SDK (git submodule, read-only)
        ├── js/             ← TypeScript SDK — primær integrasjon
        ├── cs/             ← C# SDK (referanse)
        ├── kt/             ← Kotlin (referanse)
        └── swift/          ← Swift (referanse)
```

---

## SDK-integrasjon

SDKen er inkludert som en **git submodule** under `vendor/sdk/` og skal **ikke** modifiseres.
Klon med `git clone --recurse-submodules`, eller kjør `git submodule update --init --recursive`
etter en vanlig clone. Bygg SDKen én gang med `cd vendor/sdk/js/sdk && npm install && npm run build`.

### JS SDK (primær)
- Plassering: `vendor/sdk/js/sdk/`
- Brukes i React/TypeScript-laget (Tauri WebView)
- Håndterer all Drive-logikk: kryptering, filopplasting/-nedlasting, mappestruktur
- Referert via `file:./vendor/sdk/js/sdk` i `package.json`

```jsonc
// tsconfig.json paths
{
  "compilerOptions": {
    "paths": {
      "@proton/drive-sdk": ["./vendor/sdk/js/packages/sdk/lib"]
    }
  }
}
```

### Prosedyre: oppdater SDK-submodulen

Kjør denne prosedyren når brukeren ber om å sjekke/oppdatere SDKen.

#### Steg 1 — finn nye commits

```bash
# Hent oppdateringer uten å endre noe
git -C vendor/sdk fetch origin

# Vis commits siden nåværende pin (SHA vises i .gitmodules-commit)
CURRENT=$(git submodule status vendor/sdk | awk '{print $1}' | tr -d +-) 
git -C vendor/sdk log "$CURRENT..origin/HEAD" --oneline
```

Hvis ingen nye commits: meld fra og stopp.

#### Steg 2 — analyser endringene

For hver commit siden pinnen:

```bash
# Se hvilke filer som er endret
git -C vendor/sdk show <sha> --name-only

# Se diff for JS SDK-koden (eneste vi bruker)
git -C vendor/sdk show <sha> -- "js/sdk/src/"
```

**Vurder risiko per commit:**

| Hva er endret | Risiko |
|---------------|--------|
| Kun `cs/`, `kt/`, `swift/`, `CHANGELOG.md` | Ingen — vi bruker bare JS |
| `js/sdk/src/internal/` | Lav — intern refactor, sjekk om eksportert API er intakt |
| `js/sdk/src/index.ts` eller re-eksporter | Høy — endring i public API |
| Eksisterende eksportert funksjon/type fjernet eller signatur endret | **Breaking** |
| Ny valgfri parameter på funksjon vi kaller | Ikke-breaking |
| Obligatorisk parameter lagt til | **Breaking** |
| Felt gjort `optional` som var påkrevd (eller omvendt) | Potensielt breaking |

**Våre SDK-inngangspunkter** (det eneste som er relevant å sjekke):
```
ProtonDriveClient — konstruktør-options
getDriveClient().getNode()
getDriveClient().listFolderChildren()
getDriveClient().subscribeToTreeEvents()
getDriveClient().getFileUploader()          — metadata: { mediaType, expectedSize, modificationTime? }
getDriveClient().getFileRevisionUploader()  — metadata: samme
getDriveClient().getFileDownloader()
getDriveClient().trashNodes()
getDriveClient().createFolder() / findOrCreateFolder()
```
Alle kall er isolert i `src/lib/drive.ts` — kun den filen trenger å endres ved API-brudd.

#### Steg 3 — sjekk npm-avhengigheter i SDKen

```bash
# Har package.json endret seg siden pinnen?
git -C vendor/sdk diff "$CURRENT..origin/HEAD" -- js/sdk/package.json
```

Merk **dependencies** og **devDependencies** separat:
- Ny/endret **dependency**: `npm install` er nødvendig etter checkout.
- Ny/endret **devDependency**: bare relevant for bygging; `npm install` er fortsatt nok.
- Endring i **build-scriptet** (`scripts.build`): bruk det nye scriptet, ikke hardkodet `tsc`.

#### Steg 4 — rapporter og spør brukeren

Presenter et sammendrag:

```
Fant N nye commits siden <gammel-sha>:
  - <sha> <tittel>  [ingen JS-endring / lav risiko / BREAKING]
  - ...

JS-avhengigheter endret: ja/nei
Brudd på våre API-kall: ja/nei — [detaljer]
```

Spør deretter:
- Hvis **ingen breaking changes**: «Ser trygt ut. Skal jeg oppdatere submodulen?»
- Hvis **breaking changes**: beskriv hva som brytes og foreslå konkrete endringer i
  `src/lib/drive.ts` (og evt. `src/lib/sync.ts`). Spør om brukeren vil gå videre med
  oppdateringen og fikse koden, eller vente.
- Hvis usikkert: beskriv usikkerheten og la brukeren bestemme.

#### Steg 5 — utfør oppdateringen (kun etter brukerens godkjenning)

```bash
# 1. Gå til ny commit
NEW_SHA=$(git -C vendor/sdk rev-parse origin/HEAD)
git -C vendor/sdk checkout "$NEW_SHA"

# 2. Installer npm-avhengigheter (alltid trygt, nødvendig hvis deps endret)
cd vendor/sdk/js/sdk
npm install

# 3. Bygg SDKen — bruk build:ci for ren bygg hvis deps ble endret, ellers build
npm run build          # eller: npm run build:ci
cd ../../../..

# 4. Oppdater prosjektets avhengigheter (plukker opp evt. endringer i dist/)
pnpm install

# 5. Typesjekk + tester
pnpm tsc --noEmit
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Hvis typesjekk feiler pga. breaking API-endringer: implementer de avtalte rettelsene
i `src/lib/drive.ts` (og evt. `src/lib/sync.ts`) og kjør testene på nytt.

#### Steg 6 — commit

```bash
git add vendor/sdk pnpm-lock.yaml   # legg til src/lib/drive.ts m.fl. hvis endret
git commit -m "chore(sdk): advance submodule to <ny-sha-kort>

<liste over commits siden forrige pin, med risikovurdering>
<«No changes required» eller beskriv hva som ble fikset>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

#### Fallback: rulle tilbake

Hvis noe går galt etter oppdatering:
```bash
git -C vendor/sdk checkout <gammel-sha>
cd vendor/sdk/js/sdk && npm run build && cd ../../../..
pnpm install
git checkout vendor/sdk   # tilbakestill staged endring
```

---

### Viktige SDK-begrensninger
- SDKen er **ikke produksjonsklar** — breaking changes vil komme (ny crypto-modell)
- SDKen inkluderer **ikke** autentisering, session management eller adresse-provider — dette implementeres selv
- Direkte API-kall forbi SDKen er **ikke tillatt** per Protons bruksvilkår
- Synkronisering skal skje via **Drive events** — ikke polling eller rekursiv traversering

### Påkrevd HTTP-header
Alle requests via SDK må sette:
```
x-pm-appversion: external-drive-protondrive-linux@{version}-alpha
```

---

## Arkitektur

```
┌─────────────────────────────────────────┐
│  React + TypeScript (Tauri WebView)     │
│  - Login UI, statusvisning, innstillinger│
│  - Proton Drive JS SDK                  │
│  - VolumeEventChannel (server events)   │
├─────────────────────────────────────────┤
│  Tauri IPC (invoke / emit)              │
├─────────────────────────────────────────┤
│  Rust (Tauri backend)                   │
│  - notify crate → inotify watcher       │
│  - tokio::sync::mpsc event queue        │
│  - SQLite state-database (rusqlite)     │
│  - zbus → GNOME Keyring (credentials)   │
│  - notify-rust → desktop notifications  │
└─────────────────────────────────────────┘
```

### Dataflyt — lokal → remote
1. `notify`-watcher (Rust) detekterer filendring via inotify
2. Event debounces 300 ms og legges i `mpsc`-kanal
3. Tauri emitter sender event til WebView: `sync://local-change`
4. JS SDK krypterer og laster opp filen
5. SQLite oppdateres med ny `etag` og `sync_state = synced`

### Dataflyt — remote → lokal
1. `VolumeEventChannel` (JS SDK) mottar server-side event
2. Sammenlign mot SQLite-state
3. Last ned og dekrypter endrede filer
4. Skriv til lokal sync-mappe
5. Oppdater SQLite

---

## Teknisk stack

| Lag | Teknologi | Versjon |
|-----|-----------|---------|
| Desktop shell | Tauri | v2 |
| Backend | Rust + Tokio | stable |
| Frontend | React + TypeScript | 18 / 5 |
| Styling | Tailwind CSS + shadcn/ui | v4 / latest |
| Drive SDK | Proton Drive JS SDK | `../sdk/js` |
| Filmonitorering | `notify` crate | 6.x |
| Local state | SQLite via `rusqlite` | 0.31.x |
| Credentials | `zbus` + freedesktop secrets | 4.x |
| Notifications | `notify-rust` | 4.x |
| Pakkeformat | AppImage (v1), Flatpak (v2) | — |

---

## Autentisering

Proton bruker **SRP (Secure Remote Password)** — passord sendes aldri i klartekst.

### Flyt
```
1. GET  /auth/info?Username={user}   → salt, server_ephemeral, srpSession
2. Beregn SRP client proof lokalt (bcrypt + SHA512)
3. POST /auth                        → access_token, refresh_token, UID
4. POST /auth/2fa  (hvis aktivert)   → TOTP-kode
5. Lagre tokens i GNOME Keyring
```

### Referanseimplementasjoner
- `ProtonDriveApps/WebClients` — TypeScript SRP-implementasjon
- `ProtonDriveApps/sdk-tech-demo` — C# referanse med `ProtonApiSession`
- Aldri lagre passord — kun session tokens i keyring

---

## SQLite state-schema

```sql
CREATE TABLE files (
    remote_id     TEXT PRIMARY KEY,
    local_path    TEXT NOT NULL,
    etag          TEXT,
    modified_at   INTEGER,          -- Unix timestamp
    size_bytes    INTEGER,
    sync_state    TEXT NOT NULL      -- 'synced' | 'pending_upload' | 'pending_download' | 'conflict' | 'error'
);

CREATE TABLE sync_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
    -- 'local_root', 'volume_id', 'last_event_anchor', etc.
);
```

---

## Linux-integrasjon

### GNOME Keyring (credentials)
```rust
// zbus-kall mot org.freedesktop.secrets
// Bruk 'secret-service' crate som wrapper
```

### Autostart
```ini
# ~/.config/autostart/protondrive-linux.desktop
[Desktop Entry]
Type=Application
Name=Proton Drive
Exec=/opt/protondrive-linux/protondrive-linux --minimized
Hidden=false
X-GNOME-Autostart-enabled=true
```

### System tray
GNOME fjernet native tray-støtte. Krever `gnome-shell-extension-appindicator` eller `ubuntu-appindicator`. Dokumenter som kjent begrensning. Tauri bruker `tray-icon` + `libayatana-appindicator`.

---

## Kjente begrensninger og risikoer

- **SDK breaking change er varslet** — Proton vil introdusere ny crypto-modell. Abstraher alle SDK-kall bak `src/lib/drive.ts` slik at oppdatering er isolert.
- **SRP-implementasjon er kompleks** — følg WebClients-repoet nøye, ikke improviser krypto.
- **rclone er bevisst ikke brukt** — ustabilt og blokkeres av Proton periodvis.
- **GNOME tray** krever extension installert — fallback til statusvindu ved manglende support.
- **Kun personlig, ikke-kommersiell bruk** — Protons SDK-vilkår forbyr kommersiell bruk uten avtale.
- **Konfliktløsning er ikke implementert i v1** — siste-skriving-vinner ved kollisjon.

---

## Utviklingsmiljø

```bash
# Forutsetninger
rustup toolchain install stable
cargo install tauri-cli
pnpm install

# Utvikling
cargo tauri dev

# Bygg AppImage
cargo tauri build

# Kjør Rust-tester
cargo test

# Kjør TypeScript-tester
pnpm test
```

### Miljøvariabler (`.env.local`)
```
PROTON_API_BASE=https://api.proton.me
PROTON_APP_VERSION=external-drive-protondrive-linux@0.1.0-alpha
```

---

## Fasestatus

| Fase | Beskrivelse | Status |
|------|-------------|--------|
| 0 | Tauri shell, tray, inotify-test | ⬜ Ikke startet |
| 1 | SRP-autentisering + Keyring | ⬜ Ikke startet |
| 2 | JS SDK-integrasjon, fil-transfer | ⬜ Ikke startet |
| 3 | Sync-motor (bi-direksjonell) | ⬜ Ikke startet |
| 4 | UI, autostart, notifications | ⬜ Ikke startet |

---

## Referanser

- [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) — `../sdk/`
- [sdk-tech-demo](https://github.com/ProtonDriveApps/sdk-tech-demo) — C# auth-referanse
- [WebClients](https://github.com/ProtonMail/WebClients) — SRP TypeScript-implementasjon
- [Tauri v2 docs](https://v2.tauri.app)
- [Proton API](https://proton.me/blog/proton-drive-sdk-preview) — SDK preview-bloggpost
- [protondrive-linux (DonnieDice)](https://github.com/donniedice/protondrive-linux) — eksisterende uoffisiell klient (rclone-basert)