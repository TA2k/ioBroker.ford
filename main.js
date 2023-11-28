'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
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
    this.vinArray = [];
    this.session = {};
    this.ignoredAPI = [];
    this.appId = '667D773E-1BDC-4139-8AD0-2B16474E8DC7';
    this.dyna = 'MT_3_30_2352378557_3-0_' + uuidv4() + '_0_789_87';
    this.cookieJar = new tough.CookieJar();
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
    this.json2iob = new Json2iob(this);
    this.last12V = 12.2;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }

    if (!this.config.username || !this.config.password) {
      this.log.error('Username or password missing');
      return;
    }
    this.subscribeStates('*');

    await this.login();

    if (this.session.access_token) {
      await this.getVehicles();
      await this.cleanObjects();
      await this.updateVehicles();
      this.updateInterval = setInterval(async () => {
        await this.updateVehicles();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, (this.session.expires_in - 120) * 1000);
    }
  }
  async login() {
    let [code_verifier, codeChallenge] = this.getCodeChallenge();
    const loginForm = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url: 'https://login.ford.com/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/oauth2/v2.0/authorize?redirect_uri=fordapp%3A%2F%2Fuserauthorized&response_type=code&scope=09852200-05fd-41f6-8c21-d36d3497dc64%20openid&max_age=3600&login_hint=eyJyZWFsbSI6ICJjbG91ZElkZW50aXR5UmVhbG0ifQ%3D%3D&code_challenge=Jj_XmHuW1023dDe1d_E__hKcnAKWQccxmXFplxru798&code_challenge_method=S256&client_id=09852200-05fd-41f6-8c21-d36d3497dc64&language_code=de-DE&ford_application_id=667D773E-1BDC-4139-8AD0-2B16474E8DC7&country_code=DEU',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Linux; Android 9; ANE-LX1 Build/HUAWEIANE-L21; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'x-requested-with': 'com.ford.fordpasseu',

        'accept-language': 'de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6',
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return JSON.parse(res.data.split('SETTINGS = ')[1].split(';')[0]);
      })
      .catch((error) => {
        this.log.error('Failed to get login form');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!loginForm) {
      return;
    }
    if (!loginForm.csrf) {
      this.log.error('Failed to get csrf token');
      this.log.error(loginForm);
      return;
    }
    await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url:
        'https://login.ford.com/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/SelfAsserted?tx=StateProperties=' +
        loginForm.transId +
        '&p=B2C_1A_SignInSignUp_de-DE',
      headers: {
        'x-csrf-token': loginForm.csrf,
        'user-agent':
          'Mozilla/5.0 (Linux; Android 9; ANE-LX1 Build/HUAWEIANE-L21; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://login.ford.com',
        'accept-language': 'de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6',
      },
      data: { request_type: 'RESPONSE', signInName: this.config.username, password: this.config.password },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        if (error && error.message.includes('Unsupported protocol')) {
          return qs.parse(error.request._options.path.split('?')[1]);
        }
        this.log.error('Failed to first Azure Step');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        return;
      });

    const response = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url:
        'https://login.ford.com/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/api/CombinedSigninAndSignup/confirmed?rememberMe=false&csrf_token=' +
        loginForm.csrf +
        '&tx=StateProperties=' +
        loginForm.transId +
        '&p=B2C_1A_SignInSignUp_de-DE&diags=%7B%22pageViewId%22%3A%22f874578f-ba50-42ab-a280-e873359c7c13%22%2C%22pageId%22%3A%22CombinedSigninAndSignup%22%2C%22trace%22%3A%5B%7B%22ac%22%3A%22T005%22%2C%22acST%22%3A1699959720%2C%22acD%22%3A12%7D%2C%7B%22ac%22%3A%22T021%20-%20URL%3Ahttps%3A%2F%2Fprodb2cuicontentdelivery-d0bbevfjaxfmedda.z01.azurefd.net%2Fb2cui%2Fui%2Fford%2Fde-DE%2Funified.html%3Fver%3D20231016.2%26SessionId%3Da45accf4-bd4a-43c1-af9a-e5318144cbd2%26InstanceId%3Db5df47d1-52fa-410f-8cba-fbb9aa046cd0%22%2C%22acST%22%3A1699959720%2C%22acD%22%3A3872%7D%2C%7B%22ac%22%3A%22T019%22%2C%22acST%22%3A1699959724%2C%22acD%22%3A37%7D%2C%7B%22ac%22%3A%22T004%22%2C%22acST%22%3A1699959724%2C%22acD%22%3A15%7D%2C%7B%22ac%22%3A%22T003%22%2C%22acST%22%3A1699959724%2C%22acD%22%3A9%7D%2C%7B%22ac%22%3A%22T035%22%2C%22acST%22%3A1699959724%2C%22acD%22%3A0%7D%2C%7B%22ac%22%3A%22T030Online%22%2C%22acST%22%3A1699959724%2C%22acD%22%3A0%7D%2C%7B%22ac%22%3A%22T002%22%2C%22acST%22%3A1699959760%2C%22acD%22%3A0%7D%2C%7B%22ac%22%3A%22T018T010%22%2C%22acST%22%3A1699959758%2C%22acD%22%3A2084%7D%5D%7D',
      headers: {
        'upgrade-insecure-requests': '1',
        'user-agent':
          'Mozilla/5.0 (Linux; Android 9; ANE-LX1 Build/HUAWEIANE-L21; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'x-requested-with': 'com.ford.fordpasseu',
        'accept-language': 'de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6',
      },
    })
      .then((res) => {
        this.log.warn(JSON.stringify(res.data));
      })
      .catch((error) => {
        if (error && error.message.includes('Unsupported protocol')) {
          return qs.parse(error.request._options.path.split('?')[1]);
        }
        this.log.error('Failed to second Azure Step');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!response) {
      return;
    }
    const midToken = await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://login.ford.com/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/oauth2/v2.0/token',
      headers: {
        'x-dynatrace': 'MT_3_31_2178850551_22-0_997d5837-2d14-4fbb-a338-5c70d678d40e_0_11083_292',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'okhttp/4.11.0',
      },
      data: {
        client_id: '09852200-05fd-41f6-8c21-d36d3497dc64',
        scope: '09852200-05fd-41f6-8c21-d36d3497dc64 openid',
        redirect_uri: 'fordapp://userauthorized',
        grant_type: 'authorization_code',
        resource: '',
        code: response.code,
        code_verifier: 'FS_QIRCmJkRws7m8pcAfFQeZABp9cf6L0V_bSo9r60Q',
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));

        return res.data;
      })
      .catch((error) => {
        this.log.error('Failed to get mid token');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!midToken) {
      return;
    }
    await this.requestClient({
      method: 'post',
      url: 'https://api.mps.ford.com/api/token/v2/cat-with-b2c-access-token',

      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'application-id': this.appId,
        'user-agent': 'okhttp/4.9.2',
        'accept-language': 'de-de',
      },
      data: { idpToken: midToken.access_token },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        this.log.info('Login successful');
        return res.data;
      })
      .catch((error) => {
        this.log.error('Code Token failed');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async getVehicles() {
    const headers = {
      'content-type': 'application/json',
      'application-id': this.appId,
      accept: '*/*',
      'x-dynatrace': this.dyna,
      'auth-token': this.session.access_token,
      locale: 'DE-DE',
      'accept-language': 'de-de',
      countrycode: 'DEU',
      'user-agent': 'okhttp/4.9.2',
    };
    await this.requestClient({
      method: 'post',
      url: 'https://api.mps.ford.com/api/expdashboard/v1/details/',
      headers: headers,
      data: JSON.stringify({
        dashboardRefreshRequest: 'All',
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info(res.data.userVehicles.vehicleDetails.length + ' vehicles found');
        for (const vehicle of res.data.userVehicles.vehicleDetails) {
          this.vinArray.push(vehicle.VIN);
          await this.setObjectNotExistsAsync(vehicle.VIN, {
            type: 'device',
            common: {
              name: vehicle.nickName,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(vehicle.VIN + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(vehicle.VIN + '.general', {
            type: 'channel',
            common: {
              name: 'General Car Information',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'engine/start', name: 'True = Start, False = Stop' },
            { command: 'doors/lock', name: 'True = Lock, False = Unlock' },
            { command: 'status', name: 'True = Request Status Update' },
            { command: 'refresh', name: 'True = Refresh Status' },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(vehicle.VIN + '.remote.' + remote.command, {
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

          // this.requestClient({
          //     method: "get",
          //     url: "https://usapi.cv.ford.com/api/users/vehicles/" + vehicle.VIN + "/detail?lrdt=01-01-1970%2000:00:00",
          //     headers: {
          //         "content-type": "application/json",
          //         "application-id": this.appId,
          //         accept: "*/*",
          //         "auth-token": this.session.access_token,
          //         locale: "DE-DE",
          //         "accept-language": "de-de",
          //         countrycode: "DEU",
          //         "user-agent":"okhttp/4.9.2",
          //     },
          // })
          //     .then((res) => {
          //         this.log.info("Received details");
          //         this.log.debug(JSON.stringify(res.data));
          //         this.json2iob.parse(vehicle.VIN + ".details", res.data.vehicle);
          //     })
          //     .catch((error) => {
          //         this.log.error("Failed to receive details");
          //         this.log.error(error);
          //         error.response && this.log.error(JSON.stringify(error.response.data));
          //     });
        }
        for (const vehicle of res.data.vehicleProfile) {
          this.json2iob.parse(vehicle.VIN + '.general', vehicle);
        }
        for (const vehicle of res.data.vehicleCapabilities) {
          this.json2iob.parse(vehicle.VIN + '.capabilities', vehicle);
        }
      })
      .catch((error) => {
        this.log.error('failed to receive vehicles');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateVehicles() {
    await this.getAutonomToken();
    if (!this.autonom) {
      this.log.error('Failed to get autonom token');
      return;
    }
    const statusArray = [
      // { path: "statusv2", url: "https://usapi.cv.ford.com/api/vehicles/v2/$vin/status", desc: "Current status v2 of the car" },
      // { path: "statususv4", url: "https://usapi.cv.ford.com/api/vehicles/v4/$vin/status", desc: "Current status v4 of the car" },
      // { path: "statususv5", url: "https://usapi.cv.ford.com/api/vehicles/v5/$vin/status", desc: "Current status v5 of the car" },
      // {
      //   path: "fuelrec",
      //   url: "https://api.mps.ford.com/api/fuel-consumption-info/v1/reports/fuel?vin=$vin",
      //   desc: "Fuel Record of the car",
      // },
      {
        path: 'statusQuery',
        url: 'https://api.autonomic.ai/v1beta/telemetry/sources/fordpass/vehicles/$vin:query',
        desc: 'Current status via query of the car. Check your 12V battery regularly.',
      },
    ];

    const headers = {
      'content-type': 'application/json',
      'application-id': this.appId,
      accept: '*/*',
      'x-dynatrace': this.dyna,
      authorization: 'Bearer ' + this.autonom.access_token,
      'user-agent': 'okhttp/4.10.0',
    };
    this.vinArray.forEach(async (vin) => {
      if (this.config.forceUpdate) {
        if (this.last12V < 12.1 && !this.config.skip12VCheck) {
          this.log.warn('12V battery is under 12.1V: ' + this.last12V + 'V - Skip force update from car');
          return;
        }
        this.log.debug('Force update of ' + vin);
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
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('Failed to force update');
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
      }
      statusArray.forEach(async (element) => {
        this.log.debug('Updating ' + element.path + ' for ' + vin);
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
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            const keys = Object.keys(res.data);
            if (keys.length === 1) {
              data = res.data[keys[0]];
            }
            if (element.path === 'fuelrec') {
              data = res.data.value.fuelRecs;
            }
            const forceIndex = null;
            const preferedArrayName = null;

            await this.json2iob.parse(vin + '.' + element.path, data, {
              forceIndex: true,
              preferedArrayName: preferedArrayName,
              autoCast: true,
              channelName: element.desc,
            });
            if (data.metrics && data.metrics.batteryVoltage) {
              const current12V = data.metrics.batteryVoltage.value;
              if (current12V < 12.1) {
                this.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
              }
              this.last12V = current12V;
            }
          })
          .catch((error) => {
            this.log.debug('Failed to update ' + element.path + ' for ' + vin);
            if (error.response && error.response.status === 404) {
              this.ignoredAPI.push(element.path);
              this.log.info('Ignored API: ' + element.path);
              return;
            }
            if (error.response && error.response.status === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.data));
              this.log.info(element.path + ' receive 401 error. Refresh Token in 30 seconds');
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 1000 * 30);

              return;
            }

            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      });
    });
  }

  async getAutonomToken() {
    await this.requestClient({
      method: 'post',
      url: 'https://accounts.autonomic.ai/v1/auth/oidc/token',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: {
        subject_token: this.session.access_token,
        subject_issuer: 'fordpass',
        client_id: 'fordpass-prod',
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.autonom = res.data;
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }

  async refreshToken() {
    await this.requestClient({
      method: 'post',
      url: 'https://api.mps.ford.com/api/token/v2/cat-with-refresh-token',

      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'application-id': this.appId,
        'user-agent': 'okhttp/4.11.0',
        'accept-language': 'de-de',
      },
      data: { refresh_token: this.session.refresh_token },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error('refresh token failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error('Start relogin in 1min');
        this.reLoginTimeout = setTimeout(() => {
          this.login();
        }, 1000 * 60 * 1);
      });
  }
  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.getObjectAsync(vin + '.statusv2');

      if (remoteState) {
        this.log.debug('clean old states' + vin);
        await this.delObjectAsync(vin + '.statusv2', { recursive: true });
        await this.delObjectAsync(vin + '.statususv4', { recursive: true });
        await this.delObjectAsync(vin + '.statususv5', { recursive: true });
      }
    }
  }

  getCodeChallenge() {
    let hash = '';
    let result = '';
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
    result = '';
    for (let i = 171; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash('sha256').update(result).digest('base64');
    hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/==/g, '=');

    return [result, hash];
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      clearTimeout(this.refreshTimeout);
      clearTimeout(this.reLoginTimeout);
      clearTimeout(this.refreshTokenTimeout);
      clearInterval(this.updateInterval);
      clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const vin = id.split('.')[2];

        const command = id.split('.')[4];
        if (command === 'refresh' && state.val) {
          this.updateVehicles();
          return;
        }

        await this.getAutonomToken();
        if (!this.autonom) {
          this.log.error('Failed to get autonom token');
          return;
        }
        const headers = {
          'content-type': 'application/json',
          'application-id': this.appId,
          accept: '*/*',
          'x-dynatrace': this.dyna,
          authorization: 'Bearer ' + this.autonom.access_token,
          'user-agent': 'okhttp/4.10.0',
        };
        const url = 'https://api.autonomic.ai/v1/command/vehicles/' + vin + '/commands';
        const data = {
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
        await this.requestClient({
          method: 'post',
          url: url,
          headers: headers,
          data: data,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('Failed command: ' + command);
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateVehicles();
        }, 10 * 1000);
      } else {
        // const resultDict = { chargingStatus: "CHARGE_NOW", doorLockState: "DOOR_LOCK" };
        // const idArray = id.split(".");
        // const stateName = idArray[idArray.length - 1];
        // const vin = id.split(".")[2];
        // if (resultDict[stateName]) {
        //     let value = true;
        //     if (!state.val || state.val === "INVALID" || state.val === "NOT_CHARGING" || state.val === "ERROR" || state.val === "UNLOCKED") {
        //         value = false;
        //     }
        //     await this.setStateAsync(vin + ".remote." + resultDict[stateName], value, true);
        // }
      }
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
