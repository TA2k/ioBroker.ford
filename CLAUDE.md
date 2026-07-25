# ioBroker Ford Adapter - Entwicklungsnotizen

## Aktuelle Architektur (2026-07-25): Offizielle FordConnect Query API

Der Adapter nutzt seit 2026-07-25 Fords **offizielle FordConnect Query API** unter dem
EU Data Act (developer.ford.com/developer-eu). Damit ist das Account-Blocking-Problem gelöst,
weil keine Mobile-App-API mehr reverse-engineered wird.

### Flow (nach `.references/fordlogger`)

- **Auth:** OAuth2 Authorization-Code-Flow mit `client_id` + `client_secret`.
  - Auth-URL: `https://api.vehicle.ford.com/fcon-public/v1/auth/init`
  - Token: `https://api.vehicle.ford.com/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1A_FCON_AUTHORIZE`
  - Scope: `openid offline_access`, Refresh via `refresh_token`-Grant.
  - Kein PKCE (statt `code_verifier` das `client_secret`).
- **Daten (read-only):** `GET /fcon-query/v1/garage` und `GET /fcon-query/v1/telemetry`
  mit `Authorization: Bearer {access_token}`.
- **Kein** Autonomic-Token, **kein** WebSocket, **keine** `mps.ford.com`/`autonomic.ai`-Endpoints.
- Login per Code-URL-Paste (Feld `codeUrl` in der Instanz-Config), kein Callback-Server.
- Remote-Befehle (engine/lock/charge) entfernt, da die Query-API read-only ist. Nur
  `{vin}.remote.refresh` triggert einen sofortigen Telemetrie-Poll.

### Dateien

- `main.js`: Hauptlogik (OAuth + garage/telemetry). Komplett neu, ohne Blocking-Workarounds.
- `io-package.json`: native Defaults `clientId`, `clientSecret` (encrypted), `redirectUri`,
  `codeUrl`, `interval`.
- `admin/jsonConfig.json`: Config-UI für die obigen Felder.

---

## HISTORISCH / OBSOLET: Reverse-Engineering der FordPass App

Alles unterhalb dieser Linie beschreibt den alten, reverse-engineerten FordPass-Mobile-App-Weg
(Username/Passwort -> B2C Browser-Flow -> Autonomic-Token -> WebSocket). Dieser Weg führte zum
Account-Blocking und ist seit dem Umstieg auf die offizielle API **nicht mehr im Code**. Die
Notizen bleiben nur zur historischen Referenz erhalten.

## Problem: Account Blocking durch Ford

Ford sperrt Accounts wenn API-Anfragen nicht dem Verhalten der offiziellen FordPass APK entsprechen.

## Referenz-Implementierungen

- **ha-fordpass**: Home Assistant Integration (Python) - funktioniert ohne Blocking
- **FordPass APK 6.4.0**: Offizielle Android App (dekompiliert in `fordpass-6-4-0.xapk.out/`)
- **FordPass APK 6.6.0**: Neueste Version (dekompiliert in `fordpass-6-6-0.xapk.out/`)

## Maßnahmen gegen Account Blocking

### 1. WebSocket Ping entfernt (implementiert)
- **Problem**: Adapter sendete alle 30s einen WebSocket Ping (`ws.ping()`)
- **ha-fordpass**: Sendet KEINEN WebSocket Ping
- **APK**: OkHttp WebSocket mit `pingInterval = 0` (default, kein Ping)
- **Lösung**: WebSocket Ping entfernt

### 1b. Token Refresh nur bei Heartbeat (2026-02-24)
- **KRITISCH**: Fixer 30s Timer für Token Check entfernt!
- **ha-fordpass**: Token Check NUR bei leerer `{}` Heartbeat Message vom Server
- **Problem**: Fixer Timer = Bot-Verhalten, das Ford erkennen kann
- **Lösung**: Token Check jetzt nur bei `{}` Message (event-basiert wie ha-fordpass)

