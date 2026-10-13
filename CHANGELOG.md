# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Miele@home appliances in Gladys through the official Miele 3rd Party API:
  one device per appliance (washing machines, tumble dryers, washer-dryers,
  dishwashers, ovens, steam ovens, microwaves, warming drawers, hobs, cooker
  hoods, fridges, freezers, wine units, coffee machines, robot vacuums), with
  its state, program, phase, time left, elapsed time, expected end, door,
  temperatures, energy and water of the cycle, battery.
- Sign-in with the Miele account from the Configuration screen (Connect
  button), with your own free Miele developer credentials. Gladys Plus is not
  needed. The tokens stay in the integration's `/data` volume.
- Real time through Miele's event stream, with a full read every 30 minutes
  (every 2 minutes while the stream is down). No reliance on Gladys polling.
- Safe commands: on/off of washing machines, tumble dryers, dishwashers, hoods
  and coffee machines, lights, fridge and freezer setpoints,
  SuperCool/SuperFreeze. Ovens, hobs and microwaves are never turned on.
- Scene triggers "Miele program finished" (with program, energy and water
  used) and "Miele appliance fault"; scene action "Control a Miele appliance"
  (start, pause, stop).
- Dashboard widget "Miele appliances": what is running and its time left.
- "Test the connection" button.
- English, French, German and Spanish everywhere, including the
  documentation.

[Unreleased]: https://github.com/guim31/gladys-miele/commits/main
