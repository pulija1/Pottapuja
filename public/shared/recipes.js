// The family recipe book. The recipes live in plain Markdown files in the repository's
// recipes/ folder (see recipes/README.md), so they can be read and edited without the app or AI.
// This module loads them once at startup: from disk under Node (server, tests) and over HTTP in
// the browser. Every baby recipe must pass checkRecipe(..., { age: "baby" }); the tests enforce that.

import { normName, aisleFor } from "./shopping.js";
import { checkForAudience } from "./safety.js";
import { RECIPE_FILES, parseRecipeMarkdown, combineBooks } from "./recipe-book.js";
import { usesAppliance, fastestMinutes } from "./appliances.js";
import { recipeHasFruit } from "./kitchen.js";
import { prefProblem, prefBoost } from "./preferences.js";
import { fromKey } from "./dates.js";

async function readBook(file) {
  if (typeof process !== "undefined" && process.versions?.node && typeof window === "undefined") {
    const { readFile } = await import("node:fs/promises");
    return readFile(new URL(`../../recipes/${file}`, import.meta.url), "utf8");
  }
  // Served next to the app at recipes/. Reuse this module's ?v= so a new deploy never reads an old cached book.
  const res = await fetch(new URL(`../recipes/${file}${new URL(import.meta.url).search}`, import.meta.url), { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadBooks() {
  const failed = [];
  const parsed = await Promise.all(RECIPE_FILES.map(async (file) => {
    try {
      return parseRecipeMarkdown(await readBook(file), file);
    } catch (err) {
      failed.push({ file, error: String(err?.message || err) });
      return { recipes: [], problems: [] };
    }
  }));
  const { recipes, problems } = combineBooks(parsed);
  if (failed.length || problems.length) console.warn("[recipes] recipe book problems", { failed, problems });
  return { recipes, problems, failed };
}

const book = await loadBooks();

export const LIBRARY = book.recipes;

// Files that couldn't be read, and recipes that were skipped or need fixing, for the Recipes tab.
export const RECIPE_BOOK_STATUS = { files: RECIPE_FILES, failed: book.failed, problems: book.problems, count: LIBRARY.length };

export function libraryById(id) {
  return LIBRARY.find((x) => x.id === id) || null;
}

// The dips a recipe's **Side dip** line names, as recipes from the book. Names not in the book are left out.
export function sideDipsFor(recipe) {
  const key = (t) => String(t || "").toLowerCase().replace(/\(.*?\)/g, "").trim();
  return (recipe?.sideDips || []).map((t) => LIBRARY.find((x) => x.mealType === "side" && key(x.title) === key(t))).filter(Boolean);
}

// The cuisines the family can pick in Profile. A recipe belongs to one when its **Cuisine** line
// matches; "South Indian" counts as both Telugu and Tamil, and a fusion recipe can name two.
export const CUISINES = [
  { id: "telugu", label: "Telugu (Andhra / Hyderabad)", match: /telugu|andhra|hyderab|rayalaseema|south indian/i },
  { id: "tamil", label: "Tamil", match: /tamil|chettinad|madurai|south indian/i },
  { id: "north", label: "North Indian", match: /north indian|punjabi|mughlai|delhi|awadhi|lucknow|kashmiri|rajasthani/i },
  { id: "mexican", label: "Mexican", match: /mexican|tex-mex/i },
];

export function cuisinesOf(recipe) {
  const c = String(recipe?.cuisine || "");
  return CUISINES.filter((x) => x.match.test(c)).map((x) => x.id);
}

// True when the recipe is one of the picked cuisines, or when nothing is picked.
export function inCuisines(recipe, cuisines) {
  return !cuisines?.length || cuisinesOf(recipe).some((c) => cuisines.includes(c));
}

// Water, salt, oil, turmeric and anything used by the pinch don't count as missing,
// and nor does a leftover from yesterday ("leftover chicken curry"): it can't be bought.
const BASICS = new Set(["water", "salt", "oil", "turmeric"]);
export const isLeftoverIngredient = (name) => /^leftover\b/i.test(String(name || "").trim());
// `staples` (names, see staplesFor in freshness.js) are taken as always at home, like the basics.
const neededNames = (recipe, staples) => (recipe?.ingredients || [])
  .filter((i) => i.unit !== "pinch" && !isLeftoverIngredient(i.name))
  .map((i) => normName(i.name))
  .filter((n) => n && !BASICS.has(n) && !staples?.has(n));
const pantrySet = (pantry) => new Set((pantry || []).map((p) => normName(typeof p === "string" ? p : p.name)));

// What's in the freezer (the Frozen tab's items, or their names), as ingredient names:
// "Frozen peas" is "peas", "Parathas" is "paratha" too. Items with none left don't count.
export function freezerSet(frozen) {
  const out = new Set();
  for (const f of frozen || []) {
    if (typeof f !== "string" && f?.qty != null && !(f.qty > 0)) continue;
    const n = normName(String(typeof f === "string" ? f : f?.name || "").replace(/^frozen\s+/i, ""));
    if (!n) continue;
    out.add(n);
    if (n.endsWith("s")) out.add(normName(n.slice(0, -1)));
  }
  return out;
}

// Fresh food counts fully; the freezer counts half, so recipes use the fresh vegetables first
// (frozen food keeps for months) and reach for the freezer when the fresh ones run low.
const FROZEN_WEIGHT = 0.5;
function kitchen(pantry, frozen, staples = []) {
  const fresh = pantrySet(pantry);
  const cold = new Set([...freezerSet(frozen)].filter((n) => !fresh.has(n)));
  const assumed = new Set((staples || []).map(normName));
  return { fresh, cold, assumed, has: (n) => fresh.has(n) || cold.has(n), size: fresh.size + cold.size };
}

// Food that runs out soon gives a recipe a lift: the strongest use-soon weight among the fresh
// ingredients it uses (see useSoonWeights in freshness.js), plus a little for each other one.
// Bigger than the cuisine boost, so food about to spoil is cooked first; smaller than the busy
// morning and warm breakfast boosts, which still decide the weekday breakfasts.
export const USE_SOON_BOOST = 1;
function useSoonScore(needed, fresh, useSoon) {
  if (!useSoon?.size) return 0;
  const w = needed.filter((n) => fresh.has(n)).map((n) => useSoon.get(n) || 0).sort((a, b) => b - a);
  if (!w.length || !w[0]) return 0;
  return USE_SOON_BOOST * Math.min(1.5, w[0] + w.slice(1).reduce((t, x) => t + x * 0.25, 0));
}

// Ingredients of a recipe that are not in the pantry (basics and pinches left out).
export function missingForRecipe(recipe, pantry) {
  const have = pantrySet(pantry);
  return [...new Set(neededNames(recipe).filter((n) => !have.has(n)))];
}

// Recipes that can be cooked from the pantry right now, or with at most `maxMissing` items to buy.
// Fewest missing first, then the family favorites, then the most ingredients used.
// With cuisines, the family's picked cuisines come before the rest at the same number missing.
// frozen (the Frozen tab) counts as in the kitchen; `fromFreezer` lists what a recipe takes from it,
// and recipes that need less from the freezer come first.
// staples count as at home; with useSoon, recipes that use food running out come first at the same number missing.
export function readyToCook(pantry, { forWhom = "", maxMissing = 0, schoolNutFree = false, limit = 12, cuisines = [], frozen = [], staples = [], useSoon = null, settings = null } = {}) {
  const k = kitchen(pantry, frozen, staples);
  if (!k.size) return [];
  return LIBRARY.filter((x) => !x.leftover && (!forWhom || x.forWhom === forWhom) && suits(x, settings))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe, k.assumed))];
      const missing = needed.filter((n) => !k.has(n));
      const fromFreezer = needed.filter((n) => k.cold.has(n));
      return { recipe, missing, fromFreezer, used: needed.length - missing.length, soon: useSoonScore(needed, k.fresh, useSoon) };
    })
    .filter((x) => x.used > 0 && x.missing.length <= maxMissing)
    .sort((a, b) => a.missing.length - b.missing.length || b.soon - a.soon || a.fromFreezer.length - b.fromFreezer.length || (cuisines.length ? inCuisines(b.recipe, cuisines) - inCuisines(a.recipe, cuisines) : 0) || (b.recipe.familyFavorite ? 1 : 0) - (a.recipe.familyFavorite ? 1 : 0) || b.used - a.used)
    .slice(0, limit);
}