### 2. Token Refresh Verhalten (implementiert)
- **Ford Token**: On-demand refresh wenn abgelaufen (nicht auf fixem Intervall)
- **Autonomic Token**: Refresh bei < 45s vor Ablauf (wie ha-fordpass)
- ha-fordpass: `__ensure_valid_tokens()` prüft Token nur wenn benötigt

### 3. Polling deaktiviert (implementiert)
- `usePolling`: default OFF - nur WebSocket Push Events
- `useTelemetryQuery`: default OFF - ha-fordpass nutzt diesen Endpoint NICHT
- `forceUpdate`: default OFF - wakeUp kann 12V Batterie entleeren
- `pollLocation`: default OFF (umbenannt von `locationUpdate`)

### 4. API Endpoints
- **ha-fordpass**: GET `/telemetry/sources/fordpass/vehicles/{vin}` (ohne `:query`)
- **APK**: POST `/v1beta/telemetry/sources/fordpass/vehicles/{vin}:query`
- Aktuell: Telemetry Query deaktiviert zum Testen

### 5. TLS/Cipher Configuration (implementiert)
- Python-kompatible TLS Cipher Suite (wie aiohttp/Mercedes Adapter)

### 6. Dynatrace Header ENTFERNT (2026-02-23)
- **ha-fordpass sendet KEINEN x-dynatrace Header!**
- Ursprünglich implementiert weil APK Dynatrace SDK nutzt
- ABER: ha-fordpass funktioniert ohne - also nicht benötigt
- Komplett aus Code entfernt (generateDynatraceHeader, withDynatrace Option)

### 7. User-Agent Strategie (implementiert)
- **KRITISCH**: Alle API-Requests müssen `User-Agent: okhttp/4.12.0` senden
- **APK**: OkHttp's `BridgeInterceptor` setzt automatisch diesen Header
- **Verschiedene User-Agents je nach API-Kontext**:
  - **Ford Login (OAuth)**: Browser User-Agent (Safari/Chrome WebView)
  - **Alle anderen APIs**: `okhttp/4.12.0`
- **Gefixte Leaks**:
  - `getAutonomToken()` - sendete vorher axios Default UA
  - `getVehiclesApi()`, `updateVehicleApi()` - manuell gefixt

### 8. Error Handling (implementiert)
- Bei 401/400: Adapter stoppt statt endlos retry
- `clearAllIntervals()` für sauberes Cleanup
- Circular JSON stringify Fix für Error Logging

## WICHTIG: Blocking Timing

### Beobachtung (2026-02-23)
- Account wird ca. 30-33 Minuten nach Start gesperrt
- Zeitpunkt korreliert mit **erstem Ford Token Refresh**
- Blocking-Mail kam ~1 Minute nach dem ersten `cat-with-refresh-token` Call

### Token Refresh Endpoints
- **Ford Token Refresh**: `POST /api/token/v2/cat-with-refresh-token`
  - Wird nach ~30 min aufgerufen (Token Expiry)
  - APK nutzt gleichen Endpoint (Retrofit Interface in `zj/LJQ.smali`)
  - Request Body: `{"refresh_token": "..."}`
- **Autonomic Token**: `POST /v1/auth/oidc/token` (accounts.autonomic.ai)
  - Wird alle ~5 min aufgerufen
  - Scheint nicht das Problem zu sein

### Mögliche Ursachen für Blocking beim Refresh
1. ~~Dynatrace Header~~ (entfernt - ha-fordpass sendet keinen)
2. Header-Reihenfolge? (OkHttp hat feste Reihenfolge)
3. Request Timing/Pattern?
4. ~~TLS Fingerprint~~ (undici mit HTTP/2 für Token-Endpoints)
5. ~~Body Serialization~~ (gefixt: explizit JSON.stringify wie ha-fordpass)

### 9. Undici für ALLE Token-Endpoints (2026-02-24, aktualisiert 2026-02-25)

