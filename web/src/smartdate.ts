// Relative days in collection filters (see server/smartdate.go).
//
// A date filter value may be a calendar day ("2026-10-09") or a word naming a
// day relative to today: "today", "yesterday", "tomorrow", or "today" with an
// offset such as "today-1M" (a month ago) or "today+7d" (a week from now). The
// stored value keeps the word, so a saved view stays live — the server
// resolves it again on every query. This module is the browser's copy of that
// resolution, used for the live hint under the field and for the client-side
// re-check of loaded rows. Grammar and month clamp match the Go side exactly:
// a unit-less offset counts days, and March 31 minus one month is February 28.
const TOKEN = /^(today|yesterday|tomorrow)([+-]\d+)?([dwmy])?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function shiftMonths(year: number, month: number, day: number, delta: number): [number, number, number] {
  const total = year * 12 + month + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return [y, m, Math.min(day, daysInMonth(y, m))];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The calendar day a filter value names, in YYYY-MM-DD form, or null for a
 *  plain date and for anything unrecognised — both pass through untouched. */
export function resolveSmartDate(value: string, now?: Date): string | null {
  // A filter that came from an agent need not carry a value at all (the server
  // fills one in for anything it stores, see checkViewFilter, but older data
  // predates that). Nothing here is a place to discover it: this is the
  // relative-date path every row-matching read goes through.
  const norm = String(value ?? '')
    .toLowerCase()
    .replace(/ /g, '');
  if (norm === 'today' || norm === 'yesterday' || norm === 'tomorrow') {
    return shift(norm, 0, 'd', now ?? new Date());
  }
  const m = TOKEN.exec(norm);
  if (!m || !m[2]) return null;
  const n = parseInt(m[2], 10);
  if (!Number.isFinite(n) || Math.abs(n) > 9999) return null;
  return shift(m[1], n, (m[3] ?? 'd') as 'd' | 'w' | 'm' | 'y', now ?? new Date());
}

function shift(base: string, off: number, unit: 'd' | 'w' | 'm' | 'y', now: Date): string {
  // Normalise the base day through the Date constructor first: yesterday on
  // March 1 is February 28, and a month shift below must start from there,
  // not from day zero.
  const anchor = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (base === 'yesterday' ? -1 : base === 'tomorrow' ? 1 : 0),
  );
  let y = anchor.getFullYear();
  let m = anchor.getMonth();
  let d = anchor.getDate();
  if (unit === 'w') {
    const t = new Date(y, m, d + off * 7);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  if (unit === 'm' || unit === 'y') {
    [y, m, d] = shiftMonths(y, m, d, unit === 'y' ? off * 12 : off);
  } else {
    const t = new Date(y, m, d + off);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  const t = new Date(y, m, d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** True when the value is a relative day rather than a plain date. */
export function isSmartDate(value: string): boolean {
  return resolveSmartDate(value) !== null;
}

/** A half-typed relative day ("today-"): the word and the sign are there, the
 *  offset is not. Not a value yet — a condition holding one waits instead of
 *  filtering (see filterIsArmed and the server's where()). */
export function isUnfinishedRelativeDay(value: string): boolean {
  return /^(today|yesterday|tomorrow)[+-]$/.test(String(value ?? '').toLowerCase().replace(/ /g, ''));
}
