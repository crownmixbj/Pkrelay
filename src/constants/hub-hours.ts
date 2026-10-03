import { lagosNow } from '@/lib/when';

import type { Hub } from '@/constants/hubs';

/**
 * Reading the opening hours the hub data already carries.
 *
 * The strings are human-written ("Mon–Sat, 8:00am – 8:00pm") because that is
 * what a hub manager can maintain. Parsing them here means the Hours view can
 * answer the question people actually have — *is it open right now?* — without
 * a second, duplicated machine-readable field that would immediately drift out
 * of sync with the one shown on screen.
 *
 * A string that does not parse is not an error. It falls back to displaying the
 * text as written, which is still useful; only the live badge is withheld.
 */

/** Minutes from midnight. */
type Minutes = number;

export type OpeningHours = {
  /** 0 Sunday … 6 Saturday, matching `Date.getDay`. */
  days: number[];
  opens: Minutes;
  closes: Minutes;
};

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/*
 * The data uses en-dashes (–), not hyphens, in both the day range and the time
 * range. Accepting either costs nothing and stops a hyphen typed by a future
 * editor from silently disabling the badge for that hub.
 */
const DASH = '[–—-]';

const DAY_RANGE = new RegExp(`^(\\w{3})\\s*${DASH}\\s*(\\w{3})$`, 'i');
const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

function parseTime(value: string): Minutes | null {
  const match = value.trim().match(TIME);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3].toLowerCase();

  if (hour < 1 || hour > 12 || minute > 59) return null;

  // 12am is 00:00 and 12pm is 12:00 — the one case where the usual
  // "add 12 for pm" rule gives the wrong answer twice a day.
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'pm' && hour !== 12) hour += 12;

  return hour * 60 + minute;
}

function parseDays(value: string): number[] | null {
  const trimmed = value.trim();

  const range = trimmed.match(DAY_RANGE);
  if (range) {
    const from = DAY_INDEX[range[1].toLowerCase()];
    const to = DAY_INDEX[range[2].toLowerCase()];
    if (from === undefined || to === undefined) return null;

    // Walk forward, wrapping, so "Sat–Mon" works as well as "Mon–Sat".
    const days: number[] = [];
    for (let day = from; ; day = (day + 1) % 7) {
      days.push(day);
      if (day === to) break;
      if (days.length > 7) return null;
    }
    return days;
  }

  // A single day, or a comma list: "Mon, Wed, Fri".
  const single = trimmed
    .split(',')
    .map((part) => DAY_INDEX[part.trim().slice(0, 3).toLowerCase()])
    .filter((day): day is number => day !== undefined);

  return single.length > 0 ? single : null;
}

/** "Mon–Sat, 8:00am – 8:00pm" → days plus open and close minutes. */
export function parseHours(text: string): OpeningHours | null {
  const [dayPart, timePart] = text.split(',').length > 2 ? [null, null] : text.split(/,(.+)/);
  if (!dayPart || !timePart) return null;

  const days = parseDays(dayPart);
  if (!days) return null;

  const times = timePart.split(new RegExp(DASH));
  if (times.length !== 2) return null;

  const opens = parseTime(times[0]);
  const closes = parseTime(times[1]);
  if (opens === null || closes === null) return null;

  // A hub that closes before it opens is a data error, not an overnight shift —
  // none of these are 24-hour depots. Refusing it keeps a nonsense badge off
  // the screen.
  if (closes <= opens) return null;

  return { days, opens, closes };
}

/**
 * Now, in Lagos.
 *
 * Deliberately not the device clock. Nigeria is UTC+1 year-round, but a sender
 * checking hub hours from London — or a phone with the wrong timezone — would
 * otherwise be told a hub is open when its shutters are down. The hours belong
 * to the hub, so the clock has to as well.
 */
export function nigeriaNow(date: Date = new Date()): { day: number; minutes: Minutes } {
  /*
   * ⚠ This used `Intl.DateTimeFormat(..., { timeZone: 'Africa/Lagos' })`, and
   *   the conclusion was right while the mechanism was a hazard: an unsupported
   *   zone throws `RangeError` on a Hermes build without full ICU, and this
   *   function decides whether a hub renders as open. `lib/when.ts` does the
   *   same shift arithmetically — WAT is UTC+1 all year — so the answer is
   *   identical on every engine and the open/closed badge cannot crash a screen.
   */
  const { weekday, hour, minute } = lagosNow(date);

  return { day: weekday, minutes: hour * 60 + minute };
}

export type OpenState =
  | { known: false }
  | { known: true; open: true; closesIn: Minutes }
  | { known: true; open: false; reason: 'closed-today' | 'before-opening' | 'after-closing' };

export function openState(hub: Hub, now = nigeriaNow()): OpenState {
  const hours = parseHours(hub.hours);
  if (!hours) return { known: false };

  if (!hours.days.includes(now.day)) return { known: true, open: false, reason: 'closed-today' };
  if (now.minutes < hours.opens) return { known: true, open: false, reason: 'before-opening' };
  if (now.minutes >= hours.closes) return { known: true, open: false, reason: 'after-closing' };

  return { known: true, open: true, closesIn: hours.closes - now.minutes };
}

function formatMinutes(total: Minutes): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;

  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr${hours === 1 ? '' : 's'}`;
  return `${hours} hr ${minutes} min`;
}

/** Short label for the badge. Null when the hours could not be read. */
export function openLabel(state: OpenState): string | null {
  if (!state.known) return null;

  if (state.open) {
    // Under an hour left is worth saying — it changes whether it is worth
    // setting off. Beyond that "Open now" is enough.
    return state.closesIn <= 60 ? `Closing in ${formatMinutes(state.closesIn)}` : 'Open now';
  }

  switch (state.reason) {
    case 'before-opening':
      return 'Opens later today';
    case 'after-closing':
      return 'Closed for today';
    case 'closed-today':
      return 'Closed today';
  }
}
