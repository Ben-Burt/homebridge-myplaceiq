# homebridge-myplaceiq (unofficial)

<p align="center">
  <img src="branding/logo.png" alt="MyPlaceIQ" width="130">
</p>

An unofficial Homebridge plugin for the **Advantage Air MyPlaceIQ** system (the
"Q-Hub" generation — WebSocket API on port 8086, not the older MyPlace/MyAir
tablet system on port 2025).

> **Not affiliated with or endorsed by Advantage Air.** This is a
> community-built integration based on reverse-engineered protocol details.
> Use at your own risk — see [Disclaimer](#disclaimer).

## Acknowledgements

This plugin exists because [**@anwickes**](https://github.com/anwickes)
reverse-engineered the MyPlaceIQ Q-Hub's WebSocket protocol and published it
as [anwickes/myplaceiq](https://github.com/anwickes/myplaceiq), a Home
Assistant integration. The authentication handshake, command set, and data
model in `lib/client.js` here are a direct port of that work to
Homebridge/HomeKit. If you find this plugin useful, that project (and its
author) did the actual hard part — please consider starring it too.

## What you get in HomeKit

- One **Thermostat** per zone — Off / Auto (zones only open or close a duct;
  they inherit heat/cool/dry mode from the parent system), plus current and
  target temperature. Just the one tile per zone — no extra switch — unless
  you turn on `showPriorityZoneSwitch` (see below).
- **Non-closable zones become the system control.** If a zone can't be
  independently turned off (the hub reports `isClickable: false` — typically
  a zone like "Family" that always stays open), that zone's accessory is
  upgraded to a full **Thermostat** with Off/Heat/Cool + target temperature,
  plus a **"Dry Mode"** and **"Fan Mode"** switch (HomeKit's thermostat has no
  native dry/fan-only mode, so — like the equivalent `homebridge-myplace`
  plugin for the older MyAir/MyPlace API — those are exposed as separate
  switches). In this case there's **no separate generic system accessory** —
  the non-closable zone *is* the system control, which matches how it
  actually behaves on the hub. Turn this off with
  `"primaryZoneControlsSystem": false` if you'd rather have both a plain
  Off/Auto zone tile and a standalone system accessory.
- Set `"hideDryFanSwitches": true` to remove the Dry Mode / Fan Mode switches
  from HomeKit entirely, if you'd rather have just the plain Off/Heat/Cool
  thermostat and don't need Dry/Fan reachable from HomeKit at all. **Trade-off:**
  since there's no dial slot for Dry/Fan, hiding these switches means those two
  modes become fully inaccessible via HomeKit - no Siri, no automations, no
  tile anywhere - and if the system is actually running in Dry or Fan mode,
  the thermostat dial will simply show "Off" (there's nothing else for it to
  show). You'd fall back to the official MyPlaceIQ app for those two modes.
- If none of a system's zones are non-closable (or the option above is
  disabled), you instead get one plain **Thermostat** accessory for the whole
  aircon system (Off/Heat/Cool + target temperature) plus its own Dry/Fan
  switches, and every zone is a normal Off/Auto Thermostat.
- An optional **"Priority"** switch per zone (only for zones where the hub
  reports `isPriorityZoneAllowed`), off by default — enable with
  `"showPriorityZoneSwitch": true` if you want it back as a second tile.

The plugin polls the hub on an interval (default 30s) rather than holding a
live connection open, because the hub's own API is designed around
short-lived, one-shot WebSocket requests (see [How it talks to the
hub](#how-it-talks-to-the-hub) below).

## Installation

1. Copy this folder onto your Homebridge machine, e.g. into
   `~/.homebridge/homebridge-myplaceiq/` (or, once published, `npm install -g homebridge-myplaceiq`).
2. From inside that folder, install dependencies:
   ```bash
   npm install
   ```
3. If you're not installing a published package, tell Homebridge where to
   find it by installing it globally:
   ```bash
   npm install -g /path/to/homebridge-myplaceiq
   ```
   Make sure this lands in whatever `node_modules` path your specific
   Homebridge install actually resolves plugins from — this varies between a
   manually-run Homebridge, `hb-service`-managed installs, and Docker images.
   If in doubt, run `homebridge -D` and check the plugin search paths it logs
   on startup.

## Configuration

Add a platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MyPlaceIQ",
      "name": "MyPlaceIQ",
      "host": "192.168.1.171",
      "port": 8086,
      "clientId": "YOUR_CLIENT_ID",
      "clientSecret": "YOUR_CLIENT_SECRET",
      "pollInterval": 30
    }
  ]
}
```

If you're running the Homebridge Config UI, `config.schema.json` gives you a
proper settings form instead — no manual JSON editing needed.

| Field          | Required | Default | Notes                                             |
|----------------|----------|---------|----------------------------------------------------|
| `host`         | yes      | —       | Static IP of your Q-Hub (mDNS/hostnames won't work) |
| `port`         | yes      | `8086`  | The hub's WebSocket port                            |
| `clientId`     | yes      | —       | See [Getting your Client ID and Client Secret](#getting-your-client-id-and-client-secret) |
| `clientSecret` | yes      | —       | Same as above                                       |
| `pollInterval` | no       | `30`    | Seconds between polls (10–300)                      |
| `primaryZoneControlsSystem` | no | `true` | Fold whole-system control into a non-closable zone instead of a separate system accessory |
| `showPriorityZoneSwitch` | no | `false` | Show an extra Priority switch tile on eligible zones |
| `hideDryFanSwitches` | no | `false` | Remove the Dry/Fan switches from HomeKit entirely (loses HomeKit access to those modes - see note above) |

### Getting your Client ID and Client Secret

Advantage Air doesn't publish these; the same manual extraction method used
for the Home Assistant integration works here too:

1. Install [Wireshark](https://www.wireshark.org/download.html) and an
   Android emulator (e.g. BlueStacks) on the same machine.
2. Start a Wireshark capture filtered to your hub's IP: `ip.addr==x.x.x.x`.
3. Install the MyPlaceIQ app in the emulator and pair it with your hub as normal.
4. Once paired, stop the capture and look for an HTTP `GET /ws` packet sent
   from the emulator to the hub. Its headers contain `client_id` and
   `password` (this `password` is your client secret) issued to your app
   instance.
5. Use those two values in the config above.

Treat this pair like a credential — anyone on your LAN with it can control
your aircon via the hub's API.

Make sure **Hub Remote Access** is turned on under Settings → Hub Settings on
the hub itself, or you'll intermittently lose sync with the app.

## How it talks to the hub

Ported directly from the reference integration's `myplaceiq.py`:

- Connects to `ws://<host>:<port>/ws`.
- Authenticates via `client_id` / `password` **HTTP headers on the WebSocket
  handshake** — there's no in-band login message.
- Every request opens its own short-lived connection: connect → send one
  `{ uuid, body }` envelope → optionally wait for one JSON reply → disconnect.
  There is no persistent/streaming connection, so state changes made from the
  physical hub or the official app only show up in HomeKit on the next poll
  (or the follow-up poll this plugin runs ~2s after any command it sends).
- To read full state: `{ commands: [{ "__type": "GetFullDataEvent" }] }`,
  which returns a JSON body with `aircons` and `zones` maps.
- To act: `{ commands: [{ "__type": "SetAirconOnOff", "airconId": "...", "isOn": true }] }`
  and similar `__type`s (`SetAirconMode`, `SetAirconHeatTemperature`,
  `SetAirconCoolTemperature`, `SetZoneOpenClose`, `SetZoneHeatTemperature`,
  `SetZoneCoolTemperature`, `SetPriorityZone`).

## Project layout

```
homebridge-myplaceiq/
├── index.js                 # registers the platform with Homebridge
├── config.schema.json       # Homebridge UI settings form
├── package.json
└── lib/
    ├── client.js             # WebSocket protocol client (auth, retries, GetFullDataEvent)
    ├── platform.js           # discovery, polling, accessory lifecycle
    ├── systemAccessory.js     # Thermostat + Dry/Fan switches for the aircon system
    └── zoneAccessory.js       # Thermostat + Priority switch for a single zone
```

## Known limitations / things to sanity-check on your hub

- The `aircons` dict in the sample data seen during development had a single
  system keyed by an id like `"019469"`. If your hub reports **multiple**
  aircon systems, each becomes its own Thermostat + Dry/Fan switches (or
  primary-zone-as-system, if applicable) — this hasn't been tested against a
  genuinely multi-system install.
- Zone fan speed isn't in the reverse-engineered command set at all (the
  reference integration doesn't expose it either), so it isn't in this
  plugin. If your hub does support it, the actual field/command names would
  need to be captured from the app's traffic the same way the credentials were.
- If you see `"Poll failed"` warnings in the Homebridge log, double check
  `host`, `port`, and that the client ID/secret pair hasn't been rotated by
  the app (re-pairing the official app can potentially issue new credentials).

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an independent, community-built plugin. It is not affiliated with,
endorsed by, or supported by Advantage Air. It communicates with your hub
over your local network using credentials you extract yourself; you are
responsible for how you use it and for keeping those credentials secure.
Provided "as is", with no warranty — see [LICENSE](LICENSE).

## License

[MIT](LICENSE)
