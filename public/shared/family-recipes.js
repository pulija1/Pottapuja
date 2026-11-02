// The family's own house recipes, and how the weekly plan uses them and the weeks already approved.
// Pure functions over the app state, so they run in node tests too.
//
// - Family recipes are the ones the parent types in on the Recipes tab (👪 Family recipes). They
//   are kept with the saved recipes (state.savedRecipes, marked family: true), so family sync
//   already carries them to every phone, and the planner puts them first for their meal.
// - Approved weeks: once at least APPROVED_WEEKS_MIN weeks (Sunday to Saturday, like the calendar)
//   have APPROVED_DAYS_MIN or more approved days, new weeks are built from the meals of those
//   weeks: what was approved for a slot comes first for that slot. With fewer, the planner keeps
//   its usual kitchen suggestions.
// - One vegetable a week: a dish whose main vegetable was already used that week goes behind
//   the ones with a new vegetable, so the week goes round the vegetables before it repeats one.

import { parseIngredient, nutritionTags } from "./recipe-book.js";
import { addDays, fromKey, isDateKey } from "./dates.js";
import { isMainVegetable } from "./recipes.js";
import { normName } from "./shopping.js";

export const FAMILY_WHO = ["kid", "baby", "family"];
// The meals a family recipe can be for, by who eats it (the school lunchbox is the 4-year-old's).
export const FAMILY_MEALS = {
  kid: ["breakfast", "lunchbox", "lunch", "snack", "dinner"],
  baby: ["breakfast", "lunch", "snack", "dinner"],
  family: ["breakfast", "lunch", "snack", "dinner"],
};
// How a breakfast fits a school morning: cooked that morning, made the night before, or no cooking.
export const MORNING_KINDS = ["", "make-ahead", "no-cook"];

export const isFamilyRecipe = (r) => !!r && r.family === true;
export const familyRecipesIn = (list) => (list || []).filter(isFamilyRecipe);

const lines = (v) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// What is wrong with the form, as messages for the parent. Empty when it can be saved.
export function familyRecipeProblems(fields = {}) {
  const out = [];
  if (!String(fields.title || "").trim()) out.push("Give the recipe a name.");
  const who = FAMILY_WHO.includes(fields.forWhom) ? fields.forWhom : "";
  if (!who) out.push("Pick who it is for.");
  else if (!FAMILY_MEALS[who].includes(fields.mealType)) out.push("Pick the meal it is for.");
  if (!lines(fields.ingredients).length) out.push("List at least one ingredient, one per line.");
  if (!lines(fields.steps).length) out.push("Write at least one step, one per line.");
  return out;
}

// The form's fields as a recipe the planner and the recipe card use, like one from the book.
// `prev` is the recipe being edited: its id and when it was added are kept.
// Ingredients are one per line ("1 cup toor dal", "2 tomatoes"); steps one per line, numbers optional.
export function familyRecipeFrom(fields, { prev = null, id = "", now = new Date() } = {}) {
  const title = String(fields.title || "").trim().slice(0, 80);
  const forWhom = FAMILY_WHO.includes(fields.forWhom) ? fields.forWhom : "family";
  const mealType = FAMILY_MEALS[forWhom].includes(fields.mealType) ? fields.mealType : FAMILY_MEALS[forWhom].at(-1);
  const minutes = parseInt(fields.prepMinutes, 10);
  const recipe = {
    id: prev?.id || id || `fam-${slug(title) || "recipe"}-${now.getTime().toString(36)}`,
    title,
    forWhom,
    mealType,
    prepMinutes: minutes > 0 ? Math.min(minutes, 600) : null,
    cuisine: String(fields.cuisine || "").trim().slice(0, 40),
    texture: forWhom === "baby" ? String(fields.texture || "").trim().toLowerCase().slice(0, 40) : "",
    // Each line is kept as typed (text), so editing shows "2 cups" and not "2 cup".
    ingredients: lines(fields.ingredients).slice(0, 40).map((l) => ({ ...parseIngredient(l), text: l.replace(/^\s*[-*+]\s+/, "") })).filter((i) => i.name),
    steps: lines(fields.steps).slice(0, 30).map((s) => s.replace(/^\d+[.)]\s*/, "")),
    notes: String(fields.notes || "").trim().slice(0, 500),
    source: "family",
    family: true,
    addedAt: prev?.addedAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (mealType === "breakfast" && MORNING_KINDS.includes(fields.busyMorning) && fields.busyMorning) recipe.busyMorning = fields.busyMorning;
  if (mealType === "lunchbox" || mealType === "snack") recipe.snackBox = mealType === "snack" ? !!fields.snackBox : undefined;
  if (recipe.snackBox === undefined) delete recipe.snackBox;
  recipe.tags = nutritionTags(recipe);
  if (recipe.tags.includes("nuts")) recipe.nutFree = false;
  return recipe;
}

