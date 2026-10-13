// -----------------------------------------------------------------------------
// One Gladys device per Miele appliance: its features, and the states read
// from the API answer (GET /devices, or a `devices` frame of the stream).
//
// External ids are forever: `appliance:<serial>` for the device (the serial
// number Miele keys the appliance on, `ident.deviceIdentLabel.fabNumber`), and
// a fixed English key per feature. A feature never moves to another device.
//
// What each family shows and accepts is decided by its type, never by the
// commands the appliance happens to accept at the moment of the discovery
// (they change with its state): the structure of a device stays the same
// from one discovery to the next.
//
// Safety (Guilhem's rule, the OctoPrint lesson): nothing that heats food is
// ever started remotely — ovens, hobs, microwaves, warming drawers get read
// only features, the light aside. COMMAND_KEYS_BY_FAMILY is checked again
// when a command arrives (src/commands.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import {
  LOWEST_TEMPERATURE_RAW,
  RUNNING_STATUSES,
  STATUS,
  TYPE,
  WAITING_STATUSES,
  familyOf,
} from './miele/constants.js';
import { NAMES, STATUS_TEXT, TYPE_NAMES, fill, pickLanguage } from './i18n.js';

/** Shown in a text feature that has no value (Gladys ignores an empty text). */
export const NO_VALUE = '—';

/** The kind of appliance, for its default name. */
const TYPE_KEYS = {
  [TYPE.WASHING_MACHINE]: 'washing_machine',
  [TYPE.WASHING_MACHINE_SEMI_PROFESSIONAL]: 'washing_machine',
  [TYPE.WASHING_MACHINE_PROFESSIONAL]: 'washing_machine',
  [TYPE.TUMBLE_DRYER]: 'tumble_dryer',
  [TYPE.TUMBLE_DRYER_SEMI_PROFESSIONAL]: 'tumble_dryer',
  [TYPE.DRYER_PROFESSIONAL]: 'tumble_dryer',
  [TYPE.WASHER_DRYER]: 'washer_dryer',
  [TYPE.DISHWASHER]: 'dishwasher',
  [TYPE.DISHWASHER_SEMI_PROFESSIONAL]: 'dishwasher',
  [TYPE.DISHWASHER_PROFESSIONAL]: 'dishwasher',
  [TYPE.OVEN]: 'oven',
  [TYPE.OVEN_MICROWAVE]: 'oven_microwave',
  [TYPE.STEAM_OVEN]: 'steam_oven',
  [TYPE.STEAM_OVEN_MK2]: 'steam_oven',
  [TYPE.MICROWAVE]: 'microwave',
  [TYPE.STEAM_OVEN_COMBI]: 'steam_oven_combi',
  [TYPE.STEAM_OVEN_MICRO]: 'steam_oven_micro',
  [TYPE.DIALOG_OVEN]: 'dialog_oven',
  [TYPE.DISH_WARMER]: 'warming_drawer',
  [TYPE.HOB_HIGHLIGHT]: 'hob',
  [TYPE.HOB_INDUCTION]: 'hob',
  [TYPE.HOB_INDUCT_EXTR]: 'hob_extraction',
  [TYPE.COFFEE_SYSTEM]: 'coffee_system',
  [TYPE.HOOD]: 'hood',
  [TYPE.FRIDGE]: 'fridge',
  [TYPE.FREEZER]: 'freezer',
  [TYPE.FRIDGE_FREEZER]: 'fridge_freezer',
  [TYPE.WINE_CABINET]: 'wine_cabinet',
  [TYPE.WINE_CONDITIONING_UNIT]: 'wine_cabinet',
  [TYPE.WINE_STORAGE_CONDITIONING_UNIT]: 'wine_cabinet',
  [TYPE.WINE_CABINET_FREEZER]: 'wine_cabinet_freezer',
  [TYPE.ROBOT_VACUUM_CLEANER]: 'robot_vacuum',
};

