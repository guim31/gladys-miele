// -----------------------------------------------------------------------------
// Dashboard widget "Miele appliances": what is running, and for how long.
//
// One row per appliance of interest (running, paused, waiting for a delayed
// start, just finished, in fault; never a fridge, always "in use"), the
// busiest first: its program and phase,
// when it should end, and a badge with the time left or the state. Nothing
// running: one line says so. Read only: commands stay with the device
// features and the scene action.
//
// Pre-localized from the language Gladys sends with each request (the core
// caches per language). Refreshed every minute (the time left moves), and
// nudged by the hub when an appliance starts, stops or changes program.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { NO_VALUE, clockTime, expectedEnd, idsOf, statusText } from './appliances.js';
import { WIDGET_TEXT, fill, pickLanguage } from './i18n.js';
import { RUNNING_STATUSES, STATUS, WAITING_STATUSES } from './miele/constants.js';
import { WIDGET_KEY } from './hub.js';

/** Rows the widget can show (card-list, list display). */
export const MAX_ROWS = 8;

/** "42 min" or "1 h 05". */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) {
    return `${total} min`;
  }
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`;
}

/** Order of the rows: running first, then waiting, paused, fault, finished. */
const RANK = {
  [STATUS.IN_USE]: 0,
  [STATUS.RINSE_HOLD]: 1,
  [STATUS.WAITING_TO_START]: 2,
  [STATUS.PROGRAMMED]: 2,
  [STATUS.PAUSE]: 3,
  [STATUS.FAILURE]: 4,
  [STATUS.PROGRAM_ENDED]: 5,
};

/** Time left for the order of the rows: an appliance without one comes last. */
const timeLeft = (appliance) =>
  (appliance.remainingMinutes ?? 0) > 0 ? appliance.remainingMinutes : Number.POSITIVE_INFINITY;

function badgeOf(appliance, lang) {
  const text = WIDGET_TEXT[lang];
  if (appliance.status === STATUS.IN_USE && (appliance.remainingMinutes ?? 0) > 0) {
    return { text: formatMinutes(appliance.remainingMinutes), color: WIDGET_COLORS.PRIMARY };
  }
  if (appliance.status === STATUS.FAILURE || appliance.failure) {
    return { text: text.fault, color: WIDGET_COLORS.DANGER };
  }
  if (appliance.status === STATUS.PROGRAM_ENDED) {
    return { text: text.finished, color: WIDGET_COLORS.SUCCESS };
  }
  if (appliance.status === STATUS.PAUSE) {
    return { text: text.paused, color: WIDGET_COLORS.WARNING };
  }
  return { text: statusText(appliance, lang).slice(0, 16), color: WIDGET_COLORS.INFO };
}

function subtitleOf(appliance, lang, now) {
  const text = WIDGET_TEXT[lang];
  const parts = [appliance.program, appliance.phase].filter((part) => part && part !== NO_VALUE);
  if (WAITING_STATUSES.includes(appliance.status) && (appliance.startDelayMinutes ?? 0) > 0) {
    parts.push(fill(text.waiting, { d: formatMinutes(appliance.startDelayMinutes) }));
  }
  const end = expectedEnd(appliance, now);
  if (end) {
    parts.push(fill(text.endsAt, { t: clockTime(end, lang) }));
  }
  return parts.length > 0 ? parts.join(' · ') : statusText(appliance, lang);
}

/**
 * The widget content.
 * @param {object} options
 * @param {object} options.gladys
 * @param {ReturnType<import('./hub.js').createHub>} options.hub
 * @param {string} options.language sent by Gladys with the request
 * @param {number} [options.now]
 */
export function buildWidgetContent({ gladys, hub, language, now = Date.now() }) {
  const lang = pickLanguage(language);
  const text = WIDGET_TEXT[lang];
  const caption = (value) => ({
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'caption', text: value }],
  });
  if (!hub.linked) {
    return caption(text.notLinked);
  }
  const created = new Set((gladys.devices ?? []).map((device) => device.external_id));
  const appliances = [...hub.appliances.values()].filter((appliance) =>
    created.has(idsOf(gladys, appliance.serial).device),
  );
  if (appliances.length === 0) {
    return caption(text.noDevice);
  }
  const active = appliances
    // Fridges and freezers are "in use" all the time: not news.
    .filter((appliance) => appliance.family !== 'cold')
    .filter((appliance) => appliance.connected && (appliance.status in RANK || appliance.failure))
    .sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4) || timeLeft(a) - timeLeft(b));
  if (active.length === 0) {
    return caption(text.nothing);
  }
  const runningCount = active.filter((appliance) =>
    RUNNING_STATUSES.includes(appliance.status),
  ).length;
  const components = [];
  if (runningCount > 0) {
    components.push({
      type: 'text',
      variant: 'heading',
      text: fill(text.running, { n: runningCount }),
    });
  }
  components.push({
    type: 'card-list',
    display: 'list',
    items: active.slice(0, MAX_ROWS).map((appliance) => ({
      title: hub.displayName(appliance.serial).slice(0, 60),
      subtitle: subtitleOf(appliance, lang, now),
      badge: badgeOf(appliance, lang),
    })),
  });
  return { ttl_seconds: 60, components };
}

/** Handlers of the widgets declared in the manifest, by key. */
export function createWidgets({ gladys, hub }) {
  return {
    [WIDGET_KEY]: {
      get: ({ language }) => buildWidgetContent({ gladys, hub, language }),
    },
  };
}
