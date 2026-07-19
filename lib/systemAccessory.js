'use strict';

/**
 * Represents one "aircon" system from MyPlaceIQ (body.aircons[id]) as:
 *  - a Thermostat service for Off / Heat / Cool + target temperature
 *  - a "Dry" switch and a "Fan" switch, since HomeKit's thermostat has no
 *    native dry/fan-only mode (same trick homebridge-myplace uses for the
 *    older MyAir/MyPlace API).
 */
class SystemAccessory {
  constructor(platform, accessory, airconId) {
    this.platform = platform;
    this.accessory = accessory;
    this.airconId = airconId;
    this.log = platform.log;

    const { Service, Characteristic } = platform;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.name = accessory.displayName;
    this.latestAircon = null;

    const infoService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Advantage Air')
      .setCharacteristic(Characteristic.Model, 'MyPlaceIQ Q-Hub')
      .setCharacteristic(Characteristic.SerialNumber, `aircon-${airconId}`)
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
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.COOL,
        ],
      })
      .onSet(this.handleSetTargetHeatingCoolingState.bind(this));

    this.thermostat.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onSet(this.handleSetTargetTemperature.bind(this));

    // Off by default: keeps Dry/Fan control. Set to true in config to remove
    // these two switches from HomeKit entirely (no Siri/automation access to
    // Dry or Fan mode either - there's no dial slot to fall back to).
    this.hideDryFanSwitches = !!(platform.config && platform.config.hideDryFanSwitches);

    if (this.hideDryFanSwitches) {
      this.dryModeService = null;
      this.fanModeService = null;
      // Clean up switches/services left over from a previous run/version, if any.
      const staleDry = accessory.getServiceById(Service.Switch, 'dry');
      if (staleDry) accessory.removeService(staleDry);
      const staleFanSwitch = accessory.getServiceById(Service.Switch, 'fan');
      if (staleFanSwitch) accessory.removeService(staleFanSwitch);
      const staleFanv2 = accessory.getServiceById(Service.Fanv2, 'fan');
      if (staleFanv2) accessory.removeService(staleFanv2);
    } else {
      this.dryModeService = accessory.getServiceById(Service.Switch, 'dry')
        || accessory.addService(Service.Switch, `${this.name} Dry Mode`, 'dry');
      this.dryModeService.getCharacteristic(Characteristic.On)
        .onSet((value) => this.handleSetModeSwitch('dry', value));

      // Fanv2 (not the older, deprecated "Fan" service) gets the proper
      // fan icon/tile in the Home app, rather than a plain switch toggle.
      // Clean up a Switch-based fan service left over from an older version
      // of this plugin, if present.
      const staleFanSwitch = accessory.getServiceById(Service.Switch, 'fan');
      if (staleFanSwitch) accessory.removeService(staleFanSwitch);

      this.fanModeService = accessory.getServiceById(Service.Fanv2, 'fan')
        || accessory.addService(Service.Fanv2, `${this.name} Fan Mode`, 'fan');
      this.fanModeService.getCharacteristic(Characteristic.Active)
        .onSet((value) => this.handleSetModeSwitch('fan', value === Characteristic.Active.ACTIVE));
    }
  }

  /** Refresh all HomeKit characteristics from a fresh getFullData() body. */
  updateFromData(data) {
    const aircon = (data.aircons || {})[this.airconId];
    if (!aircon) return;
    this.latestAircon = aircon;

    const { Characteristic } = this;
    const isOn = !!aircon.isOn;
    const mode = aircon.mode; // 'heat' | 'cool' | 'dry' | 'fan'

    const targetState = !isOn
      ? Characteristic.TargetHeatingCoolingState.OFF
      : mode === 'cool'
        ? Characteristic.TargetHeatingCoolingState.COOL
        : mode === 'heat'
          ? Characteristic.TargetHeatingCoolingState.HEAT
          // dry/fan have no thermostat equivalent; shown via the switches below
          : Characteristic.TargetHeatingCoolingState.OFF;

    const currentState = !isOn
      ? Characteristic.CurrentHeatingCoolingState.OFF
      : mode === 'cool'
        ? Characteristic.CurrentHeatingCoolingState.COOL
        : mode === 'heat'
          ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF;

    this.thermostat.updateCharacteristic(Characteristic.TargetHeatingCoolingState, targetState);
    this.thermostat.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentState);

    if (typeof aircon.actualTemperature === 'number') {
      this.thermostat.updateCharacteristic(
        Characteristic.CurrentTemperature,
        aircon.actualTemperature,
      );
    }

    const targetTemp = mode === 'cool' ? aircon.targetTemperatureCool : aircon.targetTemperatureHeat;
    if (typeof targetTemp === 'number') {
      this.thermostat.updateCharacteristic(Characteristic.TargetTemperature, targetTemp);
    }

    if (this.dryModeService) {
      this.dryModeService.updateCharacteristic(Characteristic.On, isOn && mode === 'dry');
    }
    if (this.fanModeService) {
      const fanActive = isOn && mode === 'fan';
      this.fanModeService.updateCharacteristic(
        Characteristic.Active,
        fanActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
    }
  }

  async handleSetTargetHeatingCoolingState(value) {
    const { Characteristic } = this;
    let commands;
    if (value === Characteristic.TargetHeatingCoolingState.OFF) {
      commands = [{ __type: 'SetAirconOnOff', airconId: this.airconId, isOn: false }];
    } else {
      const mode = value === Characteristic.TargetHeatingCoolingState.COOL ? 'cool' : 'heat';
      commands = [
        { __type: 'SetAirconOnOff', airconId: this.airconId, isOn: true },
        { __type: 'SetAirconMode', airconId: this.airconId, mode },
      ];
    }
    await this.sendAndRefresh(commands);
  }

  async handleSetTargetTemperature(value) {
    const mode = this.latestAircon && this.latestAircon.mode === 'cool' ? 'cool' : 'heat';
    const type = mode === 'cool' ? 'SetAirconCoolTemperature' : 'SetAirconHeatTemperature';
    const temperature = Math.round(value * 2) / 2;
    await this.sendAndRefresh([{ __type: type, airconId: this.airconId, temperature }]);
  }

  async handleSetModeSwitch(mode, on) {
    const commands = on
      ? [
        { __type: 'SetAirconOnOff', airconId: this.airconId, isOn: true },
        { __type: 'SetAirconMode', airconId: this.airconId, mode },
      ]
      : [{ __type: 'SetAirconOnOff', airconId: this.airconId, isOn: false }];
    await this.sendAndRefresh(commands);
  }

  async sendAndRefresh(commands) {
    try {
      await this.platform.client.sendCommand({ commands });
    } catch (err) {
      this.log.error(`[MyPlaceIQ] command failed for "${this.name}": ${err.message}`);
    }
    this.platform.refreshSoon();
  }
}

module.exports = { SystemAccessory };
