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
    // Query endpoints that returned 404 (not available for this vehicle) are
    // paused until the next adapter restart. In-memory Set resets on restart.
    this.pausedEndpoints = new Set();
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
      // 2. Existing session -> use it, refreshing only if expired
      const auth = await this.getStateAsync('auth');
      if (auth && auth.val && typeof auth.val === 'string') {
        try {
          this.session = JSON.parse(auth.val);
        } catch {
          this.log.error('Failed to parse stored session. Please re-authenticate.');
          return;
        }
        // getValidToken refreshes only when the token is missing or about to
        // expire - a transient refresh failure must not block a valid token.
        const token = await this.getValidToken();
        if (!token) {
          return;
        }
        this.setState('info.connection', true, true);
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
    await this.getExtraData();

    // Garage (vehicle list) only changes rarely - picked up on restart.
    this.updateInterval = this.setInterval(async () => {
      await this.getTelemetry();
      await this.getExtraData();
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
    let failures = 0;
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
        failures++;
        this.log.warn(`Migration: could not remove ${id}: ${error && error.message}`);
      }
    }

    // Delete old, incompatible session/PKCE states. This runs BEFORE the new
    // login writes the new "auth" session, so deleting "auth" here is safe:
    // an old "auth" value (v1.0.x B2C token) is incompatible with the new flow.
    for (const oldState of ['auth', 'authV2', 'pkce']) {
      try {
        await this.delObjectAsync(oldState);
      } catch {
        // ignore if it does not exist
      }
    }

    // Only mark migration as done if nothing failed, so a partial run is retried.
    if (failures === 0) {
      await this.setStateAsync('migration.eudata', { val: true, ack: true });
      this.log.info('Migration finished.');
    } else {
      this.log.warn(`Migration incomplete (${failures} object(s) could not be removed) - will retry on next start.`);
    }
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
      const ok = await this.saveSession(res.data);
      if (!ok) {
        return false;
      }
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
      const ok = await this.saveSession(res.data);
      if (!ok) {
        return false;
      }
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
   * Validates that an access token is present and keeps the existing
   * refresh token if the response does not include a new one.
   * @param {object} data
   * @returns {Promise<boolean>}
   */
  async saveSession(data) {
    if (!data || !data.access_token) {
      this.log.error('Token response did not contain an access_token.');
      return false;
    }
    // A refresh response may omit refresh_token - keep the previous one.
    const refresh_token = data.refresh_token || this.session.refresh_token;
    this.session = { ...data, refresh_token, obtained_at: Date.now() };
    await this.extendObjectAsync('auth', {
      type: 'state',
      common: { name: 'auth', type: 'string', role: 'json', read: true, write: true },
      native: {},
    });
    await this.setStateAsync('auth', { val: JSON.stringify(this.session), ack: true });
    this.setState('info.connection', true, true);
    return true;
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
   * GET a FordConnect Query endpoint with a valid token. On 401 it refreshes
   * the token once and retries. Returns the axios response or throws.
   * @param {string} path - path relative to API_BASE (e.g. "garage")
   * @returns {Promise<import('axios').AxiosResponse>}
   */
  async apiGet(path) {
    let token = await this.getValidToken();
    if (!token) {
      throw new Error('No valid token');
    }
    try {
      return await this.requestClient({
        method: 'get',
        url: `${API_BASE}/${path}`,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (error.response && error.response.status === 401) {
        this.log.debug(`401 on ${path} - refreshing token and retrying once`);
        const ok = await this.refreshToken();
        if (!ok) {
          throw error;
        }
        token = this.session.access_token;
        return await this.requestClient({
          method: 'get',
          url: `${API_BASE}/${path}`,
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      throw error;
    }
  }

  /**
   * Fetch the list of vehicles (garage) and create their objects.
   */
  async getGarage() {
    try {
      const res = await this.apiGet('garage');
      const data = res.data;
      const items = Array.isArray(data) ? data : data.vehicles || [data];
      const vins = [];
      for (const vehicle of items) {
        const vin = vehicle.vin || vehicle.vehicleId;
        if (!vin) {
          continue;
        }
        vins.push(vin);
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
      // Only replace the known VIN list if we actually got vehicles, so a
      // transient empty/failed response does not wipe it.
      if (vins.length) {
        this.vinArray = vins;
      }
      this.log.info(`${vins.length} vehicle(s) found`);
    } catch (error) {
      this.log.error('Failed to fetch garage');
      this.logRequestError(error);
    }
  }

  /**
   * Fetch telemetry for all vehicles and write it to states.
   */
  async getTelemetry() {
    try {
      const res = await this.apiGet('telemetry');
      if (!res.data) {
        return;
      }
      const items = Array.isArray(res.data) ? res.data : [res.data];
      for (const item of items) {
        const vin = this.resolveVin(item);
        if (!vin) {
          this.log.debug('Telemetry item without VIN and multiple/zero vehicles - skipping');
          continue;
        }
        // forceIndex so array metrics (doors, tires, ...) get indexed paths
        // instead of colliding on a shared field like updateTime.
        await this.json2iob.parse(`${vin}.telemetry`, item, {
          forceIndex: true,
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
   * Resolve the VIN for a response item. Uses the item's own vin/vehicleId,
   * and only falls back to the single known vehicle when exactly one exists
   * (never guesses in a multi-vehicle account).
   * @param {any} item
   * @returns {string | null}
   */
  resolveVin(item) {
    const vin = item && (item.vin || item.vehicleId);
    if (vin) {
      return vin;
    }
    if (this.vinArray.length === 1) {
      return this.vinArray[0];
    }
    return null;
  }

  /**
   * Additional read-only FordConnect Query endpoints (from the official
   * FordConnect 2.0 Postman collection). Not every endpoint exists for every
   * vehicle (e.g. wallbox/electric are EV-only), so errors are tolerated.
   */
  async getExtraData() {
    const endpoints = [
      { path: 'vehicle-health/alerts', name: 'vehicleHealthAlerts', desc: 'Vehicle Health Alerts' },
      { path: 'wallbox', name: 'wallbox', desc: 'Wallbox' },
      { path: 'electric/departure-times', name: 'departureTimes', desc: 'Electric Departure Times' },
      { path: 'electric/charge-schedules', name: 'chargeSchedules', desc: 'Electric Charge Schedules' },
    ];
    for (const ep of endpoints) {
      if (this.pausedEndpoints.has(ep.path)) {
        continue;
      }
      await this.fetchQuery(ep);
    }
  }

  /**
   * Fetch a single query endpoint and write the response to states.
   * Items are grouped by their own VIN (or the single known vehicle) and the
   * whole group array is parsed with forceIndex so multiple entries do not
   * overwrite each other.
   * @param {{path: string, name: string, desc: string}} ep
   */
  async fetchQuery(ep) {
    try {
      const res = await this.apiGet(ep.path);
      if (!res.data) {
        return;
      }
      // Non-array response (single object): write directly under the vehicle.
      if (!Array.isArray(res.data)) {
        const vin = this.resolveVin(res.data);
        if (!vin) {
          return;
        }
        await this.json2iob.parse(`${vin}.${ep.name}`, res.data, {
          forceIndex: true,
          autoCast: true,
          channelName: ep.desc,
        });
        return;
      }
      // Array response: group by VIN, then parse each group as an indexed array.
      const groups = {};
      for (const item of res.data) {
        const vin = this.resolveVin(item);
        if (!vin) {
          continue;
        }
        (groups[vin] = groups[vin] || []).push(item);
      }
      for (const vin of Object.keys(groups)) {
        await this.json2iob.parse(`${vin}.${ep.name}`, groups[vin], {
          forceIndex: true,
          autoCast: true,
          channelName: ep.desc,
        });
      }
    } catch (error) {
      // 404 = endpoint not applicable for this vehicle (e.g. wallbox on non-EV).
      // Pause it until the next restart so we do not query it every interval.
      if (error.response && error.response.status === 404) {
        this.pausedEndpoints.add(ep.path);
        this.log.debug(`${ep.path} not available (404) - paused until restart`);
        return;
      }
      if (error.response && error.response.status === 429) {
        this.log.debug(`Rate limit on ${ep.path} - skipping`);
        return;
      }
      // 401/403 indicate an auth/consent problem, not an unavailable endpoint.
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        this.log.warn(`${ep.path} returned ${error.response.status} - check authorization/consent for this data.`);
        return;
      }
      this.log.debug(`Failed to fetch ${ep.path}: ${error && error.message}`);
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
        await this.getExtraData();
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
        this.clearInterval(this.updateInterval);
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
