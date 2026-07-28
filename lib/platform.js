'use strict';

const { MyPlaceIQClient } = require('./client');
const { SystemAccessory } = require('./systemAccessory');
const { ZoneAccessory } = require('./zoneAccessory');

const PLUGIN_NAME = 'homebridge-myplaceiq';
const PLATFORM_NAME = 'MyPlaceIQ';

class MyPlaceIQPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // uuid -> cached PlatformAccessory (restored by Homebridge on restart)
    this.accessories = new Map();
    // active accessory handler instances (SystemAccessory / ZoneAccessory)
    this.handlers = [];
    this.pollTimer = null;

    if (!this.config.host || !this.config.clientId || !this.config.clientSecret) {
      this.log.error(
        '[MyPlaceIQ] Missing required config (host, clientId, clientSecret). Plugin will not start.',
      );
      return;
    }

    this.client = new MyPlaceIQClient({
      host: this.config.host,
      port: this.config.port || 8086,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      log: this.log,
    });

    this.pollIntervalMs = (this.config.pollInterval || 30) * 1000;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
    });
  }

  /** Called by Homebridge for every cached accessory it restores from disk. */
  configureAccessory(accessory) {
    this.log.debug?.(`[MyPlaceIQ] Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    try {
      const data = await this._guardedFetch();
      if (data) {
        this.registerFromData(data);
        this.log.info(`[MyPlaceIQ] Connected to hub at ${this.config.host}:${this.config.port || 8086}`);
      }
    } catch (err) {
      this.log.error(`[MyPlaceIQ] Initial connection failed: ${err.message}. Will keep retrying on the poll interval.`);
    }
    this.startPolling();
  }

  registerFromData(data) {
    const aircons = data.aircons || {};
    const zones = data.zones || {};
    const seenUUIDs = new Set();
    const newHandlers = [];

    // Whether to fold the whole-system control into a "primary" zone that
    // can't be independently closed (isClickable === false - e.g. a zone
    // named "Family" that always stays open), instead of also creating a
    // separate generic system accessory. Defaults on, since a non-closable
    // zone effectively *is* the system from the occupant's point of view.
    const useZoneAsSystem = !this.config || this.config.primaryZoneControlsSystem !== false;

    for (const [airconId, airconData] of Object.entries(aircons)) {
      const zoneOrder = airconData.zoneOrder || [];

      let primaryZoneId = null;
      if (useZoneAsSystem) {
        primaryZoneId = zoneOrder.find((zoneId) => {
          const z = zones[zoneId];
          return z && z.isVisible && z.isClickable === false;
        }) || null;
      }

      if (primaryZoneId) {
        // Represent the whole system through the non-closable zone's own
        // accessory: full Off/Heat/Cool thermostat + Dry/Fan switches, named
        // after the zone (e.g. "Family") rather than a separate accessory.
        const zoneData = zones[primaryZoneId];
        const uuid = this.api.hap.uuid.generate(`myplaceiq-zone-${primaryZoneId}`);
        seenUUIDs.add(uuid);
        const accessory = this.getOrCreateAccessory(uuid, zoneData.name || 'System');
        accessory.context.zoneId = primaryZoneId;
        accessory.context.airconId = airconId;
        accessory.context.isPrimaryZone = true;
        const handler = new SystemAccessory(this, accessory, airconId);
        handler.updateFromData(data);
        newHandlers.push(handler);
      } else {
        // No non-closable zone found (or the feature is disabled) - fall
        // back to a standalone system accessory, as before.
        const uuid = this.api.hap.uuid.generate(`myplaceiq-aircon-${airconId}`);
        seenUUIDs.add(uuid);
        const accessory = this.getOrCreateAccessory(uuid, airconData.name || 'Aircon');
        accessory.context.airconId = airconId;
        const handler = new SystemAccessory(this, accessory, airconId);
        handler.updateFromData(data);
        newHandlers.push(handler);
      }

      for (const zoneId of zoneOrder) {
        if (zoneId === primaryZoneId) continue; // already handled above
        const zoneData = zones[zoneId];
        if (!zoneData || !zoneData.isVisible) continue;

        const zUuid = this.api.hap.uuid.generate(`myplaceiq-zone-${zoneId}`);
        seenUUIDs.add(zUuid);
        const zAccessory = this.getOrCreateAccessory(zUuid, zoneData.name || 'Zone');
        zAccessory.context.zoneId = zoneId;
        zAccessory.context.airconId = airconId;
        const zHandler = new ZoneAccessory(this, zAccessory, zoneId, airconId);
        zHandler.updateFromData(data);
        newHandlers.push(zHandler);
      }
    }

    this.handlers = newHandlers;

    // Unregister any accessory from a previous run that no longer appears
    // in the hub's data (e.g. a zone was removed/hidden).
    const stale = [];
    for (const [uuid, accessory] of this.accessories.entries()) {
      if (!seenUUIDs.has(uuid)) {
        stale.push(accessory);
        this.accessories.delete(uuid);
      }
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`[MyPlaceIQ] Removed ${stale.length} stale accessory(ies).`);
    }
  }

  getOrCreateAccessory(uuid, displayName) {
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info(`[MyPlaceIQ] Added new accessory: ${displayName}`);
    } else if (accessory.displayName !== displayName) {
      // Name changed on the hub side - Homebridge doesn't let us rename
      // in place, but we can at least keep context/services in sync.
      accessory.displayName = displayName;
    }
    return accessory;
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  /** Runs client.getFullData() with a mutex so at most one request to the
   *  hub is ever in flight at a time, regardless of caller (startup
   *  discovery, the regular poll timer, or a post-command refresh). Returns
   *  null if a request was already in flight and this call was skipped.
   */
  async _guardedFetch() {
    if (this._pollInFlight) {
      this.log.debug?.('[MyPlaceIQ] Skipping fetch - one is already in flight.');
      return null;
    }
    this._pollInFlight = true;
    try {
      return await this.client.getFullData();
    } finally {
      this._pollInFlight = false;
    }
  }

  async pollOnce() {
    // The hub is a small embedded device and doesn't appear to handle
    // multiple concurrent WebSocket requests gracefully (seen as timeouts /
    // incomplete responses under real-world load), so every fetch - startup
    // discovery, this regular poll, and post-command refreshes - goes
    // through the same mutex in _guardedFetch() rather than opening
    // simultaneous connections to the hub.
    try {
      const data = await this._guardedFetch();
      if (!data) return; // another fetch was already in flight - skip this round
      for (const handler of this.handlers) {
        handler.updateFromData(data);
      }
    } catch (err) {
      this.log.warn(`[MyPlaceIQ] Poll failed: ${err.message}`);
    }
  }

  /** Called by accessory handlers after sending a command, to resync state
   *  a couple of seconds later (the hub needs a moment to reflect changes,
   *  mirroring the 2s delay used by the reference Home Assistant integration).
   *  Multiple calls within the delay window collapse into a single poll,
   *  rather than each command scheduling its own independent one - avoids
   *  piling up simultaneous requests to the hub when several commands land
   *  close together (e.g. HomeKit re-syncing several accessories at once).
   */
  refreshSoon(delayMs = 2000) {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.pollOnce();
    }, delayMs);
  }
}

module.exports = { MyPlaceIQPlatform, PLUGIN_NAME, PLATFORM_NAME };