// A recipe back as the form's text fields, to edit it.
export function familyRecipeFields(r) {
  const qty = (i) => (i.quantity != null ? `${i.quantity}${i.unit && i.unit !== "pcs" ? " " + i.unit : ""} ` : "");
  return {
    title: r?.title || "",
    forWhom: r?.forWhom || "family",
    mealType: r?.mealType || "dinner",
    prepMinutes: r?.prepMinutes ? String(r.prepMinutes) : "",
    cuisine: r?.cuisine || "",
    texture: r?.texture || "",
    busyMorning: r?.busyMorning || "",
    snackBox: !!r?.snackBox,
    ingredients: (r?.ingredients || []).map((i) => i.text || `${qty(i)}${i.name}${i.note ? ", " + i.note : ""}`).join("\n"),
    steps: (r?.steps || []).join("\n"),
    notes: r?.notes || "",
  };
}

// Adds or replaces a family recipe in the saved list (by id). Returns the list.
export function upsertFamilyRecipe(saved, recipe) {
  const list = saved || [];
  const at = list.findIndex((r) => r.id === recipe.id);
  if (at >= 0) list[at] = recipe; else list.push(recipe);
  return list;
}

// The family recipes for a slot ("kid_lunchbox" eats kid lunchbox or lunch recipes). The whole
// family's breakfast, lunch and snack recipes count for the 4-year-old's meals (the family's only
// own slot is dinner, and the 4-year-old eats what the family eats); the planner still checks each
// one is safe for her. The baby's food needs its own soft textures, so baby recipes are added as baby's.
export function familyRecipesForSlot(list, who, meal) {
  const forWho = (r) => r.forWhom === who || (who === "kid" && r.forWhom === "family" && r.mealType !== "dinner");
  return familyRecipesIn(list).filter((r) => forWho(r) && (r.mealType === meal || (meal === "lunchbox" && r.mealType === "lunch")));
}

// ---------- approved weeks ----------
export const APPROVED_WEEKS_MIN = 3;
export const APPROVED_DAYS_MIN = 5;
export const HISTORY_WEEKS = 8;   // the most recent approved weeks looked at

// The Sunday that starts the week of `key` (the calendar's weeks run Sunday to Saturday).
export const weekStartOf = (key) => addDays(key, -fromKey(key).getDay());

const planned = (day) => Object.values(day?.meals || {}).some((m) => m?.title);

// How many days of the week starting `sunday` are approved with meals on them.
export function approvedDaysIn(days, sunday) {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = days?.[addDays(sunday, i)];
    if (d && d.status === "approved" && planned(d)) n++;
  }
  return n;
}

// The approved weeks before the week of `key`, newest first, as their Sundays.
export function approvedWeeks(days, key, { min = APPROVED_DAYS_MIN, max = HISTORY_WEEKS } = {}) {
  const current = weekStartOf(key);
  const sundays = new Set(Object.keys(days || {}).filter(isDateKey).map(weekStartOf).filter((s) => s < current));
  return [...sundays].sort().reverse().filter((s) => approvedDaysIn(days, s) >= min).slice(0, max);
}

