// Date helpers. Every date in the app is a local calendar date string "YYYY-MM-DD".
// We never round-trip through UTC (toISOString), which is what causes off-by-one days.

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(s) {
  const m = KEY_RE.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

export function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromKey(key) {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Bad date key: ${key}`);
  // Noon avoids DST edge cases when adding days.
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export function addMonths(key, n) {
  const d = fromKey(key);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toKey(d);
}

export function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// "Today", overridable for tests with ?today=YYYY-MM-DD (browser) or an explicit argument.
export function todayKey(override) {
  if (override && isDateKey(override)) return override;
  if (typeof location !== "undefined") {
    const q = new URLSearchParams(location.search).get("today");
    if (q && isDateKey(q)) return q;
  }
  return toKey(new Date());
}

// 6x7 grid of date keys for the month containing `key`, weeks starting Sunday.
export function monthGrid(key) {
  const d = fromKey(key);
  const first = new Date(d.getFullYear(), d.getMonth(), 1, 12);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const c = new Date(start);
    c.setDate(start.getDate() + i);
    cells.push({ key: toKey(c), inMonth: c.getMonth() === first.getMonth(), day: c.getDate() });
  }
  return cells;
}

export function monthLabel(key) {
  return fromKey(key).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function prettyDate(key) {
  return fromKey(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function isSchoolDay(key) {
  const dow = fromKey(key).getDay();
  return dow >= 1 && dow <= 5;
}

// Expand a repeating reminder into the date keys it falls on between from..to (inclusive).
export function occurrences(reminder, from, to) {
  const out = [];
  if (!reminder || !isDateKey(reminder.date)) return out;
  const repeat = reminder.repeat || "none";
  if (repeat === "none") {
    if (reminder.date >= from && reminder.date <= to) out.push(reminder.date);
    return out;
  }
  let cur = reminder.date;
  let i = 0;
  while (cur <= to && i < 1000) {
    if (cur >= from) out.push(cur);
    i++;
    if (repeat === "daily") cur = addDays(reminder.date, i);
    else if (repeat === "weekly") cur = addDays(reminder.date, 7 * i);
    else if (repeat === "monthly") cur = addMonths(reminder.date, i);
    else break;
  }
  return out;
}
