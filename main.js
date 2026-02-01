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
const WebSocket = require('ws');
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
    this.sessionV2 = {};
    this.autonomTokenV2 = null;
    this.ignoredAPI = [];
    this.appId = '667D773E-1BDC-4139-8AD0-2B16474E8DC7';
    this.cookieJar = new tough.CookieJar();
    this.ws = null;
    this.wsReconnectTimeout = null;
    this.wsHeartbeatInterval = null;
    this.isUnloading = false;

    // Dynatrace simulation - generate realistic looking headers
    this.dynatraceServerId = Math.floor(Math.random() * 9000000000) + 1000000000;
    this.dynatraceVisitorId = crypto.randomUUID();
    this.dynatraceActionCounter = 0;

    // Generate dynamic PKCE for each session
    const pkce = this.generatePKCE();

    // v2 OAuth config with dynamic PKCE
    this.v2Config = {
      oauth_id: '4566605f-43a7-400a-946e-89cc9fdb0bd7',
      v2_clientId: '09852200-05fd-41f6-8c21-d36d3497dc64',
      redirect_uri: 'fordapp://userauthorized',
      appId: '667D773E-1BDC-4139-8AD0-2B16474E8DC7',
      locale: 'de-DE',
      login_url: 'https://login.ford.de',
      code_verifier: pkce.code_verifier,
      code_challenge: pkce.code_challenge,
    };

    // const adapterConfig = {
    //   agent: new http2.Agent({
    //     /* options */
    //   }),
    //   force: true, // Force HTTP/2 without ALPN check - adapter will not check whether the endpoint supports http2 before the request
    // };

    // axios.defaults.adapter = createHTTP2Adapter(adapterConfig);
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

    this.subscribeStates('*');

    const auth = await this.getStateAsync('authV2');

    // Check if user provided code URL for v2 OAuth
    if (this.config.v2_codeUrl && this.config.v2_codeUrl.startsWith('fordapp://userauthorized')) {
      this.log.info('Found v2 Code URL, exchanging for token...');

      // Extract code from fordapp:// URL
      const urlParts = this.config.v2_codeUrl.split('?');
      if (urlParts.length > 1) {
        const params = qs.parse(urlParts[1]);
        const code = params.code;

        if (code && typeof code === 'string') {
          const success = await this.exchangeCodeForTokenV2(code);

          if (success) {
            // Clear the code URL after successful exchange
            this.log.info('Code exchanged for token successfully.');
            if (this.config.v2_codeUrl !== '') {
              this.setTimeout(async () => {
                this.log.info('Clearing v2 Code URL and restart Adapter.');
                const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
                const obj = await this.getForeignObjectAsync(adapterConfig);
                if (obj) {
                  obj.native.v2_codeUrl = '';
                  await this.setForeignObjectAsync(adapterConfig, obj);
                }
              }, 3000);
            }
          } else {
            this.log.error('Failed to exchange code for token');
            return;
          }
        } else {
          this.log.error('No code found in v2CodeUrl');
          return;
        }
      }
    } else if (auth && auth.val && typeof auth.val === 'string') {
      // Try to use existing session
      try {
        this.session = JSON.parse(auth.val);
        this.sessionV2 = this.session;
        this.log.info('Using existing session, refreshing token...');
        await this.refreshToken();
      } catch (error) {
        this.log.error('Failed to parse authV2 state');
        if (error instanceof Error) {
          this.log.error(error.message);
        }
        this.log.warn('Please delete the authV2 state and re-authenticate via adapter settings');
      }
    } else {
      // No code URL and no existing session - generate auth URL
      this.log.warn('========================================');
      this.log.warn('FORD OAUTH 2.0 LOGIN REQUIRED');
      this.log.warn('========================================');
      this.log.warn('');
      this.log.warn('Please follow these steps:');
      this.log.warn('1. Open Chrome and press F12 to open Developer Tools');
      this.log.warn('2. Go to the Network tab');
      this.log.warn('3. Copy and paste this URL in Chrome:');
      this.log.warn('');
      this.log.warn(this.generateV2AuthUrl());
      this.log.warn('');
      this.log.warn('4. Log in with your Ford account');
      this.log.warn('5. After redirect, the Login process will stuck. This is expected.');
      this.log.warn('6. COPY the complete red URL from network tab (starts with: fordapp://userauthorized/?code=)');
      this.log.warn('7. Paste it into the "v2 Code URL" field in adapter settings');
      this.log.warn('8. Save and restart the adapter');
      this.log.warn('');
      this.log.warn('========================================');
      return;
    }

    if (this.session.access_token) {
      await this.getVehicles();
      await this.cleanObjects();
      await this.updateVehicles();

      // Connect WebSocket for real-time updates (for each vehicle)
      for (const vin of this.vinArray) {
        await this.connectWebSocket(vin);
      }

      this.updateInterval = setInterval(async () => {
        await this.updateVehicles();
      }, this.config.interval * 60 * 1000);
      // check expires_in exist
      this.session.expires_in = this.session.expires_in || 1800;
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, (this.session.expires_in - 120) * 1000);
    }
  }
  async refreshTokenApi() {
    this.log.debug('Refresh Token');
    await this.requestClient({
      method: 'post',
      url: 'https://dah2vb2cprod.b2clogin.com/914d88b1-3523-4bf6-9be4-1b96b4f6f919/oauth2/v2.0/token?p=B2C_1A_signup_signin_common',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.secret,
        refresh_token: this.session.refresh_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        this.log.debug('Refresh Token successful');
        await this.extendObjectAsync('authV2', {
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
        await this.setStateAsync('authV2', { val: JSON.stringify(this.session), ack: true });
      })
      .catch((error) => {
        this.log.error('Failed to refresh token');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        this.log.warn('RECOMMENDATION: Delete the authV2 state and re-authenticate with a new login.');
      });
  }
  async loginApi() {
    const code = qs.parse(this.config.codeUrl.split('?')[1]).code;

    await this.requestClient({
      method: 'post',
      url: 'https://dah2vb2cprod.b2clogin.com/914d88b1-3523-4bf6-9be4-1b96b4f6f919/oauth2/v2.0/token?p=B2C_1A_signup_signin_common',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: {
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.secret,
        redirect_uri: 'https://localhost:3000',
        code: code,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        this.log.info('LoginAPI successful');
        await this.extendObjectAsync('authV2', {
          type: 'state',
          common: {
            name: 'authV2',
            type: 'string',
            role: 'state',
            read: true,
            write: true,
          },
          native: {},
        });
        await this.setStateAsync('authV2', { val: JSON.stringify(this.session), ack: true });
      })
      .catch(async (error) => {
        this.log.error('Failed to get token. Please restart the adapter and do a new login');
        this.log.warn('RECOMMENDATION: Delete the authV2 state and re-authenticate with a new login.');
        await this.delObjectAsync('authV2');
        const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
        const obj = await this.getForeignObjectAsync(adapterConfig);
        if (obj) {
          obj.native.connectUrl = '';
          await this.setForeignObjectAsync(adapterConfig, obj);
        } else {
          this.log.error('no Adapterconfig found');
        }
        this.log.error(error);

        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.data.error_description && error.response.data.error_description.includes('grant has expired')) {
            this.log.error('The code url is too old. Please provide a new one');
          }
        }
      });
  }

  async login() {
    // const [code_verifier, codeChallenge] = this.getCodeChallenge();

    const loginForm = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url:
        'https://login.ford.' +
        this.currentDomain +
        '/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/oauth2/v2.0/authorize',
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'x-requested-with': 'com.ford.fordpass',
        'accept-language': 'de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6',
      },
      params: {
        redirect_uri: 'fordapp://userauthorized',
        response_type: 'code',
        max_age: '3600',
        login_hint: 'eyJyZWFsbSI6ICJjbG91ZElkZW50aXR5UmVhbG0ifQ==',
        code_challenge: this.v2Config.code_challenge,
        code_challenge_method: 'S256',
        scope: '09852200-05fd-41f6-8c21-d36d3497dc64 openid',
        client_id: '09852200-05fd-41f6-8c21-d36d3497dc64',
        ui_locales: 'de-DE',
        language_code: 'de-DE',
        country_code: 'DEU',
        ford_application_id: this.appId,
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
    const data = `ewoJInNlbnNvcl9kYXRhIjogIjI7MzQyMjUxODs0NTk5ODU3OzE0LDAsMCwxLDIsMDtSWz59N1Y5fjdNLHlkeU9qNztRNy5FaFRFR05hVyA5TFJfO3g9dHhDbHNNXjppQVgoM01LM1YmbG9pYDM4ZXI2fkc4Okl9al89L1kyZ0J1KG8wWzMrYSk3ZyUuVXMwT3MhL3JzRXQoZSlMekVMWjhzRWxMfXlNLXlxNEFmLVZ1SFNwUl0yY2peI0ozckh6b35+QF0lPylLS1NbPHQ0byBeNmVhcVE2M0BVVHNzMnBOOip5Xm04RHdLMXs7dG55SkQxTk1ufVtmcDpjVW4qfTJzTClMZXJTNS82MEc4TTc+LEt0djZ0SWRxSGtnS10qKGZrLG14NCNefH5aclEtdDxFSGwgNCpnLEYjVFMmLXl7blooZTljNCE+SyNJM25TO3VCfC5INys+Vj8gbERyZ2tLTzIkLVJANXJlQ3tnRUdpUTFtKWI4L0RxZFM8NT1JP3dySWwrRzBrcHZYLH1ta0E7c1hxMTF+T3hmT0BPYWRxYmdYSmQ7OztaK21LSX5bVDlNLk50fXw/eWhaIWh0cDk1QX59UyM0Lkp5cE5JLUIyMHJTKlJkZCxuYVIoZSgsSFJxSlQjZHpzRHlfU2g6Pj1CKnlKJjc5MkpKOlRpJixXWHhwajkmQWEjXlNEYTdKMi5wN2A4VGRUSCsgTFImLV1gLCMgaE5hNVF+MXcqRUc1UD5CJFlqKCNQWFM2Mk50VHN+MDItYXE0e1JbVWpreSU7QTt6Yys4NCB2MFZxN0o2Vjd+O3V3I04zI3N8P0leY34jRW9de1JFez9MeD1tM20tW2cmZl8tQj0sVDU2Tzg4XmJtdUx2Sjc7S2M0Xy1hNm4wT2ZoWiZPTTZAUm8qbWolO0o4I2c0TyZPX0N8Sm5sKHN1RjtIY0VFNGNgfUBsNHVgd356TiB4bD1oV2RXNXdnLj1xdnZQdiwqRll6Qn1DdnFDRkkhU1hUKlRPZVgzKVJXWjQ8Qz1jW2kyQzM6bkR6OlRRWEtAfjZvQnBNSTcjI09vVVVxay8wQGUzWyt2Qi82XmR1WDdkZD9uY04+cnleSXFVaCVpamJmOF5AcVsyZyVgeTpqVG8oYDRgcHs4Ok1CflJuI0MrbyFZJERuLW0jeVBpJnE3SnB+YFI4fGhmWSxkdmAteGotcUt7ZHtkRl1hPVVxblZ2Oi1rWzRBXSN2V0IpSHZ7WzFAb1ZSTHttXkJtPGBQVHIxfHsxZnV+MkQjdW0uW1FUKEdJZ1czPDAgaD1bIW1tOGByeklEaWw4OnB5fEFocXZiNyhRWEJFKF9HP2U+OmE9bW5ZZ2owM0hKY1lMLWFqck5zcWpJNU06TC1wSnwgLWZRYzhSXS0qWWRvc2k0dzhXdEdCM1sqQTRIMTVaPEZfPmclckg4WHJGaWhkckpCUW08YHZrKGQufT4gKVM0WGhWM0NCcmo5Xi85XmhzTkxeeWctLzBMXmBYeCA3VD5We2dEUFMgO3cuaX5BQ2BXUVdBPnU8XV57NDpTZVI9NFBuY1RodkVXN2NRVlh4JnI6VG9lTl9uJCROZD0jO3tNdzI5W2Z2U3hWQF53Xmp9e29EcmFHXXJPPnd8T29pUk18V1I2Skl9ViwjcDojQElOOXdbWkFMaytdeGlNWWlZKlR4Xll+RiltO3RpfC4gUFtzTiQrIz9LLXJ5Qm9PSTlBdk0hXi1LNzdUMjEmcGJhZG5wJTVidkpsSDYzek5nJCxwIFVEMVJPbXRFRCovclBIK2FSZ1pRaS91U3xbSTQ1OiRsbjNWVHlMSzRDcGJBYzFDfjxyIFBqSy5uVkx3M01rMjVgO3Y+SX4peG9aVXhvdzI5eiQ7dDgkXzNsYjplZV9wY3o/Q2ZPTFUtcVFWNHAkUTcpQ2NGSCsuKGB9JE9yaSh7ODtPKl5zISszVFRkT18uIWEqL3RMNDR+S2RzWyZHcV4uSUVwa19nbHdlc2NRfXs8SkowXjR1KHhPPmhiek12ZSM/JjcwUHRndkhbbFkjP2d0NmFJcld4eFYsenJ+YG1XaUlCKj5EYl4qJjw0fVNpT0hqLTJfI2ZZbkU3SmgmQFEvWX1FZC95UVpMOS90blE/azggRHlCUmNEZnBFJk1jZFYwNTdZUzA9YmkuJD5oV2RHPlFTP0UoRDdMRUNtU2dXI3h3ezlSdTtbdER0eCBzKnUuXng7dn0vaEg/dCB1KU5hRC0yT0h2OXEwSE1eQDRpcGJ3T0IwRGlYU1RfOyFFbF5GW241YjZgPEJ+K3BZTXZFMXJ9MDVJIC5ONFI1LVdzfGosL2Apei9rOXJ+TDg8YyNjKVRUczBjcCA2STAuMF9qZ15RMDJdL3Y6ez1Wb1EjU0pMXWZucUxlQ24sc3hIKHoqQl43cl02P1MrMW9zJkFrdiNVSnE8cDFsdD4rMG1IRkNyOilTOihwRDBOITwmVkFIUXN0S3ZXNkpwNj0tck1hZ01XMmVXaVkkITwgJkF0WllnOkh+TDZZOFd4MTp8ZXQlWTAhVVMuLGxjRmBoMnVwbCE+dkIlaTEtOGhufXh0bS1fSiFbcmR3O0NvZlklbWh6fVd2cDsqV0cqSEtxYV1qd2c+LyUxOXd4bFFKQl9QTXI6TCZzS0RybzolJj01NE58V0M1MzUxPDB9amMwO1FdfUAmfG5TUDt4Uz1SOmteM2BGSDEmZWsmQ0UkdEd3LGouQi9xJUFRNjBmQ2pBRFdlNSRpK2koN0VXUjksMGxnY0B8dEtXNz4wO3Zid01daTJtWUpyWzMmSU1hVzd9QF1NLlQxfDRlVy0yIUZMfip9NGFJVj5AcmtIOVFVNEZie0ouQXNKLylobXl6MjA0eTB3SX1TcSs5TCgkS2s4Jk1GcV9TYC1NLVQ5cGpjRyxKdUFkLC55NF5je20qNnl1ZH1YcjwpKmBfaD0xPWtzcWlAPER8ITlNJFswSXhWW100KGgmQSBSbVBRNWFMcTpFWmdWQHkybGtQRjcsZiBeRyNuZiA9T0JpdCs1bm0/WTIgYTdHZj80clJXI2t4SVd7Q2Rlc3Q5VmBmamxXLDZHcjkqamIlcy1+eCBbaG1WYEN1WispdSoqIGdHUVE4bzlBYVYrKG9rVTgvPkAhO2s8dX1PfVF8V0IvQX4udFA7TSpjMkBpXj1ieF1DaE8qLmg1M3FgWUlaI2V+Y3swV053WlZLRD57UU0wN0tkUHZOLyBWSy1pRnt1I29oQ3NCVTlqLlVUWz43IEotZTQ/eTl0cS5eLF9GKzhuPkI2VTpMbEphNDpkPGJvLnMhfnN6U0Q/P0UySj5xT08rbHtfaWJDKzAzamxESVA9NSw+cHlTMFVxc2x5fW47IFNNMCA5bC9bXi9rd2dNP0I5PEU1THhefE1BQFBmSCBoPkM5M04zT3J0aTdTRyQqOzIkfnRrKXczXltQLT0pXmNAQyUkUEJiMiwoU31tZHFlNCUwIzYoL0hocSRkb2JFPnYtenheP2M9Pj5lSzotLi5QaDogNnYsRCQtPWg4IFhgZyVTYHE3WkJCKntRfSo+XWs8KGl0aGtFJlsoTShhSHNhOXRiR1VdP3lyOFlgXVY2VmEyNGpLXiohezxuTkNCUDhYUVpSTUFefj95dWxkLTpwdkJZMTkgcFd4LWxLVDpIUHVzMHwhWEdXeGNEYV8wYXAlW3tGX1NNOklxVi8tOWJvbiZHQlgpYy9NQk5NRCAwcjdtLmRfKW5ZJEE3LSYtUVQ6LD1JYkU3XSFvYH0wW31aNC8mYHM6KSVWdGZbaXQmQ2s1QkJjYUxxS0U9dWtEak4jYClgfEYzN2YySnotTHAwXWJCQz00IVUxU1h8QTZGKl9PeG99OjI9eF9Kdzs+Q1UwRSM3aUVQJF5gcjpbRHRnMTZiR2kwLDF5VmlHdzdxS24hXm5APD97XWV3QmNMKXtTUSZ0OilyI29Xcl17QntlJVQkVnF0IWZTb2dCb3IxMHZ3aUh4TWhvWUBjWSxRLW1Dbkt0RlhePTFLWUNrUEdOTjNqbzojK1MzIyQ/JFgsYU8jfS9ndykmZS9FIgp9`;

    await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://login.ford.com/EXMGLCqhRIBf/i4IHR2/QvWAKs/7zz9NGLwzki3/VwVb/OxU2/BFYBGg',
      headers: {
        Accept: '*/*',
        'Sec-Fetch-Site': 'same-origin',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Sec-Fetch-Mode': 'cors',
        'Content-Type': 'text/plain;charset=UTF-8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        Referer:
          'https://login.ford.' +
          this.currentDomain +
          '/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/oauth2/v2.0/authorize?redirect_uri=fordapp%3A%2F%2Fuserauthorized&response_type=code&scope=09852200-05fd-41f6-8c21-d36d3497dc64%20openid&max_age=3600&login_hint=eyJyZWFsbSI6ICJjbG91ZElkZW50aXR5UmVhbG0ifQ%3D%3D&code_challenge=' +
          this.v2Config.code_challenge +
          '&code_challenge_method=S256&client_id=09852200-05fd-41f6-8c21-d36d3497dc64&language_code=de-DE&ford_application_id=667D773E-1BDC-4139-8AD0-2B16474E8DC7&country_code=DEU',
        'Sec-Fetch-Dest': 'empty',
      },
      data: Buffer.from(data, 'base64').toString('utf-8'),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.info('Failed to submit akm bot data');
        this.log.info(error);
        if (error.response) {
          this.log.debug(JSON.stringify(error.response.data));
        }
      });
    await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url:
        'https://login.ford.' +
        this.currentDomain +
        '/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/SelfAsserted?tx=' +
        loginForm.transId +
        '&p=B2C_1A_SignInSignUp_de-DE',
      headers: {
        'x-csrf-token': loginForm.csrf,
        'user-agent':
          'Mozilla/5.0 (Linux; Android 9; ANE-LX1 Build/HUAWEIANE-L21; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://login.ford.' + this.currentDomain + '',
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
        'https://login.ford.' +
        this.currentDomain +
        '/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/api/CombinedSigninAndSignup/confirmed?rememberMe=false&csrf_token=' +
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
        this.log.warn('Check your username and password. Logout and Login in the Ford App');
        this.log.debug(JSON.stringify(res.data));
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
      url: 'https://login.ford.' + this.currentDomain + '/4566605f-43a7-400a-946e-89cc9fdb0bd7/B2C_1A_SignInSignUp_de-DE/oauth2/v2.0/token',
      headers: this.getBaseHeaders({ contentType: 'application/x-www-form-urlencoded', withAppId: false }),
      data: {
        client_id: '09852200-05fd-41f6-8c21-d36d3497dc64',
        scope: '09852200-05fd-41f6-8c21-d36d3497dc64 openid',
        redirect_uri: 'fordapp://userauthorized',
        grant_type: 'authorization_code',
        resource: '',
        code: response.code,
        code_verifier: this.v2Config.code_verifier,
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
      url: 'https://api.foundational.ford.com/api/token/v2/cat-with-b2c-access-token',
      headers: this.getBaseHeaders(),
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

  async getVehiclesApi() {
    await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url: 'https://api.mps.ford.com/api/fordconnect/v3/vehicles',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Application-Id': 'AFDC085B-377A-4351-B23E-5E1D35FB3700',
        Authorization: 'Bearer ' + this.session.access_token,
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        /* example
        {status: "SUCCESS", vehicles:[{vehicleId:"foo"}]}
      }
      */
        for (const vehicle of res.data.vehicles) {
          const name = vehicle.nickName;
          const vin = vehicle.vehicleId;
          this.vinArray.push(vin);
          this.setObjectNotExists(vin, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          this.setObjectNotExists(vin + '.status', {
            type: 'channel',
            common: {
              name: 'Car Status',
            },
            native: {},
          });
          this.setObjectNotExists(vin + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          this.setObjectNotExists(vin + '.general', {
            type: 'channel',
            common: {
              name: 'General Car Information',
            },
            native: {},
          });
          this.json2iob.parse(vin + '.general', vehicle);
          const remoteArray = [
            { command: 'engine/start', name: 'True = Start, False = Stop' },
            { command: 'charge/start', name: 'True = Start, False = Stop' },

            { command: 'cancelCharge', name: 'True = Cancel' },
            { command: 'location', name: 'True = Refresh Location' },
            { command: 'doors/lock', name: 'True = Lock, False = Unlock' },
            { command: 'status', name: 'True = Request Status Update' },
            { command: 'refresh', name: 'True = Refresh Status' },
          ];

          for (const remote of remoteArray) {
            this.setObjectNotExists(vin + '.remote.' + remote.command, {
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
          }

          this.requestClient({
            method: 'get',
            url: `https://api.mps.ford.com/api/fordconnect/v3/vehicles/${vin}/vin`,
            headers: {
              Accept: '*/*',
              'Content-Type': 'application/json',
              'Application-Id': 'AFDC085B-377A-4351-B23E-5E1D35FB3700',
              Authorization: 'Bearer ' + this.session.access_token,
            },
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
              await this.extendObjectAsync(vin + '.vin', {
                type: 'state',
                common: {
                  name: 'VIN',
                  type: 'string',
                  role: 'value',
                  read: true,
                  write: false,
                },
                native: {},
              });
              this.setState(vin + '.vin', res.data.vin, true);
            })
            .catch((error) => {
              this.log.error('Failed to get vin');
              this.log.error(error);
              if (error.response) {
                this.log.error(JSON.stringify(error.response.data));
              }
            });
        }
      })
      .catch((error) => {
        this.log.error('Failed to get vehicles');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }

  async updateVehicleApi() {
    for (const vin of this.vinArray) {
      await this.requestClient({
        method: 'get',
        url: `https://api.mps.ford.com/api/fordconnect/v3/vehicles/${vin}`,
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          'Application-Id': 'AFDC085B-377A-4351-B23E-5E1D35FB3700',
          Authorization: 'Bearer ' + this.session.access_token,
        },
      })
        .then((res) => {
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin + '.status', res.data);
        })
        .catch((error) => {
          if (error.response && error.response.status === 429) {
            this.log.info('Rate limit reached. Only one request per 5-15min are allowed');
            return;
          }
          this.log.error('Failed to update vehicle');
          this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
          }
        });
      if (this.config.locationUpdate) {
        await this.requestClient({
          method: 'get',
          url: `https://api.mps.ford.com/api/fordconnect/v3/vehicles/${vin}/location`,
          headers: {
            Accept: '*/*',
            'Content-Type': 'application/json',
            'Application-Id': 'AFDC085B-377A-4351-B23E-5E1D35FB3700',
            Authorization: 'Bearer ' + this.session.access_token,
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            this.json2iob.parse(vin + '.location', res.data);
          })
          .catch((error) => {
            if (error.response && error.response.status === 429) {
              this.log.info('Rate limit reached. Only one request per 5-15min are allowed');
              return;
            }
            this.log.error('Failed to update vehicle location');
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
      }
    }
  }
  async getVehicles() {
    // Ford expdashboard API needs: auth-token, Application-Id, countryCode, locale, x-dynatrace
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
            { command: 'charge/start', name: 'True = Start Charge, False = Cancel Charge' },
            { command: 'charge/pause', name: 'True = Pause Charge' },
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

    // Autonomic API only needs Authorization header - no Application-Id or Dynatrace
    const headers = this.getAutonomicHeaders();
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
            this.log.debug('Force update successful');
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            // 404 means vehicle doesn't support statusRefresh - this is normal for many vehicles
            if (error.response && error.response.status === 404) {
              this.log.debug('Force update not supported by vehicle (statusRefresh command not available)');
            } else {
              this.log.error('Failed to force update');
              this.log.error(error);
              if (error.response) {
                this.log.error(JSON.stringify(error.response.data));
              }
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

            const preferedArrayName = undefined;

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
   * Generate a realistic Dynatrace x-dynatrace header
   * Format: MT_<version>_<serverId>_<actionId>-<depth>_<visitorId>_<actionId>_<timing>_<sequenceNumber>
   */
  generateDynatraceHeader() {
    this.dynatraceActionCounter++;
    const actionId = this.dynatraceActionCounter;
    const depth = 0;
    const timing = Math.floor(Math.random() * 1000) + 100;
    const sequence = Math.floor(Math.random() * 500);

    return `MT_3_${this.dynatraceServerId}_${actionId}-${depth}_${this.dynatraceVisitorId}_${actionId}_${timing}_${sequence}`;
  }

  /**
   * Get base headers for Ford APIs (expdashboard, foundational, etc.)
   * @param {{contentType?: string, withAppId?: boolean, withDynatrace?: boolean, withLocale?: boolean}} [options] - Additional options
   * @returns {object} Headers object
   */
  getBaseHeaders(options) {
    const { contentType = 'application/json', withAppId = true, withDynatrace = true, withLocale = false } = options || {};

    const headers = {
      'Accept-Encoding': 'gzip',
      Connection: 'Keep-Alive',
      'Content-Type': contentType,
      'User-Agent': 'okhttp/4.12.0',
    };

    if (withAppId) {
      headers['Application-Id'] = this.appId;
    }

    if (withDynatrace) {
      headers['x-dynatrace'] = this.generateDynatraceHeader();
    }

    if (withLocale) {
      headers['countryCode'] = 'DEU';
      headers['locale'] = 'de-DE';
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
      'User-Agent': 'okhttp/4.12.0',
      Authorization: 'Bearer ' + this.autonom.access_token,
    };
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
    this.log.debug('Refreshing access token...');

    await this.requestClient({
      method: 'post',
      url: 'https://api.foundational.ford.com/api/token/v2/cat-with-refresh-token',
      headers: this.getBaseHeaders(),
      data: { refresh_token: this.session.refresh_token },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.sessionV2 = res.data;
        this.setState('info.connection', true, true);
        this.log.info('Token refresh successful');
        this.log.debug(`Token expires in: ${Math.floor(this.session.expires_in / 60)} minutes`);

        // Save updated session to authV2 state
        await this.extendObjectAsync('authV2', {
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
        await this.setStateAsync('authV2', { val: JSON.stringify(this.session), ack: true });

        return res.data;
      })
      .catch((error) => {
        this.log.error('Refresh token failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));

        // Token refresh failed - user needs to re-authenticate
        this.log.error('Token refresh failed. Please re-authenticate via adapter settings.');
        this.log.warn('RECOMMENDATION: Delete the authV2 state and re-authenticate with a new login.');
        this.log.error('The adapter will try again in 5 minutes...');

        this.reLoginTimeout = setTimeout(() => {
          this.refreshToken();
        }, 1000 * 60 * 5);
      });
  }

  /**
   * Connect to Autonomic WebSocket for real-time vehicle updates
   * This reduces polling and provides instant status updates
   */
  async connectWebSocket(vin) {
    if (!this.autonom || !this.autonom.access_token) {
      this.log.debug('No autonom token available for WebSocket connection');
      return;
    }

    const wsUrl = `wss://api.autonomic.ai/v1beta/telemetry/sources/fordpass/vehicles/${vin}/ws`;

    this.log.info(`Connecting WebSocket for ${vin}...`);

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.autonom.access_token}`,
          'User-Agent': 'okhttp/4.12.0',
        },
      });

      this.ws.on('open', () => {
        this.log.info(`WebSocket connected for ${vin}`);

        // Send initial subscription message
        const subscribeMsg = {
          action: 'subscribe',
          type: 'metrics',
        };
        this.ws.send(JSON.stringify(subscribeMsg));

        // Setup heartbeat to keep connection alive
        this.wsHeartbeatInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);
      });

      this.ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.log.debug(`WebSocket message: ${JSON.stringify(message)}`);

          // Handle different message types from Autonomic WebSocket
          if (message._httpStatus) {
            // HTTP status response (e.g., 202 for token accepted)
            this.log.debug(`WebSocket HTTP status: ${message._httpStatus}`);
          } else if (message._error) {
            // Error response
            this.log.warn(`WebSocket error: ${JSON.stringify(message._error)}`);
          } else if (message._data) {
            // Vehicle data update - merge into existing statusQuery like ha-fordpass does
            const wsData = message._data;
            this.log.debug(`WebSocket data received for ${vin}`);

            // Parse data directly into statusQuery (same location as REST API data)
            await this.json2iob.parse(vin + '.statusQuery', wsData, {
              forceIndex: true,
              autoCast: true,
              channelName: 'Current status via query of the car. Check your 12V battery regularly.',
            });

            // Update 12V battery if available
            if (wsData.metrics && wsData.metrics.batteryVoltage) {
              const current12V = wsData.metrics.batteryVoltage.value;
              if (current12V < 12.1) {
                this.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
              }
              this.last12V = current12V;
            }
          } else if (message.metrics || message.states || message.events) {
            // Direct data format (fallback)
            await this.json2iob.parse(vin + '.statusQuery', message, {
              forceIndex: true,
              autoCast: true,
              channelName: 'Current status via query of the car. Check your 12V battery regularly.',
            });

            if (message.metrics && message.metrics.batteryVoltage) {
              const current12V = message.metrics.batteryVoltage.value;
              if (current12V < 12.1) {
                this.log.warn('12V battery is under 12.1V: ' + current12V + 'V');
              }
              this.last12V = current12V;
            }
          }
        } catch (parseError) {
          this.log.debug(`Failed to parse WebSocket message: ${parseError}`);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.log.info(`WebSocket closed: ${code} - ${reason}`);
        this.clearWebSocketIntervals();

        // Reconnect after delay (unless adapter is stopping)
        if (!this.isUnloading) {
          this.wsReconnectTimeout = setTimeout(() => {
            this.log.info('Attempting WebSocket reconnection...');
            this.connectWebSocket(vin);
          }, 30000);
        }
      });

      this.ws.on('error', (error) => {
        this.log.debug(`WebSocket error: ${error.message}`);
      });

      this.ws.on('pong', () => {
        this.log.debug('WebSocket pong received');
      });
    } catch (error) {
      this.log.debug(`Failed to create WebSocket: ${error}`);
    }
  }

  /**
   * Disconnect WebSocket connection
   */
  disconnectWebSocket() {
    this.clearWebSocketIntervals();

    if (this.ws) {
      this.log.info('Closing WebSocket connection...');
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Clear WebSocket related intervals and timeouts
   */
  clearWebSocketIntervals() {
    if (this.wsHeartbeatInterval) {
      clearInterval(this.wsHeartbeatInterval);
      this.wsHeartbeatInterval = null;
    }
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }
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
    this.log.info('Exchanging authorization code for access token...');

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
      this.log.info('OAuth token received, exchanging for FordConnect token...');

      const finalTokenResponse = await this.requestClient({
        method: 'post',
        url: 'https://api.foundational.ford.com/api/token/v2/cat-with-b2c-access-token',
        headers: this.getBaseHeaders(),
        data: JSON.stringify({ idpToken: firstToken.access_token }),
        timeout: 30000,
      });

      this.sessionV2 = finalTokenResponse.data;
      this.session = finalTokenResponse.data;
      this.setState('info.connection', true, true);
      this.log.info('Token exchange successful');
      this.log.info(`Token expires in: ${Math.floor(this.sessionV2.expires_in / 60)} minutes`);

      await this.extendObjectAsync('authV2', {
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
      await this.setStateAsync('authV2', { val: JSON.stringify(this.sessionV2), ack: true });

      return true;
    } catch (error) {
      this.log.error('Token exchange failed');
      this.log.error(error.message);

      if (error.response) {
        this.log.error(`HTTP Status: ${error.response.status}`);
        this.log.error(JSON.stringify(error.response.data));
      }

      return false;
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.isUnloading = true;
      this.setState('info.connection', false, true);
      this.disconnectWebSocket();
      clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      clearInterval(this.refreshTokenInterval);
      callback();
    } catch {
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
        let headers;
        let url;
        let data;
        if (this.config.clientId) {
          let action = command;
          if (command === 'engine/start') {
            action = state.val ? 'startEngine' : 'stopEngine';
          }
          if (command === 'charge/start') {
            action = state.val ? 'startCharge' : 'stopCharge';
          }
          if (command === 'doors/lock') {
            action = state.val ? 'lock' : 'unlock';
          }

          url = 'https://api.mps.ford.com/api/fordconnect/v1/vehicles/' + vin + '/' + action;
          headers = {
            ...this.getBaseHeaders(),
            Accept: 'application/json',
            Authorization: 'Bearer ' + this.session.access_token,
          };
          data = {};
        } else {
          // Check if this is a charge command - uses Ford Vehicle API, not Autonomic
          if (command === 'charge/start' || command === 'charge/pause') {
            let chargeCommand;
            if (command === 'charge/start') {
              chargeCommand = state.val ? 'START' : 'CANCEL';
            } else if (command === 'charge/pause') {
              chargeCommand = 'PAUSE';
            }

            // Charge commands use Ford Vehicle API with v2 endpoint (from APK analysis)
            url = `https://api.vehicle.ford.com/api/electrification/experiences/v2/vehicles/global-charge-command/${chargeCommand}`;
            headers = {
              ...this.getBaseHeaders({ withLocale: true }),
              'auth-token': this.session.access_token,
              vin: vin,
            };
            data = {};
          } else {
            // Other commands use Autonomic API
            await this.getAutonomToken();
            if (!this.autonom) {
              this.log.error('Failed to get autonom token');
              return;
            }
            // Autonomic API only needs Authorization header
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
        }
        await this.requestClient({
          method: 'post',
          url: url,
          headers: headers,
          data: data,
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
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
          if (this.config.clientId) {
            await this.updateVehicleApi();
          } else {
            await this.updateVehicles();
          }
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