/** Families running programs with a duration (time left, elapsed, end). */
const TIMED_FAMILIES = ['laundry', 'dishwasher', 'oven'];
/** Families with a program and a phase worth showing. */
const PROGRAM_FAMILIES = ['laundry', 'dishwasher', 'oven', 'coffee', 'robot'];
/** Families with a door Miele reports (Home Assistant's list). */
const DOOR_FAMILIES = ['laundry', 'dishwasher', 'oven', 'coffee', 'cold'];
/** Families whose on/off may be switched remotely: nothing that heats food. */
const POWER_FAMILIES = ['laundry', 'dishwasher', 'coffee', 'hood'];
/** Families with a light Miele can switch (ovens included: a lamp heats nothing). */
const LIGHT_TYPES = [12, 13, 15, 16, 17, 18, 31, 32, 33, 34, 45, 68, 73];
const ENERGY_FAMILIES = ['laundry', 'dishwasher'];
/** Machines that use water (tumble dryers do not). */
const WATER_TYPES = [1, 3, 5, 7, 8, 9, 24];
const SUPERCOOLING_TYPES = [TYPE.FRIDGE, TYPE.FRIDGE_FREEZER];
const SUPERFREEZING_TYPES = [TYPE.FREEZER, TYPE.FRIDGE_FREEZER, TYPE.WINE_CABINET_FREEZER];

/**
 * The feature keys that accept a command, per family. src/commands.js
 * refuses any other: a cooking appliance only ever gets its light.
 */
export const COMMAND_KEYS_BY_FAMILY = {
  laundry: ['power'],
  dishwasher: ['power'],
  coffee: ['power', 'light'],
  hood: ['power', 'light'],
  oven: ['light'],
  cold: [
    'light',
    'supercooling',
    'superfreezing',
    'target_temperature_1',
    'target_temperature_2',
    'target_temperature_3',
  ],
  hob: [],
  robot: [],
  other: [],
};

/** Setpoint range when the appliance does not tell it (°C). */
function defaultSetpointRange(type, zone) {
  const freezerZone =
    type === TYPE.FREEZER ||
    (type === TYPE.FRIDGE_FREEZER && zone >= 2) ||
    (type === TYPE.WINE_CABINET_FREEZER && zone >= 2);
  if (freezerZone) {
    return { min: -28, max: -14 };
  }
  if (
    [
      TYPE.WINE_CABINET,
      TYPE.WINE_CONDITIONING_UNIT,
      TYPE.WINE_STORAGE_CONDITIONING_UNIT,
      TYPE.WINE_CABINET_FREEZER,
    ].includes(type)
  ) {
    return { min: 5, max: 20 };
  }
  return { min: 1, max: 9 };
}

// --- Reading the API answer --------------------------------------------------

const rawOf = (field) => (field && typeof field === 'object' ? field.value_raw : undefined);
const numberOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `[hours, minutes]` → minutes; null when absent (`[]`, `{}`). */
function minutesOf(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) {
    return value[0] * 60 + value[1];
  }
  return null;
}

/** Temperatures of the zones in °C, null for a zone without value. */
function temperaturesOf(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((entry) => {
    const raw = numberOrNull(entry?.value_raw);
    return raw === null || raw <= LOWEST_TEMPERATURE_RAW ? null : raw / 100;
  });
}

function localizedName(field) {
  const raw = rawOf(field);
  if (raw === undefined || raw === null || raw === 0 || raw === 65535) {
    return null;
  }
  const text = typeof field.value_localized === 'string' ? field.value_localized.trim() : '';
  return text === '' ? `#${raw}` : text;
}

/**
 * One appliance as the rest of the code sees it.
 * @param {string} serial key of the appliance in the API answer
 * @param {object} raw `{ ident, state }`
 */
