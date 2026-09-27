// @ts-nocheck
'use strict';

/*
 * FordPass client.
 *
 * v2 OAuth (PKCE) login via pasted "fordapp://userauthorized/?code=..." URL,
 * Autonomic token exchange and a WebSocket for real-time push updates.
 * Also supports remote commands (engine, lock, charge). This mirrors the
 * FordPass mobile app and may lead to account blocking - it is offered as an
 * optional mode next to the official FordConnect Query API.
 */

const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const crypto = require('crypto');
const https = require('https');
const { Agent: UndiciAgent, request: undiciRequest } = require('undici');

class FordPassClient {
  /**
   * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;

    this.vinArray = [];
    this.session = {};
    this.sessionV2 = {};
    this.autonomTokenV2 = null;
    this.ignoredAPI = [];
    this.appId = '667D773E-1BDC-4139-8AD0-2B16474E8DC7';
    this.cookieJar = new tough.CookieJar();
    this.wsSocket = null;
    this.wsReconnectTimeout = null;
    this.wsHeartbeatInterval = null;
    this.wsTokenRefreshInterval = null;
    this.autonomExpiresAt = null;
    this.wsCurrentToken = null;
    this.currentWsVin = null;
    this.isUnloading = false;
    this.skipForceUpdate = false;

    // Python-compatible TLS cipher suite (like Mercedes/aiohttp)
    this.pythonCiphers = [
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ].join(':');

    // v2 OAuth config - PKCE will be loaded/generated in onReady
    this.v2Config = {
      oauth_id: '4566605f-43a7-400a-946e-89cc9fdb0bd7',
      v2_clientId: '09852200-05fd-41f6-8c21-d36d3497dc64',
      redirect_uri: 'fordapp://userauthorized',
      appId: '667D773E-1BDC-4139-8AD0-2B16474E8DC7',
      locale: 'de-DE',
      login_url: 'https://login.ford.de',
      code_verifier: '',
      code_challenge: '',
    };

    this.requestClient = axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({
        cookies: {
          jar: this.cookieJar,
        },
      }),
    });

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.json2iob = new Json2iob(adapter);
    this.last12V = 12.2;

    // Undici agent with HTTP/2 for Ford endpoints (like APK's OkHttp)
    this.undiciAgentH2 = new UndiciAgent({
      allowH2: true,
      connect: {
        rejectUnauthorized: true,
      },
    });

    // Undici agent HTTP/1.1 only for Autonomic (server sends GOAWAY on HTTP/2)
    this.undiciAgentH1 = new UndiciAgent({
      allowH2: false,
      connect: {
        rejectUnauthorized: true,
      },
    });
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    this.adapter.setState('info.connection', false, true);
    if (this.adapter.config.interval < 0.5) {
      this.adapter.log.info('Set interval to minimum 0.5');
      this.adapter.config.interval = 0.5;
    }

    this.adapter.subscribeStates('*');

    // Load or generate PKCE
    await this.loadOrGeneratePKCE();

    const auth = await this.adapter.getStateAsync('authV2');

    // Check if user provided code URL for v2 OAuth
    if (this.adapter.config.v2_codeUrl && this.adapter.config.v2_codeUrl.startsWith('fordapp://userauthorized')) {
      this.adapter.log.info('Found v2 Code URL, exchanging for token...');

      // Extract code from fordapp:// URL
      const urlParts = this.adapter.config.v2_codeUrl.split('?');
      if (urlParts.length > 1) {
        const params = qs.parse(urlParts[1]);
        const code = params.code;

        if (code && typeof code === 'string') {
          const success = await this.exchangeCodeForTokenV2(code);

          if (success) {
            // Clear PKCE after successful exchange
            this.adapter.log.info('Code exchanged for token successfully.');
            await this.clearPKCE();
            // Skip force update on first start after login to avoid immediate API calls
            this.skipForceUpdate = true;
          } else {
            this.adapter.log.error('Failed to exchange code for token');
            return;
          }
        } else {
          this.adapter.log.error('No code found in v2CodeUrl');
          return;
        }
      }
    } else if (auth && auth.val && typeof auth.val === 'string') {
      // Try to use existing session
      try {
        this.session = JSON.parse(auth.val);
        this.sessionV2 = this.session;
        this.adapter.log.info('Using existing session, refreshing token...');
        await this.refreshToken();
      } catch (error) {
        this.adapter.log.error('Failed to parse authV2 state');
        if (error instanceof Error) {
          this.adapter.log.error(error.message);
        }
        this.adapter.log.warn('Please delete the authV2 state and re-authenticate via adapter settings');
      }
    } else {
      // No code URL and no existing session - generate auth URL
      this.adapter.log.warn('========================================');
      this.adapter.log.warn('FORD OAUTH 2.0 LOGIN REQUIRED');
      this.adapter.log.warn('========================================');
      this.adapter.log.warn('');
      this.adapter.log.warn('Please follow these steps:');
      this.adapter.log.warn('1. Open Chrome and press F12 to open Developer Tools');
      this.adapter.log.warn('2. Go to the Network tab');
      this.adapter.log.warn('3. Copy and paste this URL in Chrome:');
      this.adapter.log.warn('');
      this.adapter.log.warn(this.generateV2AuthUrl());
      this.adapter.log.warn('');
      this.adapter.log.warn('4. Log in with your Ford account');
      this.adapter.log.warn('5. After redirect, the Login process will stuck. This is expected.');
      this.adapter.log.warn('6. COPY the complete red URL from network tab (starts with: fordapp://userauthorized/?code=)');
      this.adapter.log.warn('7. Paste it into the "v2 Code URL" field in adapter settings');
      this.adapter.log.warn('8. Save and restart the adapter');
      this.adapter.log.warn('');
      this.adapter.log.warn('========================================');
      return;
    }

    if (this.session.access_token) {
      // Log active options at startup
      this.adapter.log.info('========================================');
      this.adapter.log.info('Ford Adapter Starting (FordPass mode)');
      this.adapter.log.info('========================================');
      this.adapter.log.info(`usePolling: ${this.adapter.config.usePolling ? 'ON' : 'OFF'}`);
      if (this.adapter.config.usePolling) {
        this.adapter.log.info(`  interval: ${this.adapter.config.interval} minutes`);
        this.adapter.log.info(`  forceUpdate (wakeUp): ${this.adapter.config.forceUpdate ? 'ON' : 'OFF'}`);
        this.adapter.log.info(`  useTelemetryQuery: ${this.adapter.config.useTelemetryQuery ? 'ON' : 'OFF'}`);
        this.adapter.log.info(`  pollLocation: ${this.adapter.config.pollLocation ? 'ON' : 'OFF'}`);
      }
      this.adapter.log.info(`skip12VCheck: ${this.adapter.config.skip12VCheck ? 'ON' : 'OFF'}`);
      this.adapter.log.info('========================================');

      await this.getVehicles();
      await this.cleanObjects();

      // Probe the new user-garage endpoint (APK 6.22.0 replaced expdashboard
      // with this). Debug-logged only for now to inspect real responses.
      await this.logUserGarage();

      // Get initial Autonomic token for WebSocket
      await this.getAutonomToken();
      if (!this.autonom) {
        this.adapter.log.error('Failed to get Autonomic token - cannot connect WebSocket');
        return;
      }

      // Connect WebSocket for real-time updates (for each vehicle)
      // ha-fordpass ONLY uses WebSocket for updates - NO initial API polling
      for (const vin of this.vinArray) {
        await this.connectWebSocket(vin);
      }

      // Only enable polling if explicitly configured (default: WebSocket only like ha-fordpass)
      if (this.adapter.config.usePolling) {
        this.adapter.log.info(`Polling enabled (usePolling=true) - interval: ${this.adapter.config.interval} minutes`);
        this.adapter.log.debug(`forceUpdate=${this.adapter.config.forceUpdate}, pollLocation=${this.adapter.config.pollLocation}`);
        this.updateInterval = setInterval(async () => {
          this.adapter.log.debug('Polling interval triggered - calling updateVehicles()');
          await this.updateVehicles();
        }, this.adapter.config.interval * 60 * 1000);
      } else {
        this.adapter.log.info('WebSocket-only mode (usePolling=false) - no polling, using push events only');
      }
    }
  }

  async getVehicles() {
    // Ford expdashboard API needs: auth-token, Application-Id, countryCode, locale
    const headers = {
      ...this.getBaseHeaders({ withLocale: true }),
      'auth-token': this.session.access_token,
    };
    await this.requestClient({
      method: 'post',
      url: 'https://api.vehicle.ford.com/api/expdashboard/v1/details',
      headers: headers,
      data: JSON.stringify({
        dashboardRefreshRequest: 'All',
      }),
    })
      .then(async (res) => {
        this.adapter.log.debug(JSON.stringify(res.data));
        this.adapter.log.info(res.data.userVehicles.vehicleDetails.length + ' vehicles found');
        for (const vehicle of res.data.userVehicles.vehicleDetails) {
          this.vinArray.push(vehicle.VIN);
          await this.adapter.setObjectNotExistsAsync(vehicle.VIN, {
            type: 'device',
            common: {
              name: vehicle.nickName,
            },
            native: {},
          });
          await this.adapter.setObjectNotExistsAsync(vehicle.VIN + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          await this.adapter.setObjectNotExistsAsync(vehicle.VIN + '.general', {
            type: 'channel',
            common: {
              name: 'General Car Information',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'engine/start', name: 'True = Start, False = Stop' },
            { command: 'doors/lock', name: 'True = Lock, False = Unlock' },
            { command: 'charge/start', name: 'True = Start Charge, False = Cancel Charge' },
            { command: 'charge/pause', name: 'True = Pause Charge' },
            { command: 'status', name: 'True = Request Status Update' },
            { command: 'refresh', name: 'True = Refresh Status' },
          ];
          remoteArray.forEach((remote) => {
            this.adapter.setObjectNotExists(vehicle.VIN + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(vehicle.VIN + '.general', vehicle);
        }
        for (const vehicle of res.data.vehicleProfile) {
          this.json2iob.parse(vehicle.VIN + '.general', vehicle);
        }
        for (const vehicle of res.data.vehicleCapabilities) {
          this.json2iob.parse(vehicle.VIN + '.capabilities', vehicle);
        }
      })
      .catch((error) => {
        this.adapter.log.error('failed to receive vehicles');
        this.adapter.log.error(error);
        error.response && this.adapter.log.error(JSON.stringify(error.response.data));
      });
  }

  /**
   * Probe the user-garage endpoint that replaced expdashboard in the FordPass
   * app (6.22.0): GET /api/fpcpl-user-garage-service/v1/user/garage with the
   * Auth-Token, Application-Id and CountryCode headers.
   * Response is only debug-logged for now - nothing is written to states, so we
   * can inspect the real shape from user logs before parsing it.
   */
  async logUserGarage() {
    const headers = {
      'Auth-Token': this.session.access_token,
      'Application-Id': this.appId,
      CountryCode: 'DEU',
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/5.3.2',
    };
    try {
      const res = await this.requestClient({
        method: 'get',
        url: 'https://api.vehicle.ford.com/api/fpcpl-user-garage-service/v1/user/garage',
        headers: headers,
      });
      this.adapter.log.debug('user-garage response: ' + JSON.stringify(res.data));
    } catch (error) {
      this.adapter.log.debug('user-garage request failed: ' + (error && error.message));
      if (error.response) {
        this.adapter.log.debug('user-garage HTTP ' + error.response.status + ': ' + JSON.stringify(error.response.data));
      }
    }
  }

