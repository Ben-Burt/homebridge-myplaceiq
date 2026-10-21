# Changelog

All notable changes to this project are documented here.

## [0.0.10]
### Added
- Change log. Every change is written to a daily file
  (`<Homebridge storage>/myplaceiq-logs/changes-YYYY-MM-DD.log`, e.g.
  `/var/lib/homebridge/myplaceiq-logs/`) and files older than 30 days are
  deleted automatically (`changeLogRetentionDays`, 1-365). It records
  commands sent because of HomeKit actions (Home app, Siri, automations) and
  changes seen on the hub between polls, labelled as confirmed (they follow a
  HomeKit command) or changed outside HomeKit (MyPlaceIQ app, wall panel, or
  the system itself). HomeKit does not tell a plugin which person made a
  change, so the person is not recorded.
- `logChangesToConsole` option to also print each change in the Homebridge log.

## [0.0.9]
### Changed
- Zone thermostats are back to **Off / Auto** (open / closed). 0.0.8 had
  swapped Auto for whichever of Heat/Cool the system was running, which made
  zones look like they could pick heat or cool on their own. They can't:
  heat/cool/dry/fan is set on the primary zone or the aircon unit only. The
  current-state ring on each zone still shows Heat or Cool to reflect what
  the system is actually doing in that zone. The command sent to the hub is
  unchanged (open/close the zone).

## [0.0.8]
### Fixed
- Every request to the hub (startup discovery, the regular poll timer, and
  post-command refreshes) now shares a single mutex, so at most one request
  is ever in flight at a time. Previously, each command scheduled its own
  independent follow-up poll with no coordination between them - if several
  commands landed close together (e.g. the Home app re-syncing multiple
  accessories at once), this could open several simultaneous connections to
  the hub. The hub is a small embedded device that doesn't handle concurrent
  WebSocket requests gracefully, which showed up as intermittent
  `Timed out waiting for response` and `Incomplete response... (missing
  aircons/zones)` errors, and accessories going to "No Response" in the
  Home app.
- Zone thermostats no longer use "Auto" to represent an open/on zone.
  HomeKit's Home app renders a thermostat whose valid states skip over
  Heat/Cool (Off + Auto only) oddly - it splits into a separate temperature
  tile plus a switch-style tile, and that switch tile is prone to showing
  "No Response" even though nothing is actually wrong. Zones now represent
  "on" as whichever of Heat/Cool the parent system is actually running
  (updated dynamically if the system's mode changes), which renders as a
  normal single thermostat control. The command sent to the hub is
  unchanged - still a simple open/close - only the HomeKit-facing state
  representation changed.
### Changed
- README Installation section restructured: Config UI X plugin search is
  now the primary/recommended method (the plugin is published on npm and
  discoverable there), with the npm CLI and from-source installs kept as
  documented backup options. Previously the docs still read as if the
  package wasn't published yet.

## [0.0.7]
### Changed
- Fan Mode is now a proper `Fanv2` HomeKit service instead of a generic
  `Switch`, giving it the correct fan icon/tile in the Home app rather than
  a plain toggle. Behavior is unchanged (on = fan-only mode, off = system
  off). A `Switch`-based Fan Mode service left over from an older version
  of the plugin is automatically cleaned up on upgrade.

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