// Each child's needs from Profile (settings.prefs): `child` is who eats it ("baby", "kid"), or the
// recipe's own forWhom when it is for one of them. Family recipes are left as they are.
const childOf = (recipe, child) => child || (recipe.forWhom === "baby" || recipe.forWhom === "kid" ? recipe.forWhom : "");
const suits = (recipe, settings, child) => !settings || !prefProblem(recipe, childOf(recipe, child), settings);

// ---------- what a breakfast takes, and when ----------
// A school morning has time for 15 minutes of cooking at most. Work the night before should be
// easy, 20 minutes or less; anything longer (a tray of muffins, parathas, burritos) is weekend prep.
export const MORNING_MINUTES = 15;
export const EASY_NIGHT_MINUTES = 20;

// "no-cook", "morning" (quick to cook that morning), "night" (easy the night before), "weekend"
// (batch-made at the weekend) or "slow" (only for a relaxed weekend morning).
export function breakfastKind(recipe, appliances = []) {
  if (recipe?.busyMorning === "no-cook") return "no-cook";
  if (recipe?.busyMorning === "make-ahead") {
    const p = recipe.prepAhead;
    if (p?.when === "weekend" || (p?.minutes || 0) > EASY_NIGHT_MINUTES) return "weekend";
    return "night";
  }
  const m = fastestMinutes(recipe, appliances) || recipe?.prepMinutes || Infinity;
  return m <= MORNING_MINUTES ? "morning" : "slow";
}