  async updateVehicles() {
    await this.getAutonomToken();
    if (!this.autonom) {
      this.adapter.log.error('Failed to get autonom token');
      return;
    }
    const statusArray = [
      {
        path: 'statusQuery',
        url: 'https://api.autonomic.ai/v1beta/telemetry/sources/fordpass/vehicles/$vin:query',
        desc: 'Current status via query of the car. Check your 12V battery regularly.',
      },
    ];

    // Autonomic API only needs Authorization header - no Application-Id or Dynatrace
    const headers = this.getAutonomicHeaders();
    this.vinArray.forEach(async (vin) => {
      if (this.adapter.config.forceUpdate && !this.skipForceUpdate) {
        if (this.last12V < 12.1 && !this.adapter.config.skip12VCheck) {
          this.adapter.log.warn('12V battery is under 12.1V: ' + this.last12V + 'V - Skip force update from car');
          return;
        }
        this.adapter.log.debug('Force update of ' + vin);
        await this.requestClient({
          method: 'post',
          url: 'https://api.autonomic.ai/v1/command/vehicles/' + vin + '/commands',
          headers: headers,
          data: {
            properties: {},
            tags: {},
            type: 'statusRefresh',
            wakeUp: true,
          },
        })
          .then((res) => {
            this.adapter.log.debug('Force update successful');
            this.adapter.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            // 404 means vehicle doesn't support statusRefresh - this is normal for many vehicles
            if (error.response && error.response.status === 404) {
              this.adapter.log.debug('Force update not supported by vehicle (statusRefresh command not available)');
            } else {
              this.adapter.log.error('Failed to force update');
              this.adapter.log.error(error);
              if (error.response) {
                this.adapter.log.error(JSON.stringify(error.response.data));
              }
            }
          });
      }
      // Telemetry Query - only if useTelemetryQuery is enabled (ha-fordpass does NOT do this)
      if (!this.adapter.config.useTelemetryQuery) {
        this.adapter.log.debug('Telemetry query disabled (useTelemetryQuery=false) - skipping statusQuery POST');
        return;
      }
      statusArray.forEach(async (element) => {
        this.adapter.log.debug('Telemetry query: ' + element.path + ' for ' + vin);
        const url = element.url.replace('$vin', vin);
        if (this.ignoredAPI.indexOf(element.path) !== -1) {
          return;
        }
        await this.requestClient({
          method: 'post',
          url: url,
          headers: headers,
          data: '{}',
        })
          .then(async (res) => {
            this.adapter.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            const keys = Object.keys(res.data);
            if (keys.length === 1) {
              data = res.data[keys[0]];
            }

            await this.json2iob.parse(vin + '.' + element.path, data, {
              forceIndex: true,
              autoCast: true,
              channelName: element.desc,
            });
            if (data.metrics && data.metrics.batteryVoltage) {
              const current12V = data.metrics.batteryVoltage.value;
              if (current12V < 12.1) {
                this.adapter.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
              }
              this.last12V = current12V;
            }
          })
          .catch((error) => {
            this.adapter.log.debug('Failed to update ' + element.path + ' for ' + vin);
            if (error.response && error.response.status === 404) {
              this.ignoredAPI.push(element.path);
              this.adapter.log.info('Ignored API: ' + element.path);
              return;
            }
            if (error.response && error.response.status === 401) {
              error.response && this.adapter.log.debug(JSON.stringify(error.response.data));
              this.adapter.log.info(element.path + ' receive 401 error. Refresh Token in 30 seconds');
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 1000 * 30);

              return;
            }

            this.adapter.log.error(url);
            this.adapter.log.error(error);
            error.response && this.adapter.log.error(JSON.stringify(error.response.data));
          });
      });
    });
  }

  /**
   * Generate PKCE code_verifier and code_challenge for OAuth 2.0
   * @returns {{code_verifier: string, code_challenge: string}}
   */
  generatePKCE() {
    // Generate a random 96-byte code_verifier (base64url encoded)
    const code_verifier = crypto.randomBytes(96).toString('base64url');

    // Generate code_challenge as SHA256 hash of code_verifier (base64url encoded, no padding)
    const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');

    return { code_verifier, code_challenge };
  }

  /**
   * Load saved PKCE from state or generate new one
   * PKCE must persist across adapter restarts during the OAuth flow
   */
  async loadOrGeneratePKCE() {
    // Create PKCE state if not exists
    await this.adapter.extendObjectAsync('pkce', {
      type: 'state',
      common: {
        name: 'PKCE code_verifier for OAuth',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
      },
      native: {},
    });

    // Try to load saved PKCE
    const savedPkce = await this.adapter.getStateAsync('pkce');
    if (savedPkce && savedPkce.val && typeof savedPkce.val === 'string') {
      this.adapter.log.debug('Using saved PKCE code_verifier');
      const code_verifier = savedPkce.val;
      const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      this.v2Config.code_verifier = code_verifier;
      this.v2Config.code_challenge = code_challenge;
    } else {
      // Generate new PKCE
      this.adapter.log.debug('Generating new PKCE');
      const pkce = this.generatePKCE();
      this.v2Config.code_verifier = pkce.code_verifier;
      this.v2Config.code_challenge = pkce.code_challenge;
      // Save PKCE for later use (in case adapter restarts during OAuth flow)
      await this.adapter.setStateAsync('pkce', { val: pkce.code_verifier, ack: true });
    }
  }

  /**
   * Clear saved PKCE after successful login
   */
  async clearPKCE() {
    await this.adapter.setStateAsync('pkce', { val: '', ack: true });
    this.adapter.log.debug('Cleared saved PKCE');
  }

  /**
   * Get base headers for Ford APIs (expdashboard, foundational, fordconnect, etc.)
   * NOTE: x-dynatrace header removed - ha-fordpass does NOT send this header
   * @param {{contentType?: string, withAppId?: boolean, withLocale?: boolean, withAuth?: boolean, accept?: string}} [options] - Additional options
   * @returns {object} Headers object
   */
  getBaseHeaders(options) {
    // Header order like OkHttp's BridgeInterceptor (BridgeInterceptor.smali)
    // Order: Content-Type, Host, Connection, Accept-Encoding, Cookie, User-Agent
    const { contentType = 'application/json', withAppId = true, withLocale = false, withAuth = false, accept = null } = options || {};

    const headers = {
      'Content-Type': contentType,
    };

    if (accept) {
      headers['Accept'] = accept;
    }

    headers['Connection'] = 'Keep-Alive';
    headers['Accept-Encoding'] = 'gzip';
    headers['User-Agent'] = 'okhttp/5.3.2';

    if (withAppId) {
      headers['Application-Id'] = this.appId;
    }

    if (withLocale) {
      headers['countryCode'] = 'DEU';
      headers['locale'] = 'de-DE';
    }

    if (withAuth && this.session && this.session.access_token) {
      headers['Authorization'] = 'Bearer ' + this.session.access_token;
    }

    return headers;
  }

  /**
   * Get headers for Autonomic API calls (telemetry, commands)
   * Autonomic API only needs Authorization header - no Application-Id or Dynatrace
   * @returns {object} Headers object
   */
  getAutonomicHeaders() {
    return {
      'Accept-Encoding': 'gzip',
      Connection: 'Keep-Alive',
      'Content-Type': 'application/json',
      'User-Agent': 'okhttp/5.3.2',
      Authorization: 'Bearer ' + this.autonom.access_token,
    };
  }

  /**
   * Make token request using undici with HTTP/2 support
   * This is used for Ford token endpoints to match ha-fordpass behavior more closely
   * @param {string} url - The URL to request
   * @param {object} body - The request body (will be JSON stringified)
   * @param {object} [extraHeaders] - Additional headers to include
   * @returns {Promise<object>} Response data
   */
  async undiciTokenRequest(url, body, extraHeaders = {}) {
    // Header order like OkHttp's BridgeInterceptor (BridgeInterceptor.smali)
    // Order: Content-Type, Host, Connection, Accept-Encoding, Cookie, User-Agent
    const headers = {
      'Content-Type': 'application/json',
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/5.3.2',
      'Application-Id': this.appId,
      ...extraHeaders,
    };

    const bodyStr = JSON.stringify(body);

    this.adapter.log.debug(`undici request to ${url}`);
    this.adapter.log.debug(`undici headers: ${JSON.stringify(headers)}`);

    const { statusCode, headers: resHeaders, body: resBody } = await undiciRequest(url, {
      method: 'POST',
      headers: headers,
      body: bodyStr,
      dispatcher: this.undiciAgentH2,
    });

    const data = await resBody.json();

    this.adapter.log.debug(`undici response status: ${statusCode}`);
    this.adapter.log.debug(`undici response headers: ${JSON.stringify(resHeaders)}`);

    if (statusCode >= 400) {
      const error = new Error(`HTTP ${statusCode}`);
      error.response = { status: statusCode, data: data };
      throw error;
    }

    return data;
  }

  /**
   * Undici request for form-urlencoded data (Autonomic token endpoint)
   * NOTE: Autonomic server does NOT support HTTP/2 (sends GOAWAY frame) - use H1 agent
   */
  async undiciFormRequest(url, formData) {
    // Header order like OkHttp's BridgeInterceptor (BridgeInterceptor.smali)
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/5.3.2',
    };

    const bodyStr = qs.stringify(formData);

    this.adapter.log.debug(`undici form request to ${url}`);
    this.adapter.log.debug(`undici headers: ${JSON.stringify(headers)}`);

    // Use HTTP/1.1 agent - Autonomic server rejects HTTP/2 with GOAWAY
    const { statusCode, headers: resHeaders, body: resBody } = await undiciRequest(url, {
      method: 'POST',
      headers: headers,
      body: bodyStr,
      dispatcher: this.undiciAgentH1,
    });

    const data = await resBody.json();

    this.adapter.log.debug(`undici response status: ${statusCode}`);
    this.adapter.log.debug(`undici response headers: ${JSON.stringify(resHeaders)}`);

    if (statusCode >= 400) {
      const error = new Error(`HTTP ${statusCode}`);
      error.response = { status: statusCode, data: data };
      throw error;
    }

    return data;
  }

  /**
   * Check if Ford token is expired and refresh if needed (like ha-fordpass __ensure_valid_tokens)
   * Ford token typically expires after 30 minutes
   * ha-fordpass: now_time = time.time() + 7 (refresh only if token expires in next 7 seconds)
   */
  async ensureValidFordToken() {
    if (!this.fordExpiresAt) {
      this.adapter.log.debug('ensureValidFordToken: no expiry time set, assuming token is valid');
      return;
    }

    const now = Date.now();
    const secondsUntilExpiry = Math.floor((this.fordExpiresAt - now) / 1000);

    // Refresh if expired or will expire in next 7 seconds (like ha-fordpass: now_time + 7)
    if (now + 7000 > this.fordExpiresAt) {
      this.adapter.log.info(`Ford token expired or expiring soon (${secondsUntilExpiry}s) - refreshing...`);
      await this.refreshToken();
    } else {
      this.adapter.log.debug(`Ford token valid for ${secondsUntilExpiry}s`);
    }
  }

  async getAutonomToken() {
    // Check if Ford token needs refresh first (like ha-fordpass __ensure_valid_tokens)
    await this.ensureValidFordToken();

    try {
      // Use undici with HTTP/2 like APK (OkHttp supports HTTP/2)
      const data = await this.undiciFormRequest('https://accounts.autonomic.ai/v1/auth/oidc/token', {
        subject_token: this.session.access_token,
        subject_issuer: 'fordpass',
        client_id: 'fordpass-prod',
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      });

      this.adapter.log.debug(JSON.stringify(data));
      this.autonom = data;
      // Track token expiry time (expires_in is in seconds)
      if (data.expires_in) {
        this.autonomExpiresAt = Date.now() + data.expires_in * 1000;
        this.adapter.log.debug(`Autonomic token expires at: ${new Date(this.autonomExpiresAt).toISOString()}`);
      }
      return true;
    } catch (error) {
      this.adapter.log.error('Autonomic token exchange failed');
      if (error.response) {
        this.adapter.log.error(JSON.stringify(error.response.data));
        // 401 means Ford token is invalid/blocked - stop adapter
        if (error.response.status === 401) {
          this.adapter.log.error('========================================');
          this.adapter.log.error('ACCOUNT BLOCKED OR TOKEN INVALID');
          this.adapter.log.error('========================================');
          this.adapter.log.error('Your Ford account appears to be blocked or the token is invalid.');
          this.adapter.log.error('Please wait some time and then:');
          this.adapter.log.error('1. Delete the authV2 state in ioBroker objects');
          this.adapter.log.error('2. Restart the adapter to re-authenticate');
          this.adapter.log.error('========================================');
          this.autonom = null;
          this.autonomExpiresAt = null;
          // Stop all activity - don't keep retrying
          this.adapter.setState('info.connection', false, true);
          this.disconnectWebSocket();
          this.clearAllIntervals();
          return false;
        }
      } else {
        this.adapter.log.error(error);
      }
      this.autonom = null;
      this.autonomExpiresAt = null;
      return false;
    }
  }

  async refreshToken() {
    this.adapter.log.debug('Refreshing Ford access token...');

    try {
      // Use undici with HTTP/2 support for token refresh
      const data = await this.undiciTokenRequest(
        'https://api.foundational.ford.com/api/token/v2/cat-with-refresh-token',
        { refresh_token: this.session.refresh_token },
      );

      this.adapter.log.debug(JSON.stringify(data));
      this.session = data;
      this.sessionV2 = data;
      // Track Ford token expiry time
      if (data.expires_in) {
        this.fordExpiresAt = Date.now() + data.expires_in * 1000;
        this.adapter.log.debug(`Ford token expires at: ${new Date(this.fordExpiresAt).toISOString()}`);
      }
      this.adapter.setState('info.connection', true, true);
      this.adapter.log.info('Ford token refresh successful');
      this.adapter.log.debug(`Token expires in: ${Math.floor(this.session.expires_in / 60)} minutes`);

      // Save updated session to authV2 state
      await this.adapter.extendObjectAsync('authV2', {
        type: 'state',
        common: {
          name: 'authV2',
          type: 'string',
          role: 'json',
          read: true,
          write: true,
        },
        native: {},
      });
      await this.adapter.setStateAsync('authV2', { val: JSON.stringify(this.session), ack: true });

      return true;
    } catch (error) {
      this.adapter.log.error('Ford token refresh failed');
      if (error instanceof Error) {
        this.adapter.log.error(error.message);
      }
      if (error && typeof error === 'object' && 'response' in error) {
        // Don't stringify error.response directly - it has circular references
        const resp = error.response;
        if (resp && resp.data) {
          this.adapter.log.error(`HTTP Status: ${resp.status}`);
          this.adapter.log.error(JSON.stringify(resp.data));
        }
        // 400/401 means token is invalid - account likely blocked, stop retrying
        if (resp && (resp.status === 400 || resp.status === 401)) {
          this.adapter.log.error('========================================');
          this.adapter.log.error('ACCOUNT BLOCKED OR TOKEN INVALID');
          this.adapter.log.error('========================================');
          this.adapter.log.error('Your Ford account appears to be blocked or the token is invalid.');
          this.adapter.log.error('Please wait some time and then:');
          this.adapter.log.error('1. Delete the authV2 state in ioBroker objects');
          this.adapter.log.error('2. Restart the adapter to re-authenticate');
          this.adapter.log.error('========================================');
          this.adapter.setState('info.connection', false, true);
          this.disconnectWebSocket();
          this.clearAllIntervals();
          return false;
        }
      }

      this.adapter.log.error('Token refresh failed. Please re-authenticate via adapter settings.');
      this.adapter.log.warn('RECOMMENDATION: Delete the authV2 state and re-authenticate with a new login.');
      this.adapter.log.error('The adapter will try again in 5 minutes...');

      this.reLoginTimeout = setTimeout(() => {
        this.refreshAllTokens();
      }, 1000 * 60 * 5);

      return false;
    }
  }

  /**
   * Retry token refresh after failure (called from error handler)
   */
  async refreshAllTokens() {
    this.adapter.log.debug('Retry Ford token refresh after previous failure...');

    // Refresh Ford token
    const fordSuccess = await this.refreshToken();
    if (!fordSuccess) {
      this.adapter.log.error('Ford token refresh retry failed');
      return;
    }

    this.adapter.log.info('Ford token refresh retry successful');
  }

  /**
   * Connect to Autonomic WebSocket for real-time vehicle updates
   * Uses native https.request like aiohttp for better compatibility
   */
  async connectWebSocket(vin) {
    if (!this.autonom || !this.autonom.access_token) {
      this.adapter.log.debug('No autonom token available for WebSocket connection');
      return;
    }

    this.currentWsVin = vin;
    this.adapter.log.info(`Connecting WebSocket for ${vin}...`);

    // Clean up existing connection
    this.safeCloseWs();

    // Generate WebSocket key (RFC 6455)
    const wsKey = crypto.randomBytes(16).toString('base64');

    // Headers exactly like ha-fordpass aiohttp (same order!)
    // apiHeaders: Accept-Encoding: gzip, Connection: Keep-Alive, User-Agent: okhttp/5.3.2, Content-Type: application/json
    const headers = {
      Host: 'api.autonomic.ai',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/5.3.2',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.autonom.access_token}`,
      'Application-Id': this.appId,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': wsKey,
    };

    const options = {
      hostname: 'api.autonomic.ai',
      port: 443,
      path: `/v1beta/telemetry/sources/fordpass/vehicles/${vin}/ws`,
      method: 'GET',
      headers: headers,
      // Python-compatible TLS settings (like Mercedes/aiohttp)
      ciphers: this.pythonCiphers,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: [],
      ecdhCurve: 'prime256v1:secp384r1:secp521r1:X25519',
    };

    this.adapter.log.debug('Connecting WebSocket with native https upgrade (Python-compatible TLS)');
    this.adapter.log.debug(`WebSocket URL: wss://api.autonomic.ai${options.path}`);
    this.adapter.log.debug(`WebSocket headers: ${JSON.stringify(headers)}`);

    const req = https.request(options);

    req.on('upgrade', (res, socket) => {
      this.adapter.log.info(`WebSocket connected for ${vin}`);
      this.adapter.log.debug(`WebSocket upgrade response status: ${res.statusCode}`);
      this.wsSocket = socket;
      this.wsCurrentToken = this.autonom.access_token;

      // NO ping interval - ha-fordpass and APK do NOT send WebSocket pings
      // NO fixed token refresh interval - ha-fordpass only checks on empty {} heartbeat messages
      // Token refresh is triggered in handleWsMessage when receiving empty {} from server

      let buffer = Buffer.alloc(0);

      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);

        while (true) {
          const frame = this.parseWsFrame(buffer);
          if (!frame) break;

          if (frame.opcode === 1 || frame.opcode === 2) {
            // Text or Binary frame
            this.handleWsMessage(vin, frame.payload);
          } else if (frame.opcode === 8) {
            // Close frame
            const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
            this.adapter.log.info(`WebSocket closed by server - code: ${code}`);
            this.cleanupWsConnection();
            socket.end();
            if (!this.isUnloading) {
              this.scheduleWsReconnect(vin, 'server-close-' + code);
            }
          } else if (frame.opcode === 9) {
            // Ping - send pong
            this.adapter.log.debug('Received ping, sending pong');
            const mask = crypto.randomBytes(4);
            socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), mask]));
          } else if (frame.opcode === 10) {
            // Pong
            this.adapter.log.debug('Received pong');
          }

          buffer = buffer.slice(frame.totalLen);
        }
      });

      socket.on('end', () => {
        if (!this.wsSocket) return;
        this.adapter.log.info('WebSocket connection ended');
        this.cleanupWsConnection();
        if (!this.isUnloading) {
          this.scheduleWsReconnect(vin, 'socket-end');
        }
      });

      socket.on('error', (err) => {
        if (!this.wsSocket) return;
        this.adapter.log.debug(`WebSocket error: ${err.message}`);
        this.cleanupWsConnection();
        if (!this.isUnloading) {
          this.scheduleWsReconnect(vin, 'socket-error');
        }
      });

      socket.on('close', () => {
        this.adapter.log.debug('WebSocket socket closed');
      });
    });

    req.on('response', (res) => {
      this.adapter.log.error(`WebSocket upgrade failed: HTTP ${res.statusCode}`);
      if (res.statusCode === 401) {
        this.adapter.log.warn('WebSocket 401 - Token may be expired, refreshing...');
        this.getAutonomToken().then(() => {
          if (!this.isUnloading) {
            this.scheduleWsReconnect(vin, 'auth-refresh');
          }
        });
      }
    });

    req.on('error', (err) => {
      this.adapter.log.error(`WebSocket connection error: ${err.message}`);
      if (!this.isUnloading) {
        this.scheduleWsReconnect(vin, 'connect-error');
      }
    });

    req.end();
  }

  /**
   * Parse incoming WebSocket frames (RFC 6455)
   */
  parseWsFrame(buffer) {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) return null;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) return null;
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    if (masked) offset += 4;
    if (buffer.length < offset + payloadLen) return null;

    let payload = buffer.slice(offset, offset + payloadLen);
    if (masked) {
      const mask = buffer.slice(offset - 4, offset);
      payload = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[offset + i] ^ mask[i % 4];
      }
    }

    return { opcode, payload, totalLen: offset + payloadLen };
  }

  /**
   * Send WebSocket frame (masked as per RFC 6455)
   */
  sendWsFrame(data) {
    if (!this.wsSocket) return;

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const payloadLen = payload.length;

    let header;
    if (payloadLen < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = 0x80 | payloadLen; // Masked + length
    } else if (payloadLen < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payloadLen, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payloadLen), 2);
    }

    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    this.wsSocket.write(Buffer.concat([header, mask, masked]));
  }

  /**
   * Handle incoming WebSocket message
   */
  async handleWsMessage(vin, payload) {
    try {
      const message = JSON.parse(payload.toString());
      this.adapter.log.debug(`WebSocket message received (${payload.length} bytes)`);
      this.adapter.log.debug(`WebSocket message content: ${JSON.stringify(message).substring(0, 500)}`);

      if (message._httpStatus) {
        this.adapter.log.debug(`WebSocket HTTP status response: ${message._httpStatus}`);
      } else if (message._error) {
        this.adapter.log.warn(`WebSocket error response: ${JSON.stringify(message._error)}`);
      } else if (message._data) {
        const wsData = message._data;
        this.adapter.log.debug(`WebSocket push event received for ${vin} - updating states`);
        this.adapter.log.debug(`WebSocket data keys: ${Object.keys(wsData).join(', ')}`);

        await this.json2iob.parse(vin + '.statusQuery', wsData, {
          forceIndex: true,
          autoCast: true,
          channelName: 'Current status via query of the car. Check your 12V battery regularly.',
        });

        if (wsData.metrics && wsData.metrics.batteryVoltage) {
          const current12V = wsData.metrics.batteryVoltage.value;
          if (current12V < 12.1) {
            this.adapter.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
          }
          this.last12V = current12V;
        }
      } else if (message.metrics || message.states || message.events) {
        this.adapter.log.debug(`WebSocket push event (direct format) received for ${vin} - updating states`);
        this.adapter.log.debug(`WebSocket data keys: ${Object.keys(message).join(', ')}`);
        await this.json2iob.parse(vin + '.statusQuery', message, {
          forceIndex: true,
          autoCast: true,
          channelName: 'Current status via query of the car. Check your 12V battery regularly.',
        });

        if (message.metrics && message.metrics.batteryVoltage) {
          const current12V = message.metrics.batteryVoltage.value;
          if (current12V < 12.1) {
            this.adapter.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
          }
          this.last12V = current12V;
        }
      } else if (Object.keys(message).length === 0) {
        // Empty {} heartbeat from server - trigger token refresh check (like ha-fordpass)
        this.adapter.log.debug(`WebSocket heartbeat {} received - checking tokens`);
        await this.checkAndRefreshAutonomToken();
      } else {
        this.adapter.log.debug(`WebSocket message type unknown - keys: ${Object.keys(message).join(', ')}`);
      }
    } catch (parseError) {
      this.adapter.log.debug(`Failed to parse WebSocket message: ${parseError}`);
      this.adapter.log.debug(`Raw payload (first 200 bytes): ${payload.toString().substring(0, 200)}`);
    }
  }

  /**
   * Update WebSocket with new access token (without reconnecting)
   */
  updateWebSocketToken() {
    if (this.wsSocket && this.autonom && this.autonom.access_token) {
      if (this.wsCurrentToken !== this.autonom.access_token) {
        this.adapter.log.debug('Updating WebSocket with new access token...');
        this.sendWsFrame(JSON.stringify({ accessToken: this.autonom.access_token }));
        this.wsCurrentToken = this.autonom.access_token;
      }
    }
  }

  /**
   * Check if Autonomic token needs refresh (45 seconds before expiry)
   */
  async checkAndRefreshAutonomToken() {
    if (!this.autonomExpiresAt) {
      this.adapter.log.debug('checkAndRefreshAutonomToken: no expiry time set');
      return;
    }

    const timeUntilExpiry = this.autonomExpiresAt - Date.now();
    const secondsUntilExpiry = Math.floor(timeUntilExpiry / 1000);

    this.adapter.log.debug(`Autonomic token check: expires in ${secondsUntilExpiry}s`);

    if (secondsUntilExpiry < 45) {
      this.adapter.log.debug(`Autonomic token expires in ${secondsUntilExpiry}s - refreshing...`);
      const success = await this.getAutonomToken();

      if (success && this.autonom && this.autonom.access_token) {
        this.adapter.log.debug('Autonomic token refreshed, updating WebSocket token...');
        this.updateWebSocketToken();
      } else {
        // Token refresh failed - getAutonomToken already handles stopping the adapter on 401
        this.adapter.log.warn('Autonomic token refresh failed - not updating WebSocket token');
      }
    }
  }

  /**
   * Safe WebSocket close helper
   */
  safeCloseWs() {
    try {
      if (this.wsSocket) {
        this.wsSocket.end();
        this.wsSocket = null;
      }
      this.clearWebSocketIntervals();
    } catch (err) {
      this.adapter.log.debug(`WebSocket close error (ignored): ${err}`);
    }
  }

  /**
   * Cleanup WebSocket connection state
   */
  cleanupWsConnection() {
    this.wsSocket = null;
    this.clearWebSocketIntervals();
  }

  /**
   * Schedule WebSocket reconnect
   */
  scheduleWsReconnect(vin, reason) {
    this.safeCloseWs();
    const delay = 30; // 30 seconds like ha-fordpass
    this.adapter.log.info(`Scheduling WebSocket reconnect in ${delay}s (reason: ${reason})`);
    this.wsReconnectTimeout = setTimeout(() => {
      this.connectWebSocket(vin);
    }, delay * 1000);
  }

  /**
   * Disconnect WebSocket connection
   */
  disconnectWebSocket() {
    this.clearWebSocketIntervals();
    this.safeCloseWs();
    this.wsCurrentToken = null;
  }

  /**
   * Clear WebSocket related intervals and timeouts
   */
  clearWebSocketIntervals() {
    if (this.wsHeartbeatInterval) {
      clearInterval(this.wsHeartbeatInterval);
      this.wsHeartbeatInterval = null;
    }
    if (this.wsTokenRefreshInterval) {
      clearInterval(this.wsTokenRefreshInterval);
      this.wsTokenRefreshInterval = null;
    }
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }
  }

  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.adapter.getObjectAsync(vin + '.statusv2');

      if (remoteState) {
        this.adapter.log.debug('clean old states' + vin);
        await this.adapter.delObjectAsync(vin + '.statusv2', { recursive: true });
        await this.adapter.delObjectAsync(vin + '.statususv4', { recursive: true });
        await this.adapter.delObjectAsync(vin + '.statususv5', { recursive: true });
      }
    }
  }

  /**
   * Generate FordConnect 2.0 Authorization URL
   * Uses static PKCE values for simplicity (code can only be used once anyway)
   */
  generateV2AuthUrl() {
    const authUrl = `${this.v2Config.login_url}/${this.v2Config.oauth_id}/B2C_1A_SignInSignUp_${this.v2Config.locale}/oauth2/v2.0/authorize`;

    const params = new URLSearchParams({
      redirect_uri: this.v2Config.redirect_uri,
      response_type: 'code',
      max_age: '3600',
      code_challenge: this.v2Config.code_challenge,
      code_challenge_method: 'S256',
      scope: ` ${this.v2Config.v2_clientId} openid`,
      client_id: this.v2Config.v2_clientId,
      ui_locales: this.v2Config.locale,
      language_code: this.v2Config.locale,
      ford_application_id: this.v2Config.appId,
      country_code: 'DEU',
    });

    return `${authUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token (v2 OAuth)
   */
  async exchangeCodeForTokenV2(code) {
    this.adapter.log.info('Exchanging authorization code for access token...');

    try {
      const tokenData = {
        grant_type: 'authorization_code',
        client_id: this.v2Config.v2_clientId,
        scope: `${this.v2Config.v2_clientId} openid`,
        redirect_uri: this.v2Config.redirect_uri,
        resource: '',
        code: code,
        code_verifier: this.v2Config.code_verifier,
      };

      const response = await this.requestClient({
        method: 'post',
        url: `${this.v2Config.login_url}/${this.v2Config.oauth_id}/B2C_1A_SignInSignUp_${this.v2Config.locale}/oauth2/v2.0/token`,
        headers: this.getBaseHeaders({ contentType: 'application/x-www-form-urlencoded', withAppId: false }),
        data: qs.stringify(tokenData),
        timeout: 30000,
      });

      const firstToken = response.data;
      this.adapter.log.info('OAuth token received, exchanging for FordConnect token...');

      // Use undici with HTTP/2 support for token exchange
      const finalTokenData = await this.undiciTokenRequest(
        'https://api.foundational.ford.com/api/token/v2/cat-with-b2c-access-token',
        { idpToken: firstToken.access_token },
      );

      this.sessionV2 = finalTokenData;
      this.session = finalTokenData;
      // Track Ford token expiry time
      if (finalTokenData.expires_in) {
        this.fordExpiresAt = Date.now() + finalTokenData.expires_in * 1000;
        this.adapter.log.debug(`Ford token expires at: ${new Date(this.fordExpiresAt).toISOString()}`);
      }
      this.adapter.setState('info.connection', true, true);
      this.adapter.log.info('Token exchange successful');
      this.adapter.log.info(`Token expires in: ${Math.floor(this.sessionV2.expires_in / 60)} minutes`);

      await this.adapter.extendObjectAsync('authV2', {
        type: 'state',
        common: {
          name: 'authV2',
          type: 'string',
          role: 'json',
          read: true,
          write: true,
        },
        native: {},
      });
      await this.adapter.setStateAsync('authV2', { val: JSON.stringify(this.sessionV2), ack: true });

      return true;
    } catch (error) {
      this.adapter.log.error('Token exchange failed');
      this.adapter.log.error(error.message);

      if (error.response) {
        this.adapter.log.error(`HTTP Status: ${error.response.status}`);
        this.adapter.log.error(JSON.stringify(error.response.data));
      }

      return false;
    }
  }

  /**
   * Clear all polling/refresh intervals and timeouts
   */
  clearAllIntervals() {
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = null;
    this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
    this.reLoginTimeout = null;
    this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
    this.refreshTokenTimeout = null;
    this.updateInterval && clearInterval(this.updateInterval);
    this.updateInterval = null;
    this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
    this.refreshTokenInterval = null;
  }

  /**
   * Is called when adapter shuts down.
   */
  async onUnload() {
    this.isUnloading = true;
    this.adapter.setState('info.connection', false, true);
    this.disconnectWebSocket();
    this.clearAllIntervals();

    // Clear v2_codeUrl after successful login to avoid reusing consumed code on next start
    if (this.session && this.session.access_token) {
      const adapterConfig = 'system.adapter.' + this.adapter.name + '.' + this.adapter.instance;
      const obj = await this.adapter.getForeignObjectAsync(adapterConfig);
      if (obj && obj.native && obj.native.v2_codeUrl) {
        obj.native.v2_codeUrl = '';
        await this.adapter.setForeignObjectAsync(adapterConfig, obj);
        this.adapter.log.debug('v2_codeUrl cleared from config');
      }
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const vin = id.split('.')[2];
    const command = id.split('.')[4];
    if (command === 'refresh' && state.val) {
      this.updateVehicles();
      return;
    }

    let headers;
    let url;
    let data;
    // Charge commands use Ford Vehicle API; all other commands use the Autonomic API.
    if (command === 'charge/start' || command === 'charge/pause') {
      let chargeCommand;
      if (command === 'charge/start') {
        chargeCommand = state.val ? 'START' : 'CANCEL';
      } else if (command === 'charge/pause') {
        chargeCommand = 'PAUSE';
      }

      url = `https://api.vehicle.ford.com/api/electrification/experiences/v2/vehicles/global-charge-command/${chargeCommand}`;
      headers = {
        ...this.getBaseHeaders({ withLocale: true }),
        'auth-token': this.session.access_token,
        vin: vin,
      };
      data = {};
    } else {
      await this.getAutonomToken();
      if (!this.autonom) {
        this.adapter.log.error('Failed to get autonom token');
        return;
      }
      headers = this.getAutonomicHeaders();
      url = 'https://api.autonomic.ai/v1/command/vehicles/' + vin + '/commands';
      data = {
        properties: {},
        tags: {},
        type: '',
        wakeUp: true,
      };
      if (command === 'status') {
        data.type = 'statusRefresh';
      }
      if (command === 'engine/start') {
        data.type = state.val ? 'remoteStart' : 'cancelRemoteStart';
      }
      if (command === 'doors/lock') {
        data.type = state.val ? 'lock' : 'unlock';
      }
    }

    await this.requestClient({
      method: 'post',
      url: url,
      headers: headers,
      data: data,
    })
      .then((res) => {
        this.adapter.log.info(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.adapter.log.error('Failed command: ' + command);
        this.adapter.log.error(error);
        if (error.response) {
          this.adapter.log.error(JSON.stringify(error.response.data));
        }
      });
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(async () => {
      await this.updateVehicles();
    }, 10 * 1000);
  }
}

module.exports = FordPassClient;
