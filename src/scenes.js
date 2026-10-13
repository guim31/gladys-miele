// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`) and the keys of the scene triggers
// the hub fires (manifest `scene_triggers`). Keys are forever once published.
//
// `appliance_command`: start, pause or stop the program of an appliance.
// "Start" needs Remote Start / MobileStart enabled on the appliance and a
// program chosen on it: that is how a delayed start works with Gladys — set
// the program on the machine, then let a scheduled scene start it at the
// right time (off-peak hours). Cooking appliances are never started (see
// src/commands.js).
// -----------------------------------------------------------------------------

import { TRIGGERS } from './hub.js';

export const SCENE_TRIGGER_KEYS = Object.values(TRIGGERS);

/** Handlers of the scene actions, by key. */
export function createSceneActions({ hub }) {
  return {
    async appliance_command(fields) {
      await hub.runCommand(fields.device, fields.command);
      return { sent: true };
    },
  };
}
