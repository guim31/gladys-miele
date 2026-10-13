// -----------------------------------------------------------------------------
// What may be sent to an appliance, and the body of PUT /devices/{id}/actions.
//
// Two gates before anything leaves the container:
//   1. safety: a command must be allowed for the family of the appliance
//      (COMMAND_KEYS_BY_FAMILY, PROGRAM_COMMANDS): nothing that heats food is
//      ever started remotely, whatever the API would accept;
//   2. availability: when the last `actions` answer says the appliance does
//      not accept the command right now (door open, Remote Start disabled,
//      already off…), the user gets a clear message instead of an HTTP 400.
// Pure functions: the tests pin both gates without any network.
// -----------------------------------------------------------------------------

import { COMMAND_KEYS_BY_FAMILY, setpointRange } from './appliances.js';
import { COMMAND_TEXT, fillAll, pickLanguage } from './i18n.js';
import { LIGHT, PROCESS_ACTION } from './miele/constants.js';

/** A refused command, with its message in the four languages. */
export class CommandError extends Error {
  /**
   * @param {Record<string, string>} texts multi-language message
   * @param {string} language the language of `message` (logs, acks)
   */
  constructor(texts, language) {
    super(texts[pickLanguage(language)]);
    this.name = 'CommandError';
    this.texts = texts;
  }
}

/** Commands of the `appliance_command` scene action, and who may get them. */
export const PROGRAM_COMMANDS = {
  start: { code: PROCESS_ACTION.START, families: ['laundry', 'dishwasher'] },
  pause: { code: PROCESS_ACTION.PAUSE, families: ['laundry', 'dishwasher'] },
  // Stopping is always safe, a cooking appliance included.
  stop: {
    code: PROCESS_ACTION.STOP,
    families: ['laundry', 'dishwasher', 'oven', 'coffee', 'hood'],
  },
};

/** Cooking appliances get the "never started remotely" message. */
function refused(appliance, language) {
  const cooking = appliance.family === 'oven' || appliance.family === 'hob';
  return new CommandError(cooking ? COMMAND_TEXT.unsafe : COMMAND_TEXT.unsupported, language);
}

const processActionAllowed = (actions, code) =>
  !Array.isArray(actions?.processAction) || actions.processAction.includes(code);

/**
 * The body for a command on a device feature (onSetValue).
 * @param {object} appliance parsed appliance
 * @param {object|null} actions last actions answer, null when unknown
 * @param {string} key feature key (`power`, `light`, `target_temperature_2`…)
 * @param {number} value
 * @param {string} language
 */
export function featureCommand(appliance, actions, key, value, language) {
  const allowed = COMMAND_KEYS_BY_FAMILY[appliance.family] ?? [];
  if (!allowed.includes(key)) {
    throw refused(appliance, language);
  }
  const notAvailable = () => new CommandError(COMMAND_TEXT.notAvailable, language);
  const on = Number(value) === 1;

  if (key === 'power') {
    const field = on ? 'powerOn' : 'powerOff';
    if (actions && actions[field] === false) {
      throw notAvailable();
    }
    return { [field]: true };
  }
  if (key === 'light') {
    const code = on ? LIGHT.ON : LIGHT.OFF;
    if (Array.isArray(actions?.light) && !actions.light.includes(code)) {
      throw notAvailable();
    }
    return { light: code };
  }
  if (key === 'supercooling' || key === 'superfreezing') {
    const codes =
      key === 'supercooling'
        ? [PROCESS_ACTION.START_SUPERCOOLING, PROCESS_ACTION.STOP_SUPERCOOLING]
        : [PROCESS_ACTION.START_SUPERFREEZING, PROCESS_ACTION.STOP_SUPERFREEZING];
    const code = on ? codes[0] : codes[1];
    if (!processActionAllowed(actions, code)) {
      throw notAvailable();
    }
    return { processAction: code };
  }
  const zoneMatch = /^target_temperature_(\d)$/.exec(key);
  if (zoneMatch) {
    const zone = Number(zoneMatch[1]);
    const range = setpointRange(appliance, actions, zone);
    const target = Math.round(Number(value));
    if (!Number.isFinite(target) || target < range.min || target > range.max) {
      throw new CommandError(fillAll(COMMAND_TEXT.outOfRange, range), language);
    }
    return { targetTemperature: [{ zone, value: target }] };
  }
  throw refused(appliance, language);
}

/**
 * The body for a program command (scene action).
 * @param {object} appliance parsed appliance
 * @param {object|null} actions
 * @param {'start'|'pause'|'stop'} command
 * @param {string} language
 */
export function programCommand(appliance, actions, command, language) {
  const definition = PROGRAM_COMMANDS[command];
  if (!definition || !definition.families.includes(appliance.family)) {
    throw refused(appliance, language);
  }
  if (!processActionAllowed(actions, definition.code)) {
    throw new CommandError(COMMAND_TEXT.notAvailable, language);
  }
  return { processAction: definition.code };
}
