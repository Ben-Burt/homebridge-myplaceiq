# Changelog

All notable changes to this project are documented here.

## [0.0.6]
### Added
- Every accessory now populates its `AccessoryInformation` service
  (Manufacturer, Model, Serial Number, Firmware Revision) instead of showing
  HomeKit's generic "Default-Manufacturer" / "Default-Model" placeholders.
  Serial Number is derived from the hub's own aircon/zone ID; Firmware
  Revision reflects the plugin's version (the MyPlaceIQ API doesn't expose
  real hub firmware).

## [0.0.5]
### Added
- `.github/FUNDING.yml` to enable GitHub's native Sponsor button (Buy Me a
  Coffee).
- Buy Me a Coffee badge in the README.

## [0.0.4]
### Fixed
- `config.schema.json` used an invalid `"required": true` on individual
  properties, which is not valid JSON Schema. Required fields (`name`,
  `host`, `port`, `clientId`, `clientSecret`) are now declared correctly via
  a `required` array at the schema's object level.

## [0.0.3]
### Added
- `hideDryFanSwitches` config option to remove the Dry Mode / Fan Mode
  switches from HomeKit entirely, for users who don't need them exposed
  (trade-off: Dry/Fan become inaccessible via HomeKit when hidden, since
  there's no thermostat dial slot to fall back to).

## [0.0.2]
### Added
- `primaryZoneControlsSystem` config option (default `true`): a zone the hub
  reports as non-closable (`isClickable: false`, e.g. a "Family" zone) is now
  represented as the full system control (Off/Heat/Cool + Dry/Fan switches)
  instead of a separate generic system accessory.
- `showPriorityZoneSwitch` config option (default `false`) to make the
  per-zone Priority switch opt-in instead of always-on.
### Changed
- Zones no longer get a Priority switch tile by default - just a single
  Off/Auto thermostat, unless `showPriorityZoneSwitch` is enabled.

## [0.0.1]
### Added
- Initial release: WebSocket client for the MyPlaceIQ Q-Hub protocol
  (`ws://host:port/ws`, `client_id`/`password` handshake headers).
- One Thermostat per aircon system (Off/Heat/Cool) with Dry/Fan mode
  switches.
- One Thermostat per zone (Off/Auto) with an optional Priority switch.
- Polling-based state sync (default every 30s), with a follow-up poll ~2s
  after any command to resync state quickly.
