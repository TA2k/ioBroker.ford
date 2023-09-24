"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const qs = require("qs");
const Json2iob = require("json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
class Ford extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "ford",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.vinArray = [];
    this.session = {};
    this.ignoredAPI = [];
    this.appId = "667D773E-1BDC-4139-8AD0-2B16474E8DC7";
    this.dyna = "MT_3_30_2352378557_3-0_" + uuidv4() + "_0_789_87";
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
    this.setState("info.connection", false, true);
    if (this.config.interval < 0.5) {
      this.log.info("Set interval to minimum 0.5");
      this.config.interval = 0.5;
    }

    this.subscribeStates("*");

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
    const formUrl = await this.requestClient({
      method: "get",
      url:
        "https://sso.ci.ford.com/v1.0/endpoint/default/authorize?redirect_uri=fordapp%3A%2F%2Fuserauthorized&response_type=code&scope=openid&max_age=3600&login_hint=eyJyZWFsbSI6ICJjbG91ZElkZW50aXR5UmVhbG0ifQ%3D%3D&code_challenge=" +
        codeChallenge +
        "&code_challenge_method=S256&client_id=9fb503e0-715b-47e8-adfd-ad4b7770f73b",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 12; SM-S906U Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.54 Mobile Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "accept-language": "de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6",
        "x-requested-with": "com.ford.fordpasseu",
      },
    })
      .then((res) => {
        // this.log.debug(res.data)
        return res.data.split('data-ibm-login-url="')[1].split('"')[0];
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });

    const response = await this.requestClient({
      method: "post",
      url: "https://sso.ci.ford.com" + formUrl,
      headers: {
        Host: "sso.ci.ford.com",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://sso.ci.ford.com",
        "accept-language": "de-de",
        "user-agent":
          "Mozilla/5.0 (Linux; Android 12; SM-S906U Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.54 Mobile Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "accept-language": "de-DE,de;q=0.9,en-DE;q=0.8,en-US;q=0.7,en;q=0.6",
        "x-requested-with": "com.ford.fordpasseu",
      },
      data: qs.stringify({ operation: "verify", "login-form-type": "pwd", username: this.config.username, password: this.config.password }),
    })
      .then((res) => {
        if (res.data.includes("data-ibm-login-error-text")) {
          this.log.error("Login failed");
          this.log.error(res.data.split('data-ibm-login-error-text="')[1].split('"')[0]);
          if (res.data.includes("CSIAH0320E")) {
            this.log.error(
              "Account blocked by Ford because of third party app usage. Please use contact ford to unblock your account and create a dummy account and share your car with this account. E.g. yourmail+ford1@gmail.com",
            );
          }
          return;
        }

        this.log.error(JSON.stringify(res.data));
        return;
      })
      .catch((error) => {
        if (error && error.message.includes("Unsupported protocol")) {
          return qs.parse(error.request._options.path.split("?")[1]);
        }

        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        return;
      });
    if (!response) {
      return;
    }

    const midToken = await this.requestClient({
      method: "post",
      url: "https://sso.ci.ford.com/oidc/endpoint/default/token",
      headers: {
        Host: "sso.ci.ford.com",
        "x-dynatrace": this.dyna,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "okhttp/4.9.2",
      },
      data: qs.stringify({
        client_id: "9fb503e0-715b-47e8-adfd-ad4b7770f73b",
        grant_type: "authorization_code",
        code_verifier: code_verifier,
        code: response.code,
        redirect_uri: "fordapp://userauthorized",
        scope: "openid",
        resource: "",
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));

        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    await this.requestClient({
      method: "post",
      url: "https://api.mps.ford.com/api/token/v2/cat-with-ci-access-token",

      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "application-id": this.appId,
        "user-agent": "okhttp/4.9.2",
        "accept-language": "de-de",
      },
      data: { ciToken: midToken.access_token },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState("info.connection", true, true);
        this.log.info("Login successful");
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async getVehicles() {
    const headers = {
      "content-type": "application/json",
      "application-id": this.appId,
      accept: "*/*",
      "x-dynatrace": this.dyna,
      "auth-token": this.session.access_token,
      locale: "DE-DE",
      "accept-language": "de-de",
      countrycode: "DEU",
      "user-agent": "okhttp/4.9.2",
    };
    await this.requestClient({
      method: "post",
      url: "https://api.mps.ford.com/api/expdashboard/v1/details/",
      headers: headers,
      data: JSON.stringify({
        dashboardRefreshRequest: "All",
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info(res.data.userVehicles.vehicleDetails.length + " vehicles found");
        for (const vehicle of res.data.userVehicles.vehicleDetails) {
          this.vinArray.push(vehicle.VIN);
          await this.setObjectNotExistsAsync(vehicle.VIN, {
            type: "device",
            common: {
              name: vehicle.nickName,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(vehicle.VIN + ".remote", {
            type: "channel",
            common: {
              name: "Remote Controls",
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(vehicle.VIN + ".general", {
            type: "channel",
            common: {
              name: "General Car Information",
            },
            native: {},
          });

          const remoteArray = [
            { command: "engine/start", name: "True = Start, False = Stop" },
            { command: "doors/lock", name: "True = Lock, False = Unlock" },
            { command: "status", name: "True = Request Status Update" },
            { command: "refresh", name: "True = Refresh Status" },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(vehicle.VIN + ".remote." + remote.command, {
              type: "state",
              common: {
                name: remote.name || "",
                type: remote.type || "boolean",
                role: remote.role || "boolean",
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(vehicle.VIN + ".general", vehicle);

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
          this.json2iob.parse(vehicle.VIN + ".general", vehicle);
        }
        for (const vehicle of res.data.vehicleCapabilities) {
          this.json2iob.parse(vehicle.VIN + ".capabilities", vehicle);
        }
      })
      .catch((error) => {
        this.log.error("failed to receive vehicles");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateVehicles() {
    await this.getAutonomToken();
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
        path: "statusQuery",
        url: "https://api.autonomic.ai/v1beta/telemetry/sources/fordpass/vehicles/$vin:query",
        desc: "Current status via query of the car. Check your 12V battery regularly.",
      },
    ];

    const headers = {
      "content-type": "application/json",
      "application-id": this.appId,
      accept: "*/*",
      "x-dynatrace": this.dyna,
      authorization: "Bearer " + this.autonom.access_token,
      "user-agent": "okhttp/4.10.0",
    };
    this.vinArray.forEach(async (vin) => {
      if (this.config.forceUpdate) {
        if (this.last12V < 12.1 && !this.config.skip12VCheck) {
          this.log.warn("12V battery is under 12.1V: " + this.last12V + "V - Skip force update from car");
          return;
        }
        this.log.debug("Force update of " + vin);
        await this.requestClient({
          method: "post",
          url: "https://api.autonomic.ai/v1/command/vehicles/" + vin + "/commands",
          headers: headers,
          data: {
            properties: {},
            tags: {},
            type: "statusRefresh",
            wakeUp: true,
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error("Failed to force update");
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
      }
      statusArray.forEach(async (element) => {
        this.log.debug("Updating " + element.path + " for " + vin);
        const url = element.url.replace("$vin", vin);
        if (this.ignoredAPI.indexOf(element.path) !== -1) {
          return;
        }
        await this.requestClient({
          method: "post",
          url: url,
          headers: headers,
          data: "{}",
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
            if (element.path === "fuelrec") {
              data = res.data.value.fuelRecs;
            }
            const forceIndex = null;
            const preferedArrayName = null;

            await this.json2iob.parse(vin + "." + element.path, data, {
              forceIndex: true,
              preferedArrayName: preferedArrayName,
              autoCast: true,
              channelName: element.desc,
            });
            if (data.metrics && data.metrics.batteryVoltage) {
              const current12V = data.metrics.batteryVoltage.value;
              if (current12V < 12.1) {
                this.log.warn("12V battery is under 12.1V: " + current12V + "V");
              }
              this.last12V = current12V;
            }
          })
          .catch((error) => {
            this.log.debug("Failed to update " + element.path + " for " + vin);
            if (error.response && error.response.status === 404) {
              this.ignoredAPI.push(element.path);
              this.log.info("Ignored API: " + element.path);
              return;
            }
            if (error.response && error.response.status === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.data));
              this.log.info(element.path + " receive 401 error. Refresh Token in 30 seconds");
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
      method: "post",
      url: "https://accounts.autonomic.ai/v1/auth/oidc/token",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
      },
      data: {
        subject_token: this.session.access_token,
        subject_issuer: "fordpass",
        client_id: "fordpass-prod",
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
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
      method: "post",
      url: "https://api.mps.ford.com/api/token/v2/cat-with-refresh-token",

      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "application-id": this.appId,
        "user-agent": "okhttp/4.9.2",
        "accept-language": "de-de",
      },
      data: { refresh_token: this.session.refresh_token },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState("info.connection", true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error("refresh token failed");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error("Start relogin in 1min");
        this.reLoginTimeout = setTimeout(() => {
          this.login();
        }, 1000 * 60 * 1);
      });
  }
  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.getObjectAsync(vin + ".statusv2");

      if (remoteState) {
        this.log.debug("clean old states" + vin);
        await this.delObjectAsync(vin + ".statusv2", { recursive: true });
        await this.delObjectAsync(vin + ".statususv4", { recursive: true });
        await this.delObjectAsync(vin + ".statususv5", { recursive: true });
      }
    }
  }

  getCodeChallenge() {
    let hash = "";
    let result = "";
    const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
    result = "";
    for (let i = 171; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash("sha256").update(result).digest("base64");
    hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/==/g, "=");

    return [result, hash];
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
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
        const vin = id.split(".")[2];

        const command = id.split(".")[4];
        if (command === "refresh" && state.val) {
          this.updateVehicles();
          return;
        }

        await this.getAutonomToken();
        const headers = {
          "content-type": "application/json",
          "application-id": this.appId,
          accept: "*/*",
          "x-dynatrace": this.dyna,
          authorization: "Bearer " + this.autonom.access_token,
          "user-agent": "okhttp/4.10.0",
        };
        const url = "https://api.autonomic.ai/v1/command/vehicles/" + vin + "/commands";
        const data = {
          properties: {},
          tags: {},
          type: "",
          wakeUp: true,
        };
        if (command === "status") {
          data.type = "statusRefresh";
        }
        if (command === "engine/start") {
          data.type = state.val ? "remoteStart" : "cancelRemoteStart";
        }
        if (command === "doors/lock") {
          data.type = state.val ? "lock" : "unlock";
        }
        await this.requestClient({
          method: "post",
          url: url,
          headers: headers,
          data: data,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error("Failed command: " + command);
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