// Can this breakfast be on the table on the morning of `key`? Weekends: anything. School days:
// no-cook, quick, easy night-before, or a weekend batch that still keeps that day (made Sunday:
// Monday is 1 day on). A batch that also freezes keeps all week.
export function fitsMorning(recipe, key, appliances = []) {
  const dow = fromKey(key).getDay();
  if (dow === 0 || dow === 6) return true;
  const kind = breakfastKind(recipe, appliances);
  if (kind === "slow") return false;
  if (kind !== "weekend") return true;
  const p = recipe.prepAhead || {};
  return !!p.frozen || !p.keepsDays || dow <= p.keepsDays;
}

const CUISINE_BOOST = 0.5;

export const APPLIANCE_BOOST = 0.1;
const FAMILY_BOOST = 0.3;
const BUSY_BOOST = 3;
const WARM_BOOST = 3;
const FRUIT_BOOST = 0.3;
// Recipes the parent marked to use often (Recipes tab, by age) get a big lift, well ahead of a
// good kitchen match, but less than the busy morning and warm breakfast boosts, which still decide
// the school-day breakfasts.
export const REGULAR_BOOST = 2;

// Rank library recipes by how many of their ingredients are in the pantry.
// With schoolNutFree, recipes that are not nut-free are left out of lunchbox and snack suggestions.
// maxMinutes (quick mode) puts recipes ready in that time first, then the fastest of the rest,
// so there is always an answer even when nothing in the book is that quick.
// appliances (["airFryer", "oven"], what the family has) gives a small lift to recipes with a method
// for one of them, and quick mode counts the faster of the stove and appliance times.
// cuisines (from Profile) lifts the family's cuisines well above the rest, so most picks come
// from them, while a strong kitchen match from another cuisine can still show up.
// busyMorning (a weekday) puts breakfasts made the night before or with no cooking well ahead,
// and the warm ones (made the night before, reheated in the microwave) first of all.
// staples (the cuisine's basics) count as at home and so don't dilute the kitchen match, and
// useSoon (Map of ingredient -> weight, from useSoonWeights) lifts recipes that use food running out.
// settings (with prefs) and child ("baby"/"kid", who will eat it) leave out recipes that don't suit
// that child and lift the ones that do; see preferences.js.
// regulars (recipe ids, see regulars.js) are the ones marked to use often, lifted by REGULAR_BOOST.
export function suggestFromLibrary(pantry, { forWhom = "both", mealType = "", limit = 6, schoolNutFree = false, maxMinutes = 0, cuisines = [], frozen = [], appliances = [], busyMorning = false, staples = [], useSoon = null, settings = null, child = "", regulars = [] } = {}) {
  const k = kitchen(pantry, frozen, staples);
  const often = new Set(regulars);
  // The whole family eats the 4-year-old's food too (mild, nothing whole), so "family" includes the
  // kid's recipes, after the family ones. The book's family recipes are mostly dinners, so without
  // this a family breakfast, lunch or snack found nothing.
  const wanted = forWhom === "both" ? ["baby", "kid", "family"] : forWhom === "family" ? ["family", "kid"] : [forWhom, "family"];
  // Weekday breakfast: what was made the night before, or needs no cooking, comes first. The baby's
  // breakfast leans toward one with a fruit in it.
  const busy = (x) => busyMorning && x.mealType === "breakfast" && !!x.busyMorning;
  // The family likes a warm breakfast: made the night before and reheated beats cold or no-cook.
  // Both boosts are bigger than every other score together, so they always decide the order.
  const warm = (x) => busy(x) && x.forWhom !== "baby" && !!x.reheat;
  const fruit = (x) => mealType === "breakfast" && x.forWhom === "baby" && recipeHasFruit(x);
  const minutes = (r) => fastestMinutes(r, appliances) || Infinity;
  const quick = (r) => minutes(r) <= maxMinutes;
  return LIBRARY.filter((x) => !x.leftover && wanted.includes(x.forWhom))
    .filter((x) => x.mealType !== "side" || mealType === "side")
    .filter((x) => !mealType || x.mealType === mealType || (mealType === "lunch" && x.mealType === "lunchbox"))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .filter((x) => suits(x, settings, child))
    .map((x) => {
      const needed = neededNames(x, k.assumed);
      const hit = needed.filter((n) => k.fresh.has(n)).length + needed.filter((n) => k.cold.has(n)).length * FROZEN_WEIGHT;
      const score = (needed.length ? hit / needed.length : 0) + useSoonScore(needed, k.fresh, useSoon) + (x.familyFavorite ? 0.15 : 0) + (cuisines.length && inCuisines(x, cuisines) ? CUISINE_BOOST : 0) + (usesAppliance(x, appliances) ? APPLIANCE_BOOST : 0)
        + (forWhom === "family" && x.forWhom === "family" ? FAMILY_BOOST : 0) + (busy(x) ? BUSY_BOOST : 0) + (warm(x) ? WARM_BOOST : 0) + (fruit(x) ? FRUIT_BOOST : 0)
        + (settings ? prefBoost(x, childOf(x, child), settings, { mealType }) : 0) + (often.has(x.id) ? REGULAR_BOOST : 0);
      return { recipe: x, score, hit };
    })
    .sort((a, b) => b.score - a.score || b.hit - a.hit)
    // Quick mode: a recipe that uses something from the kitchen beats one that doesn't, however fast.
    .sort((a, b) => !maxMinutes ? 0 : (b.hit > 0) - (a.hit > 0) || quick(b.recipe) - quick(a.recipe) || (quick(a.recipe) ? 0 : minutes(a.recipe) - minutes(b.recipe)))
    .slice(0, limit)
    .map((s) => s.recipe);
}

