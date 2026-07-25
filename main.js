// @ts-nocheck
'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 *
 * Uses Ford's official FordConnect Query API (EU Data Act).
 * See https://developer.ford.com/developer-eu
 *
 * Simple OAuth2 authorization-code flow with client_id/client_secret,
 * followed by read-only telemetry queries. No reverse engineering,
 * no Autonomic token, no WebSocket - therefore no account blocking.
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');

const AUTH_URL = 'https://api.vehicle.ford.com/fcon-public/v1/auth/init';
const TOKEN_URL = 'https://api.vehicle.ford.com/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1A_FCON_AUTHORIZE';
const API_BASE = 'https://api.vehicle.ford.com/fcon-query/v1';

class Ford extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'ford',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.session = {};
    this.vinArray = [];
    this.updateInterval = null;
    this.requestClient = axios.create({ timeout: 30000 });
    this.json2iob = new Json2iob(this);
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    this.setState('info.connection', false, true);

    if (!this.config.interval || this.config.interval < 1) {
      this.config.interval = 15;
    }

    this.subscribeStates('*');

    await this.migrateOldObjects();

    if (!this.config.clientId || !this.config.clientSecret) {
      this.log.warn('Client ID and Client Secret are required. Please create an app at https://developer.ford.com/developer-eu and enter the credentials in the adapter settings.');
      return;
    }

    // 1. New login: user pasted the redirect URL with ?code=...
    if (this.config.codeUrl && this.config.codeUrl.includes('code=')) {
      const code = this.extractCode(this.config.codeUrl);
      if (!code) {
        this.log.error('Could not extract "code" parameter from the pasted Code URL.');
        return;
      }
      const success = await this.exchangeCodeForToken(code);
      if (!success) {
        return;
      }
      await this.clearCodeUrl();
    } else {
      // 2. Existing session -> refresh
      const auth = await this.getStateAsync('auth');
      if (auth && auth.val && typeof auth.val === 'string') {
        try {
          this.session = JSON.parse(auth.val);
        } catch {
          this.log.error('Failed to parse stored session. Please re-authenticate.');
          return;
        }
        const success = await this.refreshToken();
        if (!success) {
          return;
        }
      } else {
        // 3. No session and no code -> show login instructions
        this.log.warn('========================================');
        this.log.warn('FORD FORDCONNECT LOGIN REQUIRED');
        this.log.warn('========================================');
        this.log.warn('1. Open this URL in your browser:');
        this.log.warn('');
        this.log.warn(this.generateAuthUrl());
        this.log.warn('');
        this.log.warn('2. Log in with your FordPass account and authorize the app.');
        this.log.warn('3. You will be redirected to your Redirect URI with a "?code=..." parameter.');
        this.log.warn('4. Copy the complete redirect URL from the browser address bar.');
        this.log.warn('5. Paste it into the "Code URL" field in the adapter settings and save.');
        this.log.warn('========================================');
        return;
      }
    }

    // We have a valid session -> fetch data
    await this.getGarage();
    await this.getTelemetry();

    this.updateInterval = setInterval(async () => {
      await this.getTelemetry();
    }, this.config.interval * 60 * 1000);
  }

  /**
   * One-time migration: delete objects created by the old FordPass reverse-engineered
   * implementation (different state structure). Runs once, then sets migration.eudata=true.
   */
  async migrateOldObjects() {
    await this.extendObjectAsync('migration.eudata', {
      type: 'state',
      common: { name: 'EU Data migration done', type: 'boolean', role: 'indicator', read: true, write: false, def: false },
      native: {},
    });

    const done = await this.getStateAsync('migration.eudata');
    if (done && done.val === true) {
      return;
    }

    this.log.info('Running one-time migration: removing old objects from the previous FordPass implementation...');

    // Delete every top-level device/channel except the adapter's own info + migration channels.
    const keep = ['info', 'migration'];
    const channels = await this.getChannelsOfAsync();
    const devices = await this.getDevicesAsync();
    const nodes = [...devices, ...channels];
    const seen = new Set();
    for (const obj of nodes) {
      const id = obj._id.split('.')[2];
      if (!id || keep.includes(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      try {
        await this.delObjectAsync(id, { recursive: true });
        this.log.debug(`Migration: removed old object tree ${id}`);
      } catch (error) {
        this.log.debug(`Migration: could not remove ${id}: ${error && error.message}`);
      }
    }

    // Old session/PKCE states are incompatible with the new token type.
    for (const oldState of ['authV2', 'pkce']) {
      try {
        await this.delObjectAsync(oldState);
      } catch {
        // ignore if it does not exist
      }
    }

    await this.setStateAsync('migration.eudata', { val: true, ack: true });
    this.log.info('Migration finished.');
  }

  /**
   * Build the OAuth2 authorization URL.
   * @returns {string}
   */
  generateAuthUrl() {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      scope: 'openid offline_access',
      state: 'iobroker',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /**
   * Extract the "code" query parameter from a pasted redirect URL.
   * @param {string} url
   * @returns {string | null}
   */
  extractCode(url) {
    try {
      const query = url.includes('?') ? url.split('?')[1] : url;
      return new URLSearchParams(query).get('code');
    } catch {
      return null;
    }
  }

  /**
   * Exchange the authorization code for tokens.
   * @param {string} code
   * @returns {Promise<boolean>}
   */
  async exchangeCodeForToken(code) {
    this.log.info('Exchanging authorization code for access token...');
    const scope = `${this.config.clientId} offline_access openid`;
    try {
      const res = await this.requestClient({
        method: 'post',
        url: TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          code: code,
          scope: scope,
        }).toString(),
      });
      await this.saveSession(res.data);
      this.log.info('Login successful.');
      return true;
    } catch (error) {
      this.log.error('Failed to exchange code for token. The code may be expired - please repeat the login.');
      this.logRequestError(error);
      return false;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * @returns {Promise<boolean>}
   */
  async refreshToken() {
    if (!this.session.refresh_token) {
      this.log.warn('No refresh token available. Please re-authenticate.');
      return false;
    }
    const scope = `${this.config.clientId} offline_access openid`;
    try {
      const res = await this.requestClient({
        method: 'post',
        url: TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.session.refresh_token,
          redirect_uri: this.config.redirectUri,
          scope: scope,
        }).toString(),
      });
      await this.saveSession(res.data);
      this.log.debug('Token refreshed.');
      return true;
    } catch (error) {
      this.log.error('Token refresh failed. Please re-authenticate via the adapter settings (clear the auth state and log in again).');
      this.logRequestError(error);
      this.setState('info.connection', false, true);
      return false;
    }
  }

  /**
   * Return a valid access token, refreshing it if it is about to expire.
   * @returns {Promise<string | null>}
   */
  async getValidToken() {
    const expiresAt = (this.session.obtained_at || 0) + (this.session.expires_in || 0) * 1000;
    if (Date.now() > expiresAt - 60 * 1000) {
      const success = await this.refreshToken();
      if (!success) {
        return null;
      }
    }
    return this.session.access_token || null;
  }

  /**
   * Persist the session (adds obtained_at) to the "auth" state.
   * @param {object} data
   */
  async saveSession(data) {
    this.session = { ...data, obtained_at: Date.now() };
    await this.extendObjectAsync('auth', {
      type: 'state',
      common: { name: 'auth', type: 'string', role: 'json', read: true, write: true },
      native: {},
    });
    await this.setStateAsync('auth', { val: JSON.stringify(this.session), ack: true });
    this.setState('info.connection', true, true);
  }

  /**
   * Clear the codeUrl from the instance config so a consumed code is not reused.
   */
  async clearCodeUrl() {
    const adapterConfig = `system.adapter.${this.name}.${this.instance}`;
    const obj = await this.getForeignObjectAsync(adapterConfig);
    if (obj && obj.native && obj.native.codeUrl) {
      obj.native.codeUrl = '';
      await this.setForeignObjectAsync(adapterConfig, obj);
    }
  }

  /**
   * Fetch the list of vehicles (garage) and create their objects.
   */
  async getGarage() {
    const token = await this.getValidToken();
    if (!token) {
      return;
    }
    try {
      const res = await this.requestClient({
        method: 'get',
        url: `${API_BASE}/garage`,
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.data;
      const items = Array.isArray(data) ? data : data.vehicles || [data];
      this.vinArray = [];
      for (const vehicle of items) {
        const vin = vehicle.vin || vehicle.vehicleId;
        if (!vin) {
          continue;
        }
        this.vinArray.push(vin);
        await this.setObjectNotExistsAsync(vin, {
          type: 'device',
          common: { name: vehicle.nickName || vehicle.nickname || vin },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${vin}.general`, {
          type: 'channel',
          common: { name: 'General Car Information' },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${vin}.remote`, {
          type: 'channel',
          common: { name: 'Remote Controls' },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${vin}.remote.refresh`, {
          type: 'state',
          common: { name: 'True = Refresh telemetry now', type: 'boolean', role: 'button', read: true, write: true },
          native: {},
        });
        await this.json2iob.parse(`${vin}.general`, vehicle, { autoCast: true });
      }
      this.log.info(`${this.vinArray.length} vehicle(s) found`);
    } catch (error) {
      this.log.error('Failed to fetch garage');
      this.logRequestError(error);
    }
  }

  /**
   * Fetch telemetry for all vehicles and write it to states.
   */
  async getTelemetry() {
    const token = await this.getValidToken();
    if (!token) {
      return;
    }
    try {
      const res = await this.requestClient({
        method: 'get',
        url: `${API_BASE}/telemetry`,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.data) {
        return;
      }
      const items = Array.isArray(res.data) ? res.data : [res.data];
      for (const item of items) {
        const vin = item.vin || item.vehicleId || this.vinArray[0];
        if (!vin) {
          this.log.debug('Telemetry item without VIN - skipping');
          continue;
        }
        await this.json2iob.parse(`${vin}.telemetry`, item, {
          autoCast: true,
          channelName: 'Telemetry',
        });
      }
    } catch (error) {
      if (error.response && error.response.status === 429) {
        this.log.info('Rate limit reached (429) - skipping this telemetry poll.');
        return;
      }
      this.log.error('Failed to fetch telemetry');
      this.logRequestError(error);
    }
  }

  /**
   * Log an axios/request error without circular JSON issues.
   * @param {any} error
   */
  logRequestError(error) {
    if (error && error.message) {
      this.log.error(error.message);
    }
    if (error && error.response) {
      this.log.error(`HTTP Status: ${error.response.status}`);
      try {
        this.log.error(JSON.stringify(error.response.data));
      } catch {
        // ignore serialization issues
      }
    }
  }

  /**
   * Is called if a subscribed state changes.
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state && !state.ack) {
      const command = id.split('.').pop();
      if (command === 'refresh' && state.val) {
        await this.getTelemetry();
      }
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
        this.updateInterval = null;
      }
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Ford(options);
} else {
  // otherwise start the instance directly
  new Ford();
}