- **APK ist Wahrheit** - nicht ha-fordpass!
- **undici** statt axios für alle Token-Endpoints
- **Zwei separate Agents**:
  - `undiciAgentH2` (HTTP/2) für Ford-Endpoints
  - `undiciAgentH1` (HTTP/1.1) für Autonomic - Server sendet GOAWAY bei HTTP/2!
- Header-Reihenfolge aus APK BridgeInterceptor.smali (Lines 136-292):
  1. `Content-Type: application/json` oder `application/x-www-form-urlencoded`
  2. `Accept: */*` (wenn vorhanden)
  3. `Connection: Keep-Alive`
  4. `Accept-Encoding: gzip`
  5. `User-Agent: okhttp/4.12.0`
  6. `Application-Id: ...` (nur bei Ford-Endpoints)
- Betroffene Endpoints (jetzt ALLE auf undici):
  - `cat-with-refresh-token` (Ford Token Refresh) - JSON, HTTP/2
  - `cat-with-b2c-access-token` (Initial Login) - JSON, HTTP/2
  - `accounts.autonomic.ai/v1/auth/oidc/token` (Autonomic Token) - form-urlencoded, **HTTP/1.1**

### 11. Ford Token Refresh Timing (2026-02-24)

- **ha-fordpass**: `now_time = time.time() + 7` (refresh nur wenn Token in 7s abläuft)
- Geändert von 30s auf 7s Vorlaufzeit

## WebSocket Verhalten Vergleich

| Feature | ha-fordpass | APK | Unser Adapter |
|---------|------------|-----|---------------|
| WS Ping | NEIN | NEIN (pingInterval=0) | NEIN (entfernt) |
| Leere `{}` als Heartbeat | JA | - | JA |
| Token Update via WS | `{"accessToken": ...}` | `{"accessToken": ...}` | JA |
| Token Refresh Trigger | Bei leerer `{}` Message | Flow-basiert | Bei leerer `{}` Message (gefixt) |

## Token Refresh Frequenz

- **Autonomic Token**: ~5 min Gültigkeit, refresh bei < 45s
- **Ford Token**: ~30 min Gültigkeit, on-demand refresh
- **Pro Tag**: ~288 Autonomic + ~46 Ford Refreshes (identisch zu ha-fordpass)

## Dateien

- `main.js`: Hauptlogik des Adapters
- `io-package.json`: Adapter Konfiguration und Defaults
- `admin/jsonConfig.json`: Admin UI für Einstellungen (jsonConfig, seit Umstellung von Materialize)

## APK 6.6.0 Analyse (2026-02-23)

### Keine Änderungen zu 6.4.0

- **User-Agent**: Weiterhin `okhttp/4.12.0` (BridgeInterceptor.smali:290)
- **Token Endpoints**: Identisch
  - `/api/token/v2/cat-with-refresh-token`
  - `/api/token/v2/cat-with-b2c-access-token`
  - `/api/token/v2/cat-with-ci-access-token`
  - `/api/token/v2/revoke-token`
  - `/api/token/v2/swap-token`
- **Autonomic Token**: `v1/auth/oidc/token` (TmcAccessTokenService.smali:377)
- **Domains**: api.mps.ford.com, api.vehicle.ford.com, api.autonomic.ai

### Dynatrace in APK

- Dynatrace Agent ist eingebettet (com.dynatrace.android.agent)
- `getRequestTagHeader()` gibt `x-dynatrace` zurück
- Agent fügt Header automatisch zu OkHttp Requests hinzu
- **ABER**: ha-fordpass sendet KEINEN x-dynatrace Header und funktioniert!

### WebSocket URLs

- Stark obfuskiert in WebSocketURLConstants.smali
- String Encryption über `zj/` Klassen (psj, usj, xj, etc.)

## Offene Fragen

- Blocking passiert trotz korrektem Verhalten im Log - möglicherweise:
  - FordPass App läuft parallel auf Handy
  - Andere Integration nutzt denselben Account
  - Verzögerte Blocking-Erkennung durch Ford
  - **Ford Token Refresh löst Blocking aus** (Beobachtung)
