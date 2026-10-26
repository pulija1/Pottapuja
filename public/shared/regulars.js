// The Recipes tab's sections by age: the book's recipes for the 8-month-old, the 4-year-old and the
// whole family. In each section the parent can mark recipes to use often, and the meal planner then
// picks those first for that person's meals and lets them come back sooner. Pure functions, no I/O here.
//
// settings.regulars = { baby: [recipeId, ...], kid: [...], family: [...] }

export const AGE_SECTIONS = ["baby", "kid", "family"];

// The meals in a section, in the order they show.
export const SECTION_MEALS = {
  baby: ["breakfast", "lunch", "snack", "dinner"],
  kid: ["breakfast", "lunchbox", "snack", "dinner"],
  family: ["breakfast", "dinner"],
};

// A recipe used often can be planned again after this many days; the rest wait a week.
export const REGULAR_GAP_DAYS = 2;
const MAX_REGULARS = 60;

// The ids marked to use often for one person, without repeats or junk.
export function regularsFor(settings, who) {
  const list = settings?.regulars?.[who];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id) => typeof id === "string" && id))].slice(0, MAX_REGULARS);
}

export function isRegular(settings, who, id) {
  return regularsFor(settings, who).includes(id);
}

// settings.regulars with the recipe added to (or taken off) that person's list.
export function toggleRegular(settings, who, id) {
  const all = Object.fromEntries(AGE_SECTIONS.map((w) => [w, regularsFor(settings, w)]));
  if (!AGE_SECTIONS.includes(who) || !id) return all;
  all[who] = all[who].includes(id) ? all[who].filter((x) => x !== id) : [...all[who], id].slice(-MAX_REGULARS);
  return all;
}

// The book's recipes for one person, by meal: { breakfast: [...], ... }. Dips and leftover
// makeovers are left out, since they go with another dish rather than being planned on their own.
// The ones used often come first, then the family favourites, then by title.
export function ageSection(library, who, settings) {
  const often = new Set(regularsFor(settings, who));
  const out = Object.fromEntries((SECTION_MEALS[who] || []).map((m) => [m, []]));
  for (const r of library || []) {
    if (r.forWhom !== who || r.leftover || !out[r.mealType]) continue;
    out[r.mealType].push(r);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => often.has(b.id) - often.has(a.id) || !!b.familyFavorite - !!a.familyFavorite || a.title.localeCompare(b.title));
  }
  return out;
}

// The same list with the recipes used often moved to the front; otherwise the order is kept.
export function regularsFirst(list, ids) {
  const often = new Set(ids || []);
  if (!often.size) return list;
  return [...list.filter((r) => often.has(r.id)), ...list.filter((r) => !often.has(r.id))];
}
