'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

/**
 * Talks to a MyPlaceIQ Q-Hub over its WebSocket API.
 *
 * Ported from the protocol used by the anwickes/myplaceiq Home Assistant
 * integration (custom_components/myplaceiq/myplaceiq.py):
 *   - Connect to ws://<host>:<port>/ws
 *   - Authenticate via the `client_id` / `password` HTTP headers on the
 *     WebSocket handshake (there is no in-band login message).
 *   - Each request is its own short-lived connection: connect, send one
 *     JSON envelope, optionally wait for one JSON reply, then disconnect.
 *   - Envelope shape: { uuid: "<uuid>", body: "<JSON-encoded command>" }
 *   - Command shape: { commands: [ { __type: "SomeCommand", ...fields } ] }
 */
class MyPlaceIQClient {
  constructor({ host, port, clientId, clientSecret, log }) {
    this.url = `ws://${host}:${port}/ws`;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.log = log || console;
  }

  /**
   * Send a command envelope to the hub.
   * @param {object} command - e.g. { commands: [{ __type: 'GetFullDataEvent' }] }
   * @param {boolean} awaitResponse - wait for and return the hub's JSON reply
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  sendCommand(command, awaitResponse = false, opts = {}) {
    const {
      maxRetries = 3,
      connectTimeoutMs = 5000,
      responseTimeoutMs = 10000,
      retryDelayMs = 1000,
    } = opts;

    const message = { uuid: randomUUID(), body: JSON.stringify(command) };

    const attempt = (attemptsLeft) => new Promise((resolve, reject) => {
      let settled = false;
      let responseTimer = null;

      const ws = new WebSocket(this.url, {
        headers: { client_id: this.clientId, password: this.clientSecret },
        handshakeTimeout: connectTimeoutMs,
      });

      const cleanup = () => {
        if (responseTimer) clearTimeout(responseTimer);
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try { ws.terminate(); } catch (_err) { /* already closing */ }
        }
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (attemptsLeft > 1) {
          this.log.debug?.(
            `[MyPlaceIQ] command attempt failed (${attemptsLeft - 1} retries left): ${err.message}`,
          );
          setTimeout(() => {
            attempt(attemptsLeft - 1).then(resolve, reject);
          }, retryDelayMs);
        } else {
          reject(err);
        }
      };

      const succeed = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      ws.once('error', (err) => fail(err));
      ws.once('unexpected-response', (_req, res) => {
        fail(new Error(`Unexpected response from hub: HTTP ${res.statusCode}`));
      });
      ws.once('close', (code) => {
        // A clean close before we've settled means the hub hung up on us
        // mid-request (e.g. rebooting, or dropped the connection under
        // load) - fail fast instead of waiting out the full response
        // timeout, so retries kick in sooner.
        fail(new Error(`Connection closed unexpectedly (code ${code})`));
      });

      ws.once('open', () => {
        ws.send(JSON.stringify(message), (err) => {
          if (err) return fail(err);
          if (!awaitResponse) {
            return succeed({ status: 'sent' });
          }
          responseTimer = setTimeout(() => {
            fail(new Error('Timed out waiting for response'));
          }, responseTimeoutMs);

          ws.once('message', (data) => {
            try {
              succeed(JSON.parse(data.toString()));
            } catch (parseErr) {
              fail(parseErr);
            }
          });
        });
      });
    });

    return attempt(maxRetries);
  }

  /**
   * Convenience wrapper for the GetFullDataEvent command, returning the
   * already-JSON-parsed { aircons, zones } body.
   */
  async getFullData() {
    const response = await this.sendCommand(
      { commands: [{ __type: 'GetFullDataEvent' }] },
      true,
    );
    if (!response || typeof response.body !== 'string') {
      throw new Error('Invalid response from MyPlaceIQ hub (missing body)');
    }
    const body = JSON.parse(response.body);
    if (!body || !body.aircons || !body.zones) {
      throw new Error('Incomplete response from MyPlaceIQ hub (missing aircons/zones)');
    }
    return body;
  }
}

module.exports = { MyPlaceIQClient };