// How easy a recipe is, 0 to 1: quick and with few ingredients is easiest.
function ease(recipe) {
  const min = recipe.prepMinutes || 40;
  const n = neededNames(recipe).length;
  return Math.max(0, 1 - Math.max(0, min - 10) / 50) * 0.6 + Math.max(0, 1 - Math.max(0, n - 4) / 10) * 0.4;
}

// The Recipes tab's top picks: recipes that use what's in the kitchen (vegetables most of all),
// from the family's cuisines, easiest first. Recipes need at least one thing from the kitchen and at
// most `maxMissing` to buy. When nothing in the picked cuisines fits, the other cuisines are used.
// Freezer items fill in when the fresh vegetables are few, at a little less weight than fresh.
export function topPicks(pantry, { cuisines = [], schoolNutFree = false, maxMissing = 2, limit = 15, isVegetable = () => false, frozen = [], staples = [], useSoon = null, settings = null } = {}) {
  const k = kitchen(pantry, frozen, staples);
  if (!k.size) return [];
  const ranked = LIBRARY
    .filter((x) => !x.leftover && x.mealType !== "side" && suits(x, settings))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe, k.assumed))];
      const fresh = needed.filter((n) => k.fresh.has(n));
      const fromFreezer = needed.filter((n) => k.cold.has(n));
      const missing = needed.filter((n) => !k.has(n));
      const veg = fresh.filter(isVegetable).length + fromFreezer.filter(isVegetable).length * FROZEN_WEIGHT;
      const score = (needed.length ? (fresh.length + fromFreezer.length * FROZEN_WEIGHT) / needed.length : 0) + veg * 0.25 + ease(recipe) * 0.5
        - missing.length * 0.15 + (recipe.familyFavorite ? 0.1 : 0) + useSoonScore(needed, k.fresh, useSoon);
      return { recipe, missing, fromFreezer, used: fresh.length + fromFreezer.length, veg, score };
    })
    .filter((x) => x.used > 0 && x.missing.length <= maxMissing)
    .sort((a, b) => b.score - a.score);
  const mine = ranked.filter((x) => inCuisines(x.recipe, cuisines));
  return (mine.length ? mine : ranked).slice(0, limit);
}

