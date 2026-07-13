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
    });
  }

  /** Called by Homebridge for every cached accessory it restores from disk. */
  configureAccessory(accessory) {
    this.log.debug?.(`[MyPlaceIQ] Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    try {
      const data = await this.client.getFullData();
      this.registerFromData(data);
      this.log.info(`[MyPlaceIQ] Connected to hub at ${this.config.host}:${this.config.port || 8086}`);
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

  async pollOnce() {
    try {
      const data = await this.client.getFullData();
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
   */
  refreshSoon(delayMs = 2000) {
    setTimeout(() => this.pollOnce(), delayMs);
  }
}

module.exports = { MyPlaceIQPlatform, PLUGIN_NAME, PLATFORM_NAME };
