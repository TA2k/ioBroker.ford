// @ts-nocheck
'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 *
 * Thin dispatcher. Selects one of two clients based on `config.mode` and
 * delegates the adapter lifecycle to it:
 *   - fordconnect: Ford's official FordConnect Query API (EU Data Act,
 *     read-only, no account blocking). See lib/fordconnect.js.
 *   - fordpass: FordPass (Autonomic token + WebSocket
 *     real-time push, remote commands). See lib/fordpass.js.
 */

const utils = require('@iobroker/adapter-core');
const FordConnectClient = require('./lib/fordconnect');
const FordPassClient = require('./lib/fordpass');

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

    this.client = null;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    const mode = this.config.mode || 'fordconnect';
    this.log.info(`Starting in "${mode}" mode`);
    this.client = mode === 'fordpass' ? new FordPassClient(this) : new FordConnectClient(this);
    await this.client.onReady();
  }

  /**
   * Is called if a subscribed state changes.
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (this.client) {
      await this.client.onStateChange(id, state);
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      if (this.client) {
        await this.client.onUnload();
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
