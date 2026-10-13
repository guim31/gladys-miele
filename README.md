# Miele for Gladys Assistant

Follow — and, where it is safe, control — your **Miele@home** appliances in
[Gladys Assistant](https://gladysassistant.com), through the official **Miele 3rd
Party API**: washing machines, tumble dryers, dishwashers, ovens, cooker hoods,
hobs, fridges, freezers, wine units, coffee machines and robot vacuums.

> **Developed without the hardware: feedback welcome.** Neither a Miele appliance
> nor a Miele account was available while writing it: the code is tested against
> the real API answers published by the Home Assistant project. Please report what
> works and what does not.
>
> Community project, **not affiliated with Miele**. Miele and Miele@home are
> trademarks of Miele & Cie. KG.

## Features

- **One Gladys device per appliance**: state (running, paused, finished, fault…),
  program and phase, time left, elapsed time, expected end, door, temperatures
  (fridge, freezer, oven, food probe), energy and water of the cycle, battery.
- **Real time** through Miele's event stream (Server-Sent Events), with a full
  read every 30 minutes as a safety net — every 2 minutes while the stream is down.
- **Safe commands only**: on/off of washing machines, dryers, dishwashers, hoods
  and coffee machines, lights, fridge/freezer setpoints, SuperCool/SuperFreeze, and
  start/pause/stop of a program prepared on the machine (Remote Start).
  **Ovens, hobs, microwaves and warming drawers are never turned on**, whatever the
  API allows.
- **Scene triggers**: "Miele program finished" (program, energy, water) and "Miele
  appliance fault". **Scene action**: "Control a Miele appliance".
- **Dashboard widget** "Miele appliances": what is running, time left, expected end.
- English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later. Gladys Plus is **not** needed.
- Miele@home appliances paired in the Miele app.
- Free Miele developer credentials (client ID and secret):
  [request them from Miele](https://www.miele.com/f/com/en/register_api.aspx).
- Internet access: Miele has no local API.

## Installation

1. In Gladys: **Integrations → Install from GitHub**, address
   `https://github.com/guim31/gladys-miele` (or install it from the store once
   published).
2. On the **Configuration** screen, paste the client ID and secret, save, then
   click **Connect** and sign in with your Miele account.
3. In the **Discover** tab, click **Add to Gladys** on the appliances to follow.

The full guide, in four languages, is in [`docs/`](docs/en.md) (also shown by
Gladys from the integration page).

## How it works

- **Authentication**: the manifest declares an `oauth2` field; Gladys relays the
  browser flow (its HTTPS redirect page, no Gladys Plus) and the integration
  exchanges the code. Tokens and their refresh live in the container's `/data`
  volume only (`miele-auth.json`, mode 600), never in the configuration nor in the
  logs.
- **Refresh**: one long-lived event stream (`/devices/all/events`) plus the
  container's own timer; the core's polling is only a fallback (Gladys#3198 makes
  it unreliable). Only changed states are sent to Gladys, with a 6-hour heartbeat.
- **Quotas**: Miele publishes no figure; the integration stays well below Home
  Assistant's pace (one stream, one full read every 30 minutes).
- **Logs**: quiet at info level (start, sign-in, appliances found, stream lost and
  back, one line per user command). `LOG_LEVEL=debug` shows the rest.

## Limitations

- No remote program choice: "start" runs the program prepared on the appliance,
  with Remote Start/MobileStart enabled. Delayed start = a scheduled Gladys scene.
- Program and phase names come from Miele in English or German only.
- No control of ovens, hobs, microwaves (by design), of the robot vacuum or of the
  hood fan speed; no TwinDos/PowerDisk levels, no per-zone hob data.
- Cloud only: no update while Miele or the Internet connection is down.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run the whole integration on the SDK's fake Gladys and a fake Miele
serving real API answers (`test/fixtures/miele/`); they never touch the network.
`scripts/probe.mjs` checks the real API, read only, from a machine with network
access and your own credentials (see the comments at its top).

Project rules: [`CLAUDE.md`](CLAUDE.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).
Security: [`SECURITY.md`](SECURITY.md).

## Credits

- [Home Assistant `miele` integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/miele)
  (Apache-2.0): appliance types, codes and safety of the commands were studied
  there, and the API answers of its tests are reused as fixtures in
  `test/fixtures/miele/`.
- [`astrandb/pymiele`](https://github.com/astrandb/pymiele) by Åke Strandberg (MIT):
  endpoints, OAuth URLs and the event stream format.
- [`prohand/gladys-homeconnect`](https://github.com/prohand/gladys-homeconnect): the
  same OAuth relay problem, solved for Home Connect.
- [Gladys Assistant](https://github.com/GladysAssistant/Gladys) and its
  [integration SDK](https://github.com/GladysAssistant/integration-sdk-js).

## Disclaimer

This integration is not affiliated with, endorsed by or supported by Miele & Cie.
KG. Use it at your own risk; your use of the Miele API is subject to Miele's terms.

## License

[Apache-2.0](LICENSE).
