// How long the food in the kitchen keeps, and which of it to cook first. Each kitchen item can
// have a use-by date the parent typed in when adding it; without one, the date is estimated from
// how long that food usually keeps in the fridge. Also the pantry staples a family of a cuisine
// almost always has at home (rice, dals, spices, oil, onions), so suggestions don't wait on them.
// Pure functions, no I/O here.

import { normName } from "./shopping.js";
import { kitchenGroupFor } from "./kitchen.js";
import { addDays, daysBetween, isDateKey } from "./dates.js";

// Days in the fridge (or on the counter, for the ones that keep better there), roughly.
const DAYS = {
  // Leafy greens and herbs go first.
  spinach: 4, "amaranth leaves": 4, gongura: 4, "methi leaves": 4, "coriander leaves": 7, "mint leaves": 7, "curry leaves": 14, lettuce: 5,
  okra: 4, "sweet corn": 3, mushroom: 4, peas: 4, "baby corn": 4, "raw banana": 5, coconut: 4,
  brinjal: 5, "ridge gourd": 5, "bitter gourd": 5, "ivy gourd": 5, "snake gourd": 5, beans: 5, "cluster beans": 5, "broad beans": 5,
  broccoli: 5, zucchini: 5, "bottle gourd": 7, drumstick: 7, capsicum: 7, cauliflower: 7, cucumber: 7, tomato: 7, "raw mango": 7,
  "green chilli": 10, radish: 10, cabbage: 14, beetroot: 14, "taro root": 14, carrot: 21, ginger: 21, lemon: 21, "sweet potato": 21, yam: 21,
  potato: 30, onion: 30, pumpkin: 30, garlic: 60,
  // Fruits.
  strawberry: 3, strawberries: 3, banana: 4, papaya: 4, mango: 4, chikoo: 4, avocado: 4, guava: 4, plum: 4, peach: 4, pineapple: 4,
  pear: 5, watermelon: 5, raspberries: 3, blueberries: 7, blueberry: 7, grapes: 7, kiwi: 7, orange: 14, pomegranate: 21, apple: 30,
  // Milk, curd and eggs.
  buttermilk: 4, milk: 6, paneer: 5, curd: 7, cream: 7, tofu: 5, "cheddar cheese": 21, cheese: 21, butter: 30, egg: 28,
  // Made at home or bought fresh.
  "idli/dosa batter": 4, chapati: 3, roti: 3, paratha: 3, bread: 5, pav: 4, "flour tortilla": 14, "corn tortilla": 14,
  hummus: 7, chutney: 4, chicken: 2, fish: 2, prawns: 2, mutton: 3,
};
// For food not listed above, by its kitchen group. Rice, dals, flours, spices, nuts and snacks
// keep for months, so they get no date and never count as "use soon".
const GROUP_DAYS = { vegetables: 7, fruits: 5, dairy: 7, bread: 5 };
// Food in those groups that keeps for months anyway.
const KEEPS = new Set(["ghee", "milk powder", "condensed milk", "dried coconut", "desiccated coconut", "tamarind", "dry red chilli", "dried red chilli"]);

// Usual days this food keeps, or null when it keeps for months.
export function shelfLifeDays(name) {
  const n = normName(name);
  if (!n || KEEPS.has(n)) return null;
  if (DAYS[n] != null) return DAYS[n];
  if (n.endsWith("s") && DAYS[n.slice(0, -1)] != null) return DAYS[n.slice(0, -1)];
  return GROUP_DAYS[kitchenGroupFor(n)] ?? null;
}

// The key a kitchen item's dates are kept under in state.pantryDates.
export const dateKeyOf = (name) => normName(name);

// When an item runs out: { expires, estimated, daysLeft } or null when it keeps for months.
//   entry: state.pantryDates[name], { added, expires } (both "YYYY-MM-DD", either may be "")
export function expiryOf(name, entry, today) {
  const typed = isDateKey(entry?.expires) ? entry.expires : "";
  if (typed) return { expires: typed, estimated: false, daysLeft: daysBetween(today, typed) };
  const days = shelfLifeDays(name);
  if (days == null) return null;
  const added = isDateKey(entry?.added) && entry.added <= today ? entry.added : today;
  const expires = addDays(added, days);
  return { expires, estimated: true, daysLeft: daysBetween(today, expires) };
}