// Easy breakfasts from what's in the kitchen, for the Recipes tab, by when the work happens: made
// that morning in MORNING_MINUTES or less (or no cooking), easy the night before, or batch-made at
// the weekend. Slow ones never show. At most `maxMissing` things to buy, the cuisine's staples taken
// as at home. Fewest missing first, then the ones that use food running out, then the child's needs,
// the picked cuisines and the quickest. Kid and family breakfasts by default; forWhom "baby" for the
// baby's. Returns [{ recipe, kind, missing, minutes, soon }].
export function quickBreakfasts(pantry, { forWhom = "", maxMissing = 1, limit = 6, schoolNutFree = false, cuisines = [], frozen = [], staples = [], useSoon = null, appliances = [], settings = null } = {}) {
  const k = kitchen(pantry, frozen, staples);
  const who = forWhom ? [forWhom] : ["kid", "family"];
  const child = forWhom === "baby" ? "baby" : "kid";
  return LIBRARY.filter((x) => x.mealType === "breakfast" && !x.leftover && who.includes(x.forWhom))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .filter((x) => suits(x, settings, child))
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe, k.assumed))];
      const missing = needed.filter((n) => !k.has(n));
      return { recipe, kind: breakfastKind(recipe, appliances), missing, used: needed.length - missing.length, minutes: fastestMinutes(recipe, appliances) || recipe.prepMinutes || 0,
        soon: useSoonScore(needed, k.fresh, useSoon), pref: settings ? prefBoost(recipe, child, settings, { mealType: "breakfast" }) : 0 };
    })
    .filter((x) => x.kind !== "slow" && x.missing.length <= maxMissing && (x.used > 0 || !x.missing.length))
    .sort((a, b) => a.missing.length - b.missing.length || b.soon - a.soon || b.pref - a.pref || (cuisines.length ? inCuisines(b.recipe, cuisines) - inCuisines(a.recipe, cuisines) : 0) || a.minutes - b.minutes || b.used - a.used)
    .slice(0, limit);
}

