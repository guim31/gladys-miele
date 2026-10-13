// -----------------------------------------------------------------------------
// What the Miele 3rd Party API calls things, in one place.
//
// The codes come from the API documentation (developer.miele.com) as mirrored
// by pymiele (MIT) and the Home Assistant `miele` integration (Apache-2.0),
// whose tests carry real answers of the API (test/fixtures/miele/).
// -----------------------------------------------------------------------------

export const API_BASE_URL = 'https://api.mcs3.miele.com/v1';

// The authorization server Home Assistant uses today (pymiele OAUTH2_AUTHORIZE /
// OAUTH2_TOKEN). pymiele also lists a newer Keycloak realm
// (auth.domestic.miele-iot.com), not used by Home Assistant yet: stay on the
// endpoints proven by the largest user base.
export const OAUTH_AUTHORIZE_URL = 'https://api.mcs3.miele.com/thirdparty/login';
export const OAUTH_TOKEN_URL = 'https://api.mcs3.miele.com/thirdparty/token';

// Where a user gets a client id and secret (free, by e-mail).
export const REGISTER_URL = 'https://www.miele.com/f/com/en/register_api.aspx';

// The API localizes its values (program and phase names) in German or English
// only; a missing or unknown language gets English.
export const API_LANGUAGES = ['de', 'en'];

/** Appliance types (`ident.type.value_raw`). */
export const TYPE = {
  WASHING_MACHINE: 1,
  TUMBLE_DRYER: 2,
  WASHING_MACHINE_SEMI_PROFESSIONAL: 3,
  TUMBLE_DRYER_SEMI_PROFESSIONAL: 4,
  WASHING_MACHINE_PROFESSIONAL: 5,
  DRYER_PROFESSIONAL: 6,
  DISHWASHER: 7,
  DISHWASHER_SEMI_PROFESSIONAL: 8,
  DISHWASHER_PROFESSIONAL: 9,
  OVEN: 12,
  OVEN_MICROWAVE: 13,
  HOB_HIGHLIGHT: 14,
  STEAM_OVEN: 15,
  MICROWAVE: 16,
  COFFEE_SYSTEM: 17,
  HOOD: 18,
  FRIDGE: 19,
  FREEZER: 20,
  FRIDGE_FREEZER: 21,
  ROBOT_VACUUM_CLEANER: 23,
  WASHER_DRYER: 24,
  DISH_WARMER: 25,
  HOB_INDUCTION: 27,
  STEAM_OVEN_COMBI: 31,
  WINE_CABINET: 32,
  WINE_CONDITIONING_UNIT: 33,
  WINE_STORAGE_CONDITIONING_UNIT: 34,
  STEAM_OVEN_MICRO: 45,
  DIALOG_OVEN: 67,
  WINE_CABINET_FREEZER: 68,
  STEAM_OVEN_MK2: 73,
  HOB_INDUCT_EXTR: 74,
};

/**
 * Families of appliances: what they show and what they accept. Every type
 * the API knows belongs to exactly one family (a test checks it); an unknown
 * future type falls back to `other` (status only, no command).
 */
export const FAMILY_TYPES = {
  laundry: [1, 2, 3, 4, 5, 6, 24],
  dishwasher: [7, 8, 9],
  // Anything that heats food: read only, the light aside (see SAFE_COMMANDS).
  oven: [12, 13, 15, 16, 25, 31, 45, 67, 73],
  hob: [14, 27, 74],
  coffee: [17],
  hood: [18],
  cold: [19, 20, 21, 32, 33, 34, 68],
  robot: [23],
};

/** The family of a type, `other` for a type this integration does not know. */
export function familyOf(type) {
  for (const [family, types] of Object.entries(FAMILY_TYPES)) {
    if (types.includes(type)) {
      return family;
    }
  }
  return 'other';
}

/** Appliance states (`state.status.value_raw`). */
export const STATUS = {
  RESERVED: 0,
  OFF: 1,
  ON: 2,
  PROGRAMMED: 3,
  WAITING_TO_START: 4,
  IN_USE: 5,
  PAUSE: 6,
  PROGRAM_ENDED: 7,
  FAILURE: 8,
  PROGRAM_INTERRUPTED: 9,
  IDLE: 10,
  RINSE_HOLD: 11,
  SERVICE: 12,
  SUPERFREEZING: 13,
  SUPERCOOLING: 14,
  SUPERHEATING: 15,
  SUPERCOOLING_SUPERFREEZING: 146,
  AUTOCLEANING: 147,
  NOT_CONNECTED: 255,
};

/** A program is under way (time running or about to). */
export const RUNNING_STATUSES = [STATUS.IN_USE, STATUS.PAUSE, STATUS.RINSE_HOLD];

/** A program is set and waits for its start (delayed start, SmartStart). */
export const WAITING_STATUSES = [STATUS.PROGRAMMED, STATUS.WAITING_TO_START];

/** `processAction` codes of PUT /devices/{id}/actions. */
export const PROCESS_ACTION = {
  START: 1,
  STOP: 2,
  PAUSE: 3,
  START_SUPERFREEZING: 4,
  STOP_SUPERFREEZING: 5,
  START_SUPERCOOLING: 6,
  STOP_SUPERCOOLING: 7,
};

/** `light` values, in the state and in the actions. */
export const LIGHT = { ON: 1, OFF: 2 };

/**
 * The API says "no value" for a temperature with the int16 minimum (-32768 in
 * hundredths of a degree), sometimes -32766, and some appliances send it
 * already scaled (-3276800). Anything below absolute zero is no value.
 */
export const LOWEST_TEMPERATURE_RAW = -27315;
