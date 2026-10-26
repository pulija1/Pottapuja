// The 4-year-old's school lunches go round one list in order, a school day at a time, week after
// week. A lunch that needs something already in the kitchen (chicken, idli batter) is skipped when
// it isn't there, and the next one on the list is used. Pure functions, no I/O here.

import { addDays, isSchoolDay } from "./dates.js";

export const LUNCH_ROTATION = [
  { id: "ds-pb-jam-sandwich" },
  { id: "ds-egg-corn-rice" },
  { id: "ds-chicken-quesadilla", needs: "chicken", has: /\bchicken\b(?! (?:masala|stock|powder|cube|seasoning))/ },
  { id: "ds-idli-lunchbox", needs: "idli batter", has: /\b(?:idli|idly|dosa)\b.*\bbatter\b/ },
  { id: "lib-mac-and-cheese-with-peas-and-broccoli" },
  { id: "lib-cream-cheese-cucumber-sandwich" },
  { id: "lib-oat-waffles-with-blueberries-and-chocolate-chips" },
];

const ROTATION_IDS = LUNCH_ROTATION.map((l) => l.id);
// How far back to look for the last lunch from the list.
const LOOK_BACK_DAYS = 28;

const nameOf = (p) => String(typeof p === "string" ? p : p?.name || "").toLowerCase();

// Whether the kitchen (and the freezer) has what this lunch needs.
export function lunchFits(lunch, kitchen) {
  return !lunch.has || (kitchen || []).some((p) => lunch.has.test(nameOf(p)));
}

// The lunches that come after `lastId` (from the start when it isn't on the list), in order and once
// round, without the ones the kitchen can't make or `ok(id)` turns down.
export function lunchesAfter(lastId, kitchen, ok = () => true) {
  const start = ROTATION_IDS.indexOf(lastId) + 1;
  return LUNCH_ROTATION.map((_, i) => LUNCH_ROTATION[(start + i) % LUNCH_ROTATION.length])
    .filter((l) => lunchFits(l, kitchen) && ok(l.id))
    .map((l) => l.id);
}

// The lunches for the school day `key`, the one that's due first. Due means next after the last
// lunch from the list planned before it; empty school days from today on count as getting their turn,
// so a week of suggestions goes on down the list. A lunch that isn't on the list doesn't move it on.
export function lunchTurn(key, { days = {}, today = key, kitchen = [], ok } = {}) {
  let from = addDays(key, -LOOK_BACK_DAYS);
  let last = "";
  for (let k = addDays(key, -1); k >= from; k = addDays(k, -1)) {
    const id = days[k]?.meals?.kid_lunchbox?.recipeId;
    if (ROTATION_IDS.includes(id)) { last = id; from = k; break; }
  }
  for (let k = addDays(from, 1); k < key; k = addDays(k, 1)) {
    if (!isSchoolDay(k)) continue;
    const meal = days[k]?.meals?.kid_lunchbox;
    if (meal?.title) { if (ROTATION_IDS.includes(meal.recipeId)) last = meal.recipeId; continue; }
    if (k >= today) last = lunchesAfter(last, kitchen, ok)[0] || last;
  }
  return lunchesAfter(last, kitchen, ok);
}
