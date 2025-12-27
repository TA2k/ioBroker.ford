# Ford Login - AJAX Approach (Basierend auf echtem Browser Request)

## Erkenntnisse aus dem curl Request

### 1. URL Parameter
```
https://login.ford.de/.../SelfAsserted?tx=StateProperties=...&p=B2C_1A_SignInSignUp_de-DE
```

- `tx=StateProperties=eyJUSUQiOiJlMjRmMGEyNy04Y2I3LTRkODEtODc2Yi1kNGMyNDdkOTc3ZTUifQ`
- `p=B2C_1A_SignInSignUp_de-DE`

### 2. Headers (Wichtig!)
```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: application/json, text/javascript, */*; q=0.01
X-CSRF-Token: THR6R0ZFdjlKTnpkRW4xNXpoUHoyblpmK29JVjQ4RndrRm9pbm8zWFFEOXNBK3h2WGhVWlR4YitoOEJ3Y2Y4VHVHaXE1RXcrWEt1eDZJeGpuVWlPbHc9PTsyMDI1LTEyLTI3VDE3OjEwOjA5LjMyNDcxNjdaO3BlOGViTjNISWl3ck1VZlZrRWhmOUE9PTt7Ik9yY2hlc3RyYXRpb25TdGVwIjoxfQ==
X-Requested-With: XMLHttpRequest
sec-fetch-mode: cors
```

**Kritische Punkte:**
- CSRF Token im **Header** (nicht im Body!)
- `X-Requested-With: XMLHttpRequest` - markiert es als AJAX
- `Accept: application/json` - erwartet JSON Response
- `sec-fetch-mode: cors` - CORS Request

### 3. POST Data
```
request_type=RESPONSE&signInName=EMAIL&password=PASSWORD
```

Nur 3 Felder:
- `request_type=RESPONSE`
- `signInName=EMAIL`
- `password=PASSWORD`

### 4. CSRF Token Quelle
Der CSRF Token kommt aus dem Cookie `x-ms-cpim-csrf`:
```
x-ms-cpim-csrf=THR6R0ZFdjlKTnpkRW4xNXpoUHoyblpmK29JVjQ4RndrRm9pbm8zWFFEOXNBK3h2WGhVWlR4YitoOEJ3Y2Y4VHVHaXE1RXcrWEt1eDZJeGpuVWlPbHc9PTsyMDI1LTEyLTI3VDE3OjEwOjA5LjMyNDcxNjdaO3BlOGViTjNISWl3ck1VZlZrRWhmOUE9PTt7Ik9yY2hlc3RyYXRpb25TdGVwIjoxfQ==
```

### 5. TX Parameter Generierung
Der `tx` Parameter wird aus dem `x-ms-cpim-trans` Cookie generiert:

```javascript
const transCookie = cookies.find(c => c.key === 'x-ms-cpim-trans');
const transData = JSON.parse(Buffer.from(transCookie.value, 'base64').toString());
const TID = transData.C_ID; // z.B. "e24f0a27-8cb7-4d81-876b-d4c247d977e5"

// Encode StateProperties
const stateProps = Buffer.from(JSON.stringify({ TID: TID })).toString('base64');
const txParam = `tx=StateProperties=${stateProps}&p=B2C_1A_SignInSignUp_de-DE`;
```

## Implementation in test-v2-oauth.js

Der `automatedLogin` Code muss so angepasst werden:

### 1. Initial GET Request (bleibt gleich)
```javascript
const authResponse = await requestClient({
  method: 'get',
  url: authUrl,
  headers: {
    'accept': 'text/html,...',
    'user-agent': 'Mozilla/5.0...',
  },
});
```

### 2. Extract Cookies
```javascript
// Get CSRF from cookie
const cookies = await cookieJar.getCookies(authUrl);
const csrfCookie = cookies.find(c => c.key === 'x-ms-cpim-csrf');
const csrfToken = csrfCookie.value;

// Get TX param from trans cookie
const transCookie = cookies.find(c => c.key === 'x-ms-cpim-trans');
const transData = JSON.parse(Buffer.from(transCookie.value, 'base64').toString());
const stateProps = Buffer.from(JSON.stringify({ TID: transData.C_ID })).toString('base64');
const txParam = `tx=StateProperties=${stateProps}&p=B2C_1A_SignInSignUp_de-DE`;
```

### 3. POST Login (AJAX Style!)
```javascript
const postUrl = `${baseUrl}/SelfAsserted?${txParam}`;
const postData = qs.stringify({
  'request_type': 'RESPONSE',
  'signInName': config.user,
  'password': config.password,
});

const loginResponse = await requestClient({
  method: 'post',
  url: postUrl,
  data: postData,
  headers: {
    'Accept': 'application/json, text/javascript, */*; q=0.01',  // JSON!
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-CSRF-Token': csrfToken,  // Header!
    'X-Requested-With': 'XMLHttpRequest',  // AJAX marker!
    'Origin': config.login_url,
    'Referer': authUrl,
    'User-Agent': '...',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  },
  maxRedirects: 0,
  validateStatus: (status) => status < 500,
});
```

### 4. Handle JSON Response
```javascript
// Response is JSON!
if (loginResponse.data && loginResponse.data.status === '200') {
  // Success - check for continueUrl
  if (loginResponse.data.continueUrl) {
    // Follow continue URL to get fordapp:// redirect
    const continueResponse = await requestClient.get(loginResponse.data.continueUrl);
    // ... follow redirects to fordapp://
  }
}
```

## Wichtige Änderungen gegenüber altem Ansatz

1. **Kein CSRF Token Parsing aus HTML** - kommt aus Cookie
2. **AJAX Headers** - nicht Browser Form Submit
3. **JSON Response** - nicht HTML
4. **TX Parameter** - muss aus Cookie generiert werden
5. **continueUrl** - response enthält URL für nächsten Schritt

## Test
Der Code wurde getestet mit [test-login-ajax.js](test-login-ajax.js)
