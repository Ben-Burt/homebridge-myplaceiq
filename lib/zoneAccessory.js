'use strict';

/**
 * Represents one zone from MyPlaceIQ (body.zones[id]) as a Thermostat
 * restricted to Off/Auto. Zones only open/close - heat/cool/dry/fan is
 * chosen on the primary zone or the aircon unit, never per zone - so the
 * only choices a zone offers are "open" (Auto) and "closed" (Off). This
 * matches how the reference Home Assistant integration models zones. The
 * *current* state still shows Heat/Cool so the dial reflects what the
 * system is actually doing in that zone right now.
 */
class ZoneAccessory {
  constructor(platform, accessory, zoneId, airconId) {
    this.platform = platform;
    this.accessory = accessory;
    this.zoneId = zoneId;
    this.airconId = airconId;
    this.log = platform.log;

    const { Service, Characteristic } = platform;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.name = accessory.displayName;

    this.latestZone = null;
    this.latestAircon = null;
    this.priorityService = null;
    // Off by default: without this, any zone with isPriorityZoneAllowed gets
    // a second HomeKit tile (a Switch) alongside its Thermostat, which reads
    // as a confusing "temp setting and a switch" for a single zone.
    this.showPriority = !!(platform.config && platform.config.showPriorityZoneSwitch);

    const infoService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Advantage Air')
      .setCharacteristic(Characteristic.Model, 'MyPlaceIQ Zone')
      .setCharacteristic(Characteristic.SerialNumber, `zone-${zoneId}`)
      .setCharacteristic(Characteristic.FirmwareRevision, require('../package.json').version);

    this.thermostat = accessory.getService(Service.Thermostat)
      || accessory.addService(Service.Thermostat, this.name);

    this.thermostat.setCharacteristic(
      Characteristic.TemperatureDisplayUnits,
      Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    this.thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onSet(this.handleSetTargetHeatingCoolingState.bind(this));

    this.thermostat.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onSet(this.handleSetTargetTemperature.bind(this));

    if (!this.showPriority) {
      const staleSwitch = accessory.getServiceById(Service.Switch, 'priority');
      if (staleSwitch) accessory.removeService(staleSwitch);
    }
  }

  /** Refresh all HomeKit characteristics from a fresh getFullData() body. */
  updateFromData(data) {
    const zone = (data.zones || {})[this.zoneId];
    const aircon = (data.aircons || {})[this.airconId];
    if (!zone || !aircon) return;
    this.latestZone = zone;
    this.latestAircon = aircon;

    const { Characteristic, Service } = this;
    const isOn = !!zone.isOn;
    const systemOn = !!aircon.isOn;
    const mode = aircon.mode;

    // Target: open zone = Auto, closed zone = Off. Current: what the system
    // is actually doing in this zone right now (Heat/Cool), or Off if the
    // zone is closed or the system is off / in dry or fan mode.
    const targetState = isOn
      ? Characteristic.TargetHeatingCoolingState.AUTO
      : Characteristic.TargetHeatingCoolingState.OFF;
    const currentState = (isOn && systemOn)
      ? (mode === 'cool'
        ? Characteristic.CurrentHeatingCoolingState.COOL
        : mode === 'heat'
          ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF)
      : Characteristic.CurrentHeatingCoolingState.OFF;

    this.thermostat.updateCharacteristic(Characteristic.TargetHeatingCoolingState, targetState);
    this.thermostat.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentState);

    if (typeof zone.temperatureSensorValue === 'number') {
      this.thermostat.updateCharacteristic(
        Characteristic.CurrentTemperature,
        zone.temperatureSensorValue,
      );
    }

    const targetTemp = mode === 'cool' ? zone.targetTemperatureCool : zone.targetTemperatureHeat;
    if (typeof targetTemp === 'number') {
      this.thermostat.updateCharacteristic(Characteristic.TargetTemperature, targetTemp);
    }

    if (this.showPriority && zone.isPriorityZoneAllowed) {
      if (!this.priorityService) {
        this.priorityService = this.accessory.getServiceById(Service.Switch, 'priority')
          || this.accessory.addService(Service.Switch, `${this.name} Priority`, 'priority');
        this.priorityService.getCharacteristic(Characteristic.On)
          .onSet(this.handleSetPriority.bind(this));
      }
      this.priorityService.updateCharacteristic(Characteristic.On, !!zone.isPriorityZone);
    }
  }

  async handleSetTargetHeatingCoolingState(value) {
    const { Characteristic } = this;
    const isOpen = value !== Characteristic.TargetHeatingCoolingState.OFF;
    await this.sendAndRefresh(
      [{ __type: 'SetZoneOpenClose', zoneId: this.zoneId, isOpen }],
      `set ${isOpen ? 'Auto (open)' : 'Off (closed)'}`,
    );
  }

  async handleSetTargetTemperature(value) {
    const mode = this.latestAircon && this.latestAircon.mode === 'cool' ? 'cool' : 'heat';
    const type = mode === 'cool' ? 'SetZoneCoolTemperature' : 'SetZoneHeatTemperature';
    const temperature = Math.round(value * 2) / 2;
    await this.sendAndRefresh(
      [{ __type: type, zoneId: this.zoneId, temperature }],
      `set ${mode} target ${temperature}°C`,
    );
  }

  async handleSetPriority(value) {
    await this.sendAndRefresh(
      [{ __type: 'SetPriorityZone', zoneId: this.zoneId, priorityEnabled: !!value }],
      `set priority ${value ? 'on' : 'off'}`,
    );
  }

  async sendAndRefresh(commands, description) {
    this.platform.changeLog.command(this.name, description);
    try {
      await this.platform.client.sendCommand({ commands });
    } catch (err) {
      this.platform.changeLog.commandFailed(this.name, err.message);
      this.log.error(`[MyPlaceIQ] command failed for zone "${this.name}": ${err.message}`);
    }
    this.platform.refreshSoon();
  }
}

module.exports = { ZoneAccessory };
