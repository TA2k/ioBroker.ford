"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");

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
        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create({
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                cookies: {
                    jar: this.cookieJar,
                },
            }),
        });
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

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.json2iob = new Json2iob(this);

        this.subscribeStates("*");

        await this.login();

        if (this.session.access_token) {
            await this.getVehicles();
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
        const formUrl = await this.requestClient({
            method: "get",
            url: "https://sso.ci.ford.com/v1.0/endpoint/default/authorize?redirect_uri=fordapp://userauthorized&response_type=code&scope=openid&max_age=3600&client_id=9fb503e0-715b-47e8-adfd-ad4b7770f73b&code_challenge=vlnpw-_VPsdi3hxmQFt46bPPTVFGMJkAOQklR2XCeHI%3D&code_challenge_method=S256",
            headers: {
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "de-de",
            },
        })
            .then((res) => {
                this.log.debug(res.data);
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
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1",
            },
            data: qs.stringify({ operation: "verify", "login-form-type": "pwd", username: this.config.username, password: this.config.password }),
        })
            .then((res) => {
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

                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": "FordPass/4 CFNetwork/1240.0.4 Darwin/20.6.0",
                "x-dynatrace": "MT_3_27_16346669642607_2-0_997d5837-2d14-4fbb-a338-5c70d678d40e_33_1_311",
                "accept-language": "de-de",
            },
            data: qs.stringify({
                client_id: "9fb503e0-715b-47e8-adfd-ad4b7770f73b",
                grant_type: "authorization_code",
                code_verifier: "K__PRhrIHq2spULUen11sSkDj0W9jfkDiHjX8zeGozs=",
                code: response.code,
                redirect_uri: "fordapp://userauthorized",
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
                "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
                "user-agent": "FordPass/8 CFNetwork/1240.0.4 Darwin/20.6.0",
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
            "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
            accept: "*/*",
            "auth-token": this.session.access_token,
            locale: "DE-DE",
            "accept-language": "de-de",
            countrycode: "DEU",
            "user-agent": "FordPass/5 CFNetwork/1240.0.4 Darwin/20.6.0",
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

                    this.requestClient({
                        method: "get",
                        url: "https://usapi.cv.ford.com/api/users/vehicles/" + vehicle.VIN + "/detail?lrdt=01-01-1970%2000:00:00",
                        headers: {
                            "content-type": "application/json",
                            "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
                            accept: "*/*",
                            "auth-token": this.session.access_token,
                            locale: "DE-DE",
                            "accept-language": "de-de",
                            countrycode: "DEU",
                            "user-agent": "FordPass/5 CFNetwork/1240.0.4 Darwin/20.6.0",
                        },
                    })
                        .then((res) => {
                            this.log.info("Received details");
                            this.log.debug(JSON.stringify(res.data));
                            this.json2iob.parse(vehicle.VIN + ".details", res.data.vehicle);
                        })
                        .catch((error) => {
                            this.log.error("Failed to receive details");
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        });
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
        const statusArray = [
            { path: "statusv2", url: "https://usapi.cv.ford.com/api/vehicles/v2/$vin/status", desc: "Current status v2 of the car" },
            { path: "statususv4", url: "https://usapi.cv.ford.com/api/vehicles/v4/$vin/status", desc: "Current status v4 of the car" },
            { path: "fuelrec", url: "https://api.mps.ford.com/api/fuel-consumption-info/v1/reports/fuel?vin=$vin", desc: "Fuel Record of the car" },
        ];

        const headers = {
            "content-type": "application/json",
            "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
            accept: "*/*",
            "auth-token": this.session.access_token,
            locale: "DE-DE",
            "accept-language": "de-de",
            countrycode: "DEU",
            "country-code": "DEU",
            "user-agent": "FordPass/5 CFNetwork/1240.0.4 Darwin/20.6.0",
        };
        this.vinArray.forEach(async (vin) => {
            if (this.config.forceUpdate) {
                this.log.debug("Force update of " + vin);
                await this.requestClient({
                    method: "put",
                    url: "https://usapi.cv.ford.com/api/vehicles/v2/" + vin + "/status",
                    headers: headers,
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
                    method: "get",
                    url: url,
                    headers: headers,
                })
                    .then((res) => {
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

                        this.json2iob.parse(vin + "." + element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName, channelName: element.desc });
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
                            clearTimeout(this.refreshTokenTimeout);
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

    async refreshToken() {
        await this.requestClient({
            method: "post",
            url: "https://api.mps.ford.com/api/token/v2/cat-with-refresh-token",

            headers: {
                accept: "*/*",
                "content-type": "application/json",
                "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
                "user-agent": "FordPass/8 CFNetwork/1240.0.4 Darwin/20.6.0",
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
                const headers = {
                    "content-type": "application/json",
                    "application-id": "1E8C7794-FF5F-49BC-9596-A1E0C86C5B19",
                    accept: "*/*",
                    "auth-token": this.session.access_token,
                    locale: "DE-DE",
                    "accept-language": "de-de",
                    countrycode: "DEU",
                    "user-agent": "FordPass/5 CFNetwork/1240.0.4 Darwin/20.6.0",
                };

                const url = "https://usapi.cv.ford.com/api/vehicles/v2/" + vin + "/" + command;
                let method = state.val ? "put" : "delete";
                if (command === "status") {
                    method = "put";
                }
                await this.requestClient({
                    method: method,
                    url: url,
                    headers: headers,
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
                const vin = id.split(".")[2];
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