// What the approved weeks had in each slot, when there are at least APPROVED_WEEKS_MIN of them:
// { weeks, bySlot: { slotId: [recipeId, ...] } }, each slot's recipes ordered by how often they
// were approved on the same weekday as `key`, then how often on any day, then the newest week. null when there aren't enough.
export function weekHistory(days, key, { minWeeks = APPROVED_WEEKS_MIN } = {}) {
  const weeks = approvedWeeks(days, key);
  if (weeks.length < minWeeks) return null;
  const dow = fromKey(key).getDay();
  const score = {};
  weeks.forEach((sunday, w) => {
    for (let i = 0; i < 7; i++) {
      const d = days[addDays(sunday, i)];
      if (!d || d.status !== "approved") continue;
      for (const [slot, m] of Object.entries(d.meals || {})) {
        if (!m?.recipeId || !m.title) continue;
        const s = ((score[slot] ||= new Map()).get(m.recipeId)) || { same: 0, n: 0, newest: Infinity };
        if (i === dow) s.same++;
        s.n++;
        s.newest = Math.min(s.newest, w);
        score[slot].set(m.recipeId, s);
      }
    }
  });
  const bySlot = {};
  for (const [slot, map] of Object.entries(score)) {
    bySlot[slot] = [...map.entries()].sort((a, b) => b[1].same - a[1].same || b[1].n - a[1].n || a[1].newest - b[1].newest || a[0].localeCompare(b[0])).map(([id]) => id);
  }
  return { weeks, bySlot };
}

// ---------- one vegetable a week ----------
// A vegetable by its plain name: "small potato", "grated carrot" and "baby spinach" are potato,
// carrot and spinach, so they count as the same vegetable. Tortillas and breads are not vegetables.
const SIZE_WORDS = /^(?:(?:small|large|medium|big|baby|fresh|ripe|tender|young|frozen|grated|chopped|diced|sliced|cubed|boiled|mashed|steamed|peeled|cooked|raw|red|green|yellow)\s+)+/;
const NOT_VEG = /tortilla|bread|roti|chapati|paratha|wrap|chips|flour|powder|paste|sauce|pickle|batter|chicken|mutton|fish|\begg|leftover/;
export function vegName(name) {
  const n = normName(name);
  if (!n || NOT_VEG.test(n) || !isMainVegetable(n)) return "";
  const plain = normName(n.replace(SIZE_WORDS, "").replace(/(?:\s+(?:puree|purée|florets|cubes|mash|leaves|grated|chopped|diced|sliced|cubed|peeled|boiled))+$/, ""));
  return plain && isMainVegetable(plain) ? plain : n;
}
// The main vegetables of a dish: every vegetable in it that isn't an onion, tomato or other aromatic.
export function vegetablesOf(recipe) {
  return [...new Set((recipe?.ingredients || []).map((i) => vegName(typeof i === "string" ? i : i?.name)).filter(Boolean))];
}
// The vegetable a dish is about (its first main vegetable), or "" when it has none.
export function headlineVeg(recipe) {
  return vegetablesOf(recipe)[0] || "";
}

// Every main vegetable in the meals planned in the week of `key` (Sunday to Saturday), leaving out
// `key` itself (its meals are being suggested; pass them in `extra`). `find(id)` gives the recipe
// for a planned meal; a meal typed in by hand counts by its title.
export function vegUsedInWeek(days, key, find, { extra = [] } = {}) {
  const used = new Set();
  const sunday = weekStartOf(key);
  const add = (r) => { for (const v of vegetablesOf(r)) used.add(v); };
  for (let i = 0; i < 7; i++) {
    const k = addDays(sunday, i);
    if (k === key) continue;
    for (const m of Object.values(days?.[k]?.meals || {})) {
      if (!m?.title) continue;
      add((m.recipeId && find(m.recipeId)) || { ingredients: [{ name: m.title }] });
    }
  }
  for (const r of extra) if (r) add(r);
  return used;
}

// The list with the dishes whose headline vegetable is still new this week first; otherwise in order.
// `keep` (ids, like the recipes marked to use often) are never moved back: the parent wants those again.
export function newVegFirst(list, used, { keep = null } = {}) {
  if (!used?.size) return list;
  const repeat = (r) => { const v = headlineVeg(r); return !!v && used.has(v) && !keep?.has?.(r.id); };
  return [...list.filter((r) => !repeat(r)), ...list.filter(repeat)];
}

// The list with the recipes whose ids are in `ids` moved to the front, in the order of `ids`.
export function preferredFirst(list, ids) {
  const rank = new Map();
  for (const id of ids || []) if (!rank.has(id)) rank.set(id, rank.size);
  if (!rank.size) return list;
  const pref = list.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...pref, ...list.filter((r) => !rank.has(r.id))];
}