export function parseAppliance(serial, raw) {
  const ident = raw?.ident ?? {};
  const state = raw?.state ?? {};
  const type = numberOrNull(rawOf(ident.type)) ?? 0;
  const status = numberOrNull(rawOf(state.status));
  const eco = state.ecoFeedback && typeof state.ecoFeedback === 'object' ? state.ecoFeedback : null;
  return {
    serial,
    type,
    family: familyOf(type),
    typeKey: TYPE_KEYS[type] ?? 'appliance',
    deviceName: typeof ident.deviceName === 'string' ? ident.deviceName.trim() : '',
    model: ident.deviceIdentLabel?.techType ?? null,
    status,
    connected: status !== null && status !== STATUS.NOT_CONNECTED,
    program: localizedName(state.ProgramID),
    phase: localizedName(state.programPhase),
    remainingMinutes: minutesOf(state.remainingTime),
    elapsedMinutes: minutesOf(state.elapsedTime),
    startDelayMinutes: minutesOf(state.startTime),
    doorOpen: typeof state.signalDoor === 'boolean' ? state.signalDoor : null,
    failure: state.signalFailure === true,
    light: numberOrNull(state.light),
    temperatures: temperaturesOf(state.temperature),
    targetTemperatures: temperaturesOf(state.targetTemperature),
    coreTemperature: temperaturesOf(state.coreTemperature)[0] ?? null,
    energyKwh: numberOrNull(eco?.currentEnergyConsumption?.value),
    waterLiters: numberOrNull(eco?.currentWaterConsumption?.value),
    battery: numberOrNull(state.batteryLevel),
    remoteStart: state.remoteEnable?.mobileStart === true || state.remoteEnable?.smartGrid === true,
  };
}

/** Every appliance of a GET /devices answer (or a `devices` frame). */
export function parseAppliances(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return [];
  }
  return Object.entries(json)
    .filter(([, raw]) => raw && typeof raw === 'object' && raw.ident)
    .map(([serial, raw]) => parseAppliance(serial, raw));
}

/** The name shown for an appliance: its own, else "Miele <kind>". */
export function applianceName(appliance, language) {
  if (appliance.deviceName) {
    return appliance.deviceName;
  }
  return `Miele ${TYPE_NAMES[pickLanguage(language)][appliance.typeKey]}`;
}

/** Status text of an appliance, in the language of the configuration. */
export function statusText(appliance, language) {
  const table = STATUS_TEXT[pickLanguage(language)];
  if (appliance.status === null) {
    return table[STATUS.RESERVED];
  }
  return table[appliance.status] ?? `${table[STATUS.RESERVED]} (${appliance.status})`;
}

// --- The Gladys device --------------------------------------------------------

/** Number of temperature zones of a fridge, freezer or wine unit. */
export function zoneCount(appliance, actions) {
  const lastValid = appliance.temperatures.reduce(
    (last, value, index) => (value === null ? last : index + 1),
    0,
  );
  const zonesFromActions = Array.isArray(actions?.targetTemperature)
    ? Math.max(0, ...actions.targetTemperature.map((zone) => Number(zone?.zone) || 0))
    : 0;
  const fallback = appliance.type === TYPE.FRIDGE_FREEZER ? 2 : 1;
  return Math.min(3, Math.max(lastValid, zonesFromActions, fallback));
}

function temperatureNameKey(type, zone, zones, prefix) {
  if (zones === 1) {
    return { key: prefix };
  }
  if (type === TYPE.FRIDGE_FREEZER && zone === 1) {
    return { key: `${prefix}_fridge` };
  }
  if (type === TYPE.FRIDGE_FREEZER && zone === 2) {
    return { key: `${prefix}_freezer` };
  }
  return { key: `${prefix}_zone`, n: zone };
}

/** Setpoint range of a zone, from the actions when the appliance gives it. */
export function setpointRange(appliance, actions, zone) {
  const fromActions = Array.isArray(actions?.targetTemperature)
    ? actions.targetTemperature.find((entry) => Number(entry?.zone) === zone)
    : null;
  const min = numberOrNull(fromActions?.min);
  const max = numberOrNull(fromActions?.max);
  if (min !== null && max !== null && min < max) {
    return { min, max };
  }
  return defaultSetpointRange(appliance.type, zone);
}

/**
 * The feature declarations of an appliance (without external ids).
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {object|null} actions the last GET /devices/{id}/actions answer
 */