// What can be made from a cooked dish the next day. Reads the dish's title (and its ingredients,
// when it is a recipe) and says which kind of leftover it leaves: "chicken curry", "dal",
// "paneer curry", "beans curry", "vegetable curry" or "sambar". Empty when it isn't a curry.
const NOT_A_CURRY = /taco|quesadilla|wrap|roll|burrito|frankie|sandwich|salad|soup|fried rice|biryani|pulao|pasta|pizza|nugget|tender|enchilada|nachos|dosa|paratha/i;
export function leftoverKind(dish) {
  const title = String(dish?.title || "");
  if (!title || NOT_A_CURRY.test(title) || dish?.leftover) return "";
  const text = (title + " " + (dish?.ingredients || []).map((i) => i.name).join(" ")).toLowerCase();
  if (/\bsambar\b/i.test(title) && !/rice|sadam|bisi bele/i.test(title)) return "sambar";
  if (/chicken|kodi/.test(text) && /curry|kura|korma|kurma|masala|butter chicken|kuzhambu|salna|pulusu|tikka|kodi|gravy|tinga|mole/i.test(title)) return "chicken curry";
  if (/paneer/i.test(title) && /curry|masala|makhani|butter|palak|saag|kadai|matar|korma|kurma/i.test(title)) return "paneer curry";
  if (/rajma|chole|chana|kidney beans|chickpea|black bean|frijoles/.test(text) && /rajma|chole|chana|masala|curry|beans|frijoles/i.test(title)) return "beans curry";
  if (/\b(dal|daal|pappu|paruppu)\b/i.test(title)) return "dal";
  if (/\b(kura|koora|curry|sabzi|sabji|kootu|poriyal|kurma|korma|vepudu|fry)\b/i.test(title)) return "vegetable curry";
  return "";
}

// Leftover makeovers (left out of the lists above, since they need yesterday's curry) in the book that use this kind of leftover. A recipe's **Leftover** line
// lists what it takes; "any curry" takes the chicken, paneer, beans and vegetable curries.
export function leftoverRecipesFor(kind, { cuisines = [] } = {}) {
  if (!kind) return [];
  const curry = /curry$/.test(kind);
  const fits = LIBRARY.filter((r) => r.leftover && (r.leftover.includes(kind) || (curry && r.leftover.includes("any curry"))));
  return fits.sort((a, b) => (cuisines.length ? inCuisines(b, cuisines) - inCuisines(a, cuisines) : 0));
}

// Fry or curry. The recipe's **Dish:** line wins; otherwise the title tells (vepudu, fry, kura, pulusu, pappu, ...).
export function dishType(recipe) {
  const d = String(recipe?.dish || "").toLowerCase();
  if (d === "fry" || d === "curry") return d;
  const t = String(recipe?.title || "").toLowerCase();
  if (/\b(vepudu|fry|podi kura|stir-fry|poriyal|palya|thoran)\b/.test(t)) return "fry";
  if (/\b(kura|curry|pulusu|pappu|dal|charu|rasam|sambar|stew|kootu|gravy|masala)\b/.test(t)) return "curry";
  return "";
}

// Cook by vegetable: the family fries and curries in the book that use the picked vegetables.
// Recipes with every picked vegetable come first, then the ones with most of them; within that,
// those ready in maxMinutes (if set) and then the fastest. With onlyQuick, slower ones are left out.
// With appliances, a recipe's air fryer or oven time counts when it is faster.
export function cookByVegetables(vegetables, { maxMinutes = 0, onlyQuick = false, appliances = [] } = {}) {
  const picked = [...new Set((vegetables || []).map((v) => normName(v)).filter(Boolean))];
  const out = { fry: [], curry: [] };
  if (!picked.length) return out;
  const minutes = (r) => fastestMinutes(r, appliances) || Infinity;
  const matches = LIBRARY.filter((r) => r.forWhom === "family")
    .map((recipe) => {
      const names = new Set(recipe.ingredients.map((i) => normName(i.name)));
      const has = picked.filter((v) => names.has(v));
      return { recipe, dish: dishType(recipe), has, all: has.length === picked.length, quick: maxMinutes > 0 && minutes(recipe) <= maxMinutes };
    })
    .filter((x) => x.has.length && x.dish)
    .filter((x) => !onlyQuick || !maxMinutes || x.quick)
    .sort((a, b) => b.has.length - a.has.length || (b.quick ? 1 : 0) - (a.quick ? 1 : 0) || minutes(a.recipe) - minutes(b.recipe));
  for (const x of matches) out[x.dish].push(x);
  return out;
}

// ---------- the family dinner ----------
// The main thing a dish is made of: a vegetable (not the onion, tomato and aromatics that go in
// almost everything) or a protein. A family dinner "from the kitchen" uses one of these, fresh.
const AROMATIC = /onion|shallot|ginger|garlic|chill?i|curry leaves|coriander|mint|lemon|lime|tomato/;
export const isMainVegetable = (n) => aisleFor(n) === "Vegetables" && !AROMATIC.test(normName(n));
const MEAT = /chicken|kodi|mutton|lamb|goat|fish|prawn|shrimp|\begg|beef|pork|turkey|keema/;
const PROTEIN = /chicken|mutton|lamb|goat|fish|prawn|shrimp|\begg|paneer|tofu|chickpea|chole|rajma|kidney bean|black bean/;
const isMain = (n) => isMainVegetable(n) || PROTEIN.test(n);