// Every kitchen item that runs out, soonest first: [{ name, key, expires, estimated, daysLeft }].
export function kitchenExpiry(pantry, dates = {}, today) {
  const out = [];
  for (const p of pantry || []) {
    const name = typeof p === "string" ? p : p?.name;
    const key = dateKeyOf(name);
    if (!key) continue;
    const e = expiryOf(name, dates?.[key], today);
    if (e) out.push({ name, key, ...e });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}

// What to cook first. An item that runs out within a day of `onKey` weighs 1, within 3 days 0.7,
// 5 days 0.4, a week 0.15, later 0. By `onKey` an item past a date the parent typed in is gone,
// so it weighs nothing; an estimated date is only a guess, so an item past it still counts on
// today and tomorrow ("use it now"). Names in `skip` (already used by a planned meal) weigh 0.
// Returns Map of ingredient name (normName) -> weight, only for weights above 0.
export function useSoonWeights(pantry, dates = {}, { today, onKey = today, skip = new Set() } = {}) {
  const out = new Map();
  for (const e of kitchenExpiry(pantry, dates, today)) {
    if (skip.has(e.key)) continue;
    const left = daysBetween(onKey, e.expires);
    let w = left < 0 ? (e.estimated && onKey <= addDays(today, 1) ? 1 : 0) : left <= 1 ? 1 : left <= 3 ? 0.7 : left <= 5 ? 0.4 : left <= 7 ? 0.15 : 0;
    if (w > 0) out.set(e.key, w);
  }
  return out;
}

// Kitchen items that will be past the use-by date the parent typed in by `onKey`, as names in
// the pantry: a meal planned for that day can't count on them. Estimated dates are only a guess,
// so they never take food out of the kitchen.
export function goneBy(pantry, dates = {}, { today, onKey = today } = {}) {
  return (pantry || []).filter((p) => {
    const name = typeof p === "string" ? p : p?.name;
    const e = expiryOf(name, dates?.[dateKeyOf(name)], today);
    return e && !e.estimated && e.expires < onKey && onKey > today;
  });
}

// "today", "tomorrow", "in 3 days", "2 days ago".
export function daysLeftLabel(daysLeft) {
  if (daysLeft === 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  if (daysLeft === -1) return "yesterday";
  return daysLeft > 0 ? `in ${daysLeft} days` : `${-daysLeft} days ago`;
}

// Kitchen basics a family that cooks this cuisine nearly always has, so a recipe never waits on
// them and they are never "missing". South Indian is the default: it's how this family cooks.
const SOUTH = ["rice", "toor dal", "moong dal", "urad dal", "chana dal", "mustard seeds", "jeera", "hing", "turmeric", "red chilli powder", "chilli powder",
  "dry red chilli", "dried red chilli", "red chilli", "coriander powder", "sambar powder", "rasam powder", "tamarind", "jaggery", "sugar", "ghee", "oil", "salt", "water",
  "onion", "garlic", "ginger", "green chilli", "curry leaves", "methi seeds", "fenugreek seeds"];
export const CUISINE_STAPLES = {
  telugu: SOUTH,
  tamil: SOUTH,
  north: ["atta", "rice", "basmati rice", "toor dal", "moong dal", "chana dal", "jeera", "turmeric", "red chilli powder", "chilli powder", "coriander powder", "garam masala",
    "hing", "mustard seeds", "sugar", "ghee", "oil", "salt", "water", "onion", "garlic", "ginger", "green chilli"],
  mexican: ["rice", "jeera", "chilli powder", "oregano", "oil", "salt", "water", "sugar", "onion", "garlic"],
};

// The staples for the picked cuisines (ids from CUISINES), as ingredient names. No pick means South Indian.
export function staplesFor(cuisines = []) {
  const picks = (cuisines || []).filter((c) => CUISINE_STAPLES[c]);
  const lists = picks.length ? picks.map((c) => CUISINE_STAPLES[c]) : [SOUTH];
  return [...new Set(lists.flat().map(normName))];
}

// The short names the app shows for the staples: "rice, dals, spices, oil, onion, garlic and ginger".
export function staplesSummary(cuisines = []) {
  const s = new Set(staplesFor(cuisines));
  const parts = [];
  if (s.has("rice")) parts.push("rice");
  if (s.has("atta")) parts.push("atta");
  if ([...s].some((n) => /\bdal\b/.test(n))) parts.push("dals");
  if ([...s].some((n) => /jeera|turmeric|powder|masala|mustard|oregano/.test(n))) parts.push("spices");
  if (s.has("tamarind")) parts.push("tamarind");
  if (s.has("ghee")) parts.push("ghee");
  parts.push("oil");
  for (const n of ["onion", "garlic", "ginger", "green chilli", "curry leaves"]) if (s.has(n)) parts.push(n);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
}