export function featureSpecs(appliance, actions) {
  const { family, type } = appliance;
  const specs = [];
  const add = (key, nameKey, spec, values = {}) => specs.push({ key, nameKey, values, ...spec });
  const text = {
    category: CAT.TEXT,
    type: TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  };
  const duration = {
    category: CAT.DURATION,
    type: TYPES.DURATION.INTEGER,
    unit: UNITS.MINUTES,
    min: 0,
    max: 6000,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  };
  const temperature = (featureType = TYPES.SENSOR.DECIMAL) => ({
    category: CAT.TEMPERATURE_SENSOR,
    type: featureType,
    unit: UNITS.CELSIUS,
    min: -40,
    max: 400,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  });
  const command = (category, featureType) => ({
    category,
    type: featureType,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  });

  add('status', 'status', text);
  if (PROGRAM_FAMILIES.includes(family)) {
    add('program', 'program', text);
    add('phase', 'phase', text);
  }
  if (TIMED_FAMILIES.includes(family)) {
    add('remaining_time', 'remaining_time', duration);
    add('elapsed_time', 'elapsed_time', duration);
    add('end_time', 'end_time', text);
  }
  if (DOOR_FAMILIES.includes(family)) {
    // Opening sensor: 0 = open, 1 = closed (Gladys' OPENING_SENSOR_STATE).
    add('door', 'door', {
      ...command(CAT.OPENING_SENSOR, TYPES.SENSOR.BINARY),
      read_only: true,
      has_feedback: false,
    });
  }
  if (POWER_FAMILIES.includes(family)) {
    add('power', 'power', command(CAT.SWITCH, TYPES.SWITCH.BINARY));
  }
  if (LIGHT_TYPES.includes(type)) {
    add('light', 'light', command(CAT.LIGHT, TYPES.LIGHT.BINARY));
  }
  if (SUPERCOOLING_TYPES.includes(type)) {
    add('supercooling', 'supercooling', command(CAT.SWITCH, TYPES.SWITCH.BINARY));
  }
  if (SUPERFREEZING_TYPES.includes(type)) {
    add('superfreezing', 'superfreezing', command(CAT.SWITCH, TYPES.SWITCH.BINARY));
  }
  if (family === 'cold') {
    const zones = zoneCount(appliance, actions);
    for (let zone = 1; zone <= zones; zone += 1) {
      const name = temperatureNameKey(type, zone, zones, 'temperature');
      add(`temperature_${zone}`, name.key, temperature(), { n: zone });
      const target = temperatureNameKey(type, zone, zones, 'target_temperature');
      const range = setpointRange(appliance, actions, zone);
      add(
        `target_temperature_${zone}`,
        target.key,
        {
          category: CAT.THERMOSTAT,
          type: TYPES.THERMOSTAT.TARGET_TEMPERATURE,
          unit: UNITS.CELSIUS,
          min: range.min,
          max: range.max,
          step: 1,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        },
        { n: zone },
      );
    }
  }
  if (family === 'oven') {
    add('temperature_1', 'temperature', temperature());
    // The oven's own setpoint, shown read only: never set remotely.
    add('target_temperature_1', 'target_temperature', temperature());
    add('core_temperature', 'core_temperature', temperature(TYPES.TEMPERATURE_SENSOR.PROBE));
  }
  if (ENERGY_FAMILIES.includes(family)) {
    add('energy', 'energy', {
      category: CAT.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.ENERGY,
      unit: UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
    if (WATER_TYPES.includes(type)) {
      add('water', 'water', {
        category: CAT.VOLUME_SENSOR,
        type: TYPES.VOLUME_SENSOR.DECIMAL,
        unit: UNITS.LITER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });
    }
  }
  if (family === 'robot') {
    add('battery', 'battery', {
      category: CAT.BATTERY,
      type: TYPES.BATTERY.INTEGER,
      unit: UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }
  return specs;
}

/** External ids of an appliance. */
export function idsOf(gladys, serial) {
  return gladys.externalIds('appliance', serial);
}

/**
 * The device published to Gladys for an appliance.
 * @param {object} gladys GladysIntegration (externalIds)
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {object|null} actions
 * @param {string} language feature names language
 */
export function buildDevice(gladys, appliance, actions, language) {
  const lang = pickLanguage(language);
  const ids = idsOf(gladys, appliance.serial);
  const params = [{ name: 'miele_type', value: String(appliance.type) }];
  if (appliance.model) {
    params.push({ name: 'model', value: String(appliance.model) });
  }
  return {
    name: applianceName(appliance, lang),
    external_id: ids.device,
    // The container refreshes by itself (stream + its own timer, see
    // src/hub.js): Gladys#3198 makes the core's polling unreliable. onPoll
    // stays as a fallback, and skips when the container read recently.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    params,
    features: featureSpecs(appliance, actions).map(({ key, nameKey, values, ...spec }) => ({
      name: fill(NAMES[lang][nameKey], values),
      external_id: ids.feature(key),
      ...spec,
    })),
  };
}

/** "14:35" in the time zone of Gladys (TZ, set by the supervisor). */
export function clockTime(date, language) {
  return new Intl.DateTimeFormat(pickLanguage(language), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** When the running (or waiting) program should end, or null. */
export function expectedEnd(appliance, now) {
  const remaining = appliance.remainingMinutes ?? 0;
  if (remaining <= 0) {
    return null;
  }
  if ([STATUS.IN_USE, STATUS.RINSE_HOLD].includes(appliance.status)) {
    return new Date(now + remaining * 60_000);
  }
  if (WAITING_STATUSES.includes(appliance.status)) {
    return new Date(now + ((appliance.startDelayMinutes ?? 0) + remaining) * 60_000);
  }
  return null;
}

/**
 * The states of an appliance, keyed by feature key (a number, or `{ text }`).
 * A value the appliance does not give is left out: Gladys keeps the last one.
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {object|null} actions
 * @param {{ language: string, now: number }} options
 */
export function stateValues(appliance, actions, { language, now }) {
  const keys = new Set(featureSpecs(appliance, actions).map((spec) => spec.key));
  const values = { status: { text: statusText(appliance, language) } };
  if (!appliance.connected) {
    // Not connected: every other field is null in the answer, nothing to say.
    return values;
  }
  const set = (key, value) => {
    if (keys.has(key) && value !== null && value !== undefined) {
      values[key] = value;
    }
  };
  const running =
    RUNNING_STATUSES.includes(appliance.status) || WAITING_STATUSES.includes(appliance.status);
  set('program', { text: appliance.program ?? NO_VALUE });
  set('phase', { text: appliance.phase ?? NO_VALUE });
  set('remaining_time', running ? (appliance.remainingMinutes ?? 0) : 0);
  set('elapsed_time', running ? (appliance.elapsedMinutes ?? 0) : 0);
  const end = expectedEnd(appliance, now);
  set('end_time', { text: end ? clockTime(end, language) : NO_VALUE });
  if (appliance.doorOpen !== null) {
    set('door', appliance.doorOpen ? 0 : 1);
  }
  set('power', [STATUS.RESERVED, STATUS.OFF].includes(appliance.status) ? 0 : 1);
  if (appliance.light === 1 || appliance.light === 2) {
    set('light', appliance.light === 1 ? 1 : 0);
  }
  set(
    'supercooling',
    [STATUS.SUPERCOOLING, STATUS.SUPERCOOLING_SUPERFREEZING].includes(appliance.status) ? 1 : 0,
  );
  set(
    'superfreezing',
    [STATUS.SUPERFREEZING, STATUS.SUPERCOOLING_SUPERFREEZING].includes(appliance.status) ? 1 : 0,
  );
  appliance.temperatures.forEach((value, index) => set(`temperature_${index + 1}`, value));
  appliance.targetTemperatures.forEach((value, index) =>
    set(`target_temperature_${index + 1}`, value),
  );
  set('core_temperature', appliance.coreTemperature);
  set('energy', appliance.energyKwh);
  set('water', appliance.waterLiters);
  set('battery', appliance.battery);
  return values;
}

/** The states of an appliance in the `publishStates` format. */
export function buildStates(gladys, appliance, actions, options) {
  const ids = idsOf(gladys, appliance.serial);
  return Object.entries(stateValues(appliance, actions, options)).map(([key, value]) =>
    typeof value === 'number'
      ? { device_feature_external_id: ids.feature(key), state: value }
      : { device_feature_external_id: ids.feature(key), text: value.text },
  );
}