// A vegetable curry: a curry, pappu, pulusu or kurma (see dishType) made with a vegetable and no meat or egg.
export function isVegCurry(recipe) {
  if (!recipe || recipe.leftover || dishType(recipe) !== "curry") return false;
  const names = (recipe.ingredients || []).map((i) => normName(i.name));
  return !names.some((n) => MEAT.test(n)) && !MEAT.test(String(recipe.title || "").toLowerCase()) && names.some(isMainVegetable);
}

// How many vegetable curries the family dinner always offers, and how many ideas 🔀 goes round.
export const VEG_CURRY_MIN = 5;
export const DINNER_POOL = 8;

// Ideas for the family dinner, from what's in the kitchen. Every one uses a fresh vegetable or
// protein from the kitchen list; a dish whose main things are only in the freezer, or that needs
// yesterday's leftovers, is never one of them (the freezer can still give a side thing, like peas).
// Fewest things to buy first, then the vegetable curries, food running out, the least from the freezer, the picked
// cuisines, the favorites and the most from the kitchen. When the kitchen has fewer than
// VEG_CURRY_MIN vegetable curries, vegetable curries that need the fewest things bought fill in,
// so there are always that many to pick from. Returns recipes.
export function familyDinnerIdeas(pantry, { frozen = [], staples = [], cuisines = [], useSoon = null, settings = null, appliances = [], maxMissing = 3, extraVeg = 7 } = {}) {
  const k = kitchen(pantry, frozen, staples);
  const rated = LIBRARY.filter((x) => x.forWhom === "family" && x.mealType === "dinner" && !x.leftover && suits(x, settings))
    .filter((x) => !(x.ingredients || []).some((i) => isLeftoverIngredient(i.name)))
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe, k.assumed))];
      const mains = needed.filter(isMain);
      return { recipe, veg: isVegCurry(recipe), fresh: mains.filter((n) => k.fresh.has(n)).length, frozenMain: mains.some((n) => k.cold.has(n)),
        fromFreezer: needed.filter((n) => k.cold.has(n)).length, missing: needed.filter((n) => !k.has(n)).length, soon: useSoonScore(needed, k.fresh, useSoon) };
    });
  const order = (a, b) => a.missing - b.missing || b.veg - a.veg || b.soon - a.soon || a.fromFreezer - b.fromFreezer
    || (cuisines.length ? inCuisines(b.recipe, cuisines) - inCuisines(a.recipe, cuisines) : 0)
    || (b.recipe.familyFavorite ? 1 : 0) - (a.recipe.familyFavorite ? 1 : 0) || b.fresh - a.fresh
    || usesAppliance(b.recipe, appliances) - usesAppliance(a.recipe, appliances);
  const fromKitchen = rated.filter((x) => x.fresh > 0 && x.missing <= maxMissing).sort(order);
  const vegHere = fromKitchen.filter((x) => x.veg).length;
  // Fill-ins to buy for: never a dish whose vegetable sits in the freezer.
  const fill = rated.filter((x) => x.veg && !fromKitchen.includes(x) && !x.frozenMain).sort(order)
    .slice(0, Math.max(0, VEG_CURRY_MIN + extraVeg - vegHere));
  return [...fromKitchen, ...fill].map((x) => x.recipe);
}

// The first `size` of a ranked list of dinners, with at least `min` vegetable curries among them
// (the best-ranked ones), in the list's own order.
export function withVegCurries(list, { size = DINNER_POOL, min = VEG_CURRY_MIN } = {}) {
  const veg = list.filter(isVegCurry).slice(0, min);
  const keep = new Set(veg);
  for (const r of list) { if (keep.size >= size) break; keep.add(r); }
  return list.filter((r) => keep.has(r)).slice(0, size);
}
