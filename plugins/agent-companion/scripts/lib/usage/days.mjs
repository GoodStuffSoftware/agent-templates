// usage/days.mjs: day arithmetic for the daily usage analysis (design section 2, "Day and week").
//
// A checkup day is [key T boundary:00Z, +24 h) with the boundary an integer UTC hour
// (environment.day.boundaryUtcHour, default 8). Everything here is plain UTC millisecond and
// calendar-date arithmetic: no local time zone is ever consulted, so a daylight-saving change
// (2026-11-01 in the US) cannot make a day 23 or 25 hours long or move a weekday. A day key is the
// UTC calendar date on which the day STARTS, which is how daily-checkup.mjs names its days.

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_BOUNDARY_UTC_HOUR = 8;

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isDayKey(k) {
  const m = KEY_RE.exec(String(k));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function assertKey(k) {
  if (!isDayKey(k)) throw new Error(`not a day key (YYYY-MM-DD): ${JSON.stringify(k)}`);
}

/** Start of day `key`, in ms since the epoch. */
export function dayStartMs(key, boundary = DEFAULT_BOUNDARY_UTC_HOUR) {
  assertKey(key);
  return Date.parse(`${key}T00:00:00Z`) + boundary * HOUR_MS;
}

/** End (exclusive) of day `key`. */
export function dayEndMs(key, boundary = DEFAULT_BOUNDARY_UTC_HOUR) { return dayStartMs(key, boundary) + DAY_MS; }

/** The key of the checkup day containing instant `ms`. */
export function dayKeyOfMs(ms, boundary = DEFAULT_BOUNDARY_UTC_HOUR) {
  const start = Math.floor((ms - boundary * HOUR_MS) / DAY_MS) * DAY_MS + boundary * HOUR_MS;
  return new Date(start - boundary * HOUR_MS).toISOString().slice(0, 10);
}

/** `key` moved by `n` days (negative = earlier). */
export function addDays(key, n) {
  assertKey(key);
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday of the day KEY (the date the day starts on): 'Sun'..'Sat'. */
export function weekdayOf(key) {
  assertKey(key);
  return WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];
}

export const floorHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** Day keys from `fromKey` to `toKey`, both included, ascending. */
export function dayRange(fromKey, toKey) {
  assertKey(fromKey); assertKey(toKey);
  const out = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) out.push(k);
  return out;
}

/** The keys of every day that overlaps [fromMs, toMs). */
export function daysOverlapping(fromMs, toMs, boundary = DEFAULT_BOUNDARY_UTC_HOUR) {
  if (!(toMs > fromMs)) return [];
  return dayRange(dayKeyOfMs(fromMs, boundary), dayKeyOfMs(toMs - 1, boundary));
}
