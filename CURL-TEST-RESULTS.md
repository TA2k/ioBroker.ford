# Ford OAuth Login Flow - Test Results

## Problem
Der automatisierte Login in `test-v2-oauth.js` (Zeile 454-601) schlägt fehl beim GET-Request zur Auth-URL.

## Test-Ergebnisse

### 1. curl mit HTTP/2
**Status**: FAILED
**Error**: `HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR (err 2)`

### 2. curl mit HTTP/1.1
**Status**: TIMEOUT
**Error**: Request timeout nach 18 Sekunden

### 3. Node.js axios (test-auth-request.js)
**Status**: SUCCESS ✓
- Status Code: 200 OK
- Content-Type: text/html; charset=utf-8
- Response enthält HTML

### 4. Cookies werden korrekt gesetzt
Folgende wichtige Cookies wurden vom Server gesetzt:
- `x-ms-cpim-sso:b2cford.onmicrosoft.com_0` - Session Cookie
- `x-ms-cpim-csrf` - CSRF Token Cookie
- `x-ms-cpim-cache|sovs2eykx0k_ex4s0tsqqa_0` - Cache Cookie
- `x-ms-cpim-trans` - Transaction Cookie
- `x-ford-cid` - Ford Client ID
- `_abck`, `ak_bmsc`, `bm_sz` - Akamai Bot Management Cookies

## Analyse

Die Request funktioniert mit axios/Node.js, aber:
1. **CSRF Token nicht im HTML gefunden** - Das deutet darauf hin, dass:
   - Das Login-Formular client-seitig (JavaScript) gerendert wird
   - Der CSRF Token anders platziert/benannt ist
   - Die Seite eine SPA (Single Page Application) ist

2. **Wichtige Header für erfolgreichen Request**:
   ```
   accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8
   accept-language: de-DE,de;q=0.9,en-GB;q=0.8,en;q=0.7
   user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36
   ```

3. **Cookie Jar funktioniert** - tough-cookie und http-cookie-agent speichern Cookies korrekt

## Nächste Schritte

1. HTML Response komplett analysieren - ist es eine SPA?
2. CSRF Token in Cookie suchen (x-ms-cpim-csrf enthält möglicherweise den Token)
3. Azure B2C Login-Flow genauer untersuchen - möglicherweise multi-step process
4. Home Assistant Code genauer ansehen - wie extrahieren sie den CSRF Token?

## Hypothese

Das Problem in `automatedLogin()` könnte sein, dass:
- Der initiale GET-Request funktioniert
- Aber die Seite rendert das Formular client-seitig
- Oder Azure B2C hat einen komplexeren Flow mit mehreren Redirects
- Der CSRF Token ist bereits im Cookie (x-ms-cpim-csrf) und nicht im HTML
