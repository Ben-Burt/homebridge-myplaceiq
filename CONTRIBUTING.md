# Contributing

Issues and pull requests are welcome.

## Development setup

```bash
git clone https://github.com/<YOUR_GITHUB_USERNAME>/homebridge-myplaceiq.git
cd homebridge-myplaceiq
npm install
```

There's no automated test suite bundled in the published package yet, but
before opening a PR, please sanity-check:

- `node --check` on every changed `.js` file
- That `config.schema.json` is still valid JSON (`node -e "JSON.parse(require('fs').readFileSync('config.schema.json'))"`)
- A manual run against a real hub if your change touches `lib/client.js` or
  the command payloads in `lib/systemAccessory.js` / `lib/zoneAccessory.js`,
  since those are the parts most likely to silently drift from what the hub
  actually expects.

## Reporting a hub quirk

If your hub behaves differently than described in the README (different
field names, extra zone states, multiple aircon systems, etc.), please open
an issue with:
- The relevant excerpt of a `GetFullDataEvent` response (redact `name`
  fields if you'd rather not share them, but keep the structure)
- What you expected to happen vs. what happened

This plugin's behavior is based on reverse-engineered protocol details from
[anwickes/myplaceiq](https://github.com/anwickes/myplaceiq) plus real-world
testing against a single hub, so edge cases from other hardware
revisions/firmware are genuinely possible and useful to know about.
