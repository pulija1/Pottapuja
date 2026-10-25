// The family recipe book. The recipes live in plain Markdown files in the repository's
// recipes/ folder (see recipes/README.md), so they can be read and edited without the app or AI.
// This module loads them once at startup: from disk under Node (server, tests) and over HTTP in
// the browser. Every baby recipe must pass checkRecipe(..., { age: "baby" }); the tests enforce that.

import { normName } from "./shopping.js";
import { checkForAudience } from "./safety.js";
import { RECIPE_FILES, parseRecipeMarkdown, combineBooks } from "./recipe-book.js";
import { usesAppliance, fastestMinutes } from "./appliances.js";

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
const neededNames = (recipe) => (recipe?.ingredients || [])
  .filter((i) => i.unit !== "pinch" && !isLeftoverIngredient(i.name))
  .map((i) => normName(i.name))
  .filter((n) => n && !BASICS.has(n));
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

// Fresh food counts fully; the freezer counts a bit less, so recipes use the fresh vegetables
// first and reach for the freezer when the fresh ones run low.
const FROZEN_WEIGHT = 0.7;
function kitchen(pantry, frozen) {
  const fresh = pantrySet(pantry);
  const cold = new Set([...freezerSet(frozen)].filter((n) => !fresh.has(n)));
  return { fresh, cold, has: (n) => fresh.has(n) || cold.has(n), size: fresh.size + cold.size };
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
export function readyToCook(pantry, { forWhom = "", maxMissing = 0, schoolNutFree = false, limit = 12, cuisines = [], frozen = [] } = {}) {
  const k = kitchen(pantry, frozen);
  if (!k.size) return [];
  return LIBRARY.filter((x) => !x.leftover && (!forWhom || x.forWhom === forWhom))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe))];
      const missing = needed.filter((n) => !k.has(n));
      const fromFreezer = needed.filter((n) => k.cold.has(n));
      return { recipe, missing, fromFreezer, used: needed.length - missing.length };
    })
    .filter((x) => x.used > 0 && x.missing.length <= maxMissing)
    .sort((a, b) => a.missing.length - b.missing.length || a.fromFreezer.length - b.fromFreezer.length || (cuisines.length ? inCuisines(b.recipe, cuisines) - inCuisines(a.recipe, cuisines) : 0) || (b.recipe.familyFavorite ? 1 : 0) - (a.recipe.familyFavorite ? 1 : 0) || b.used - a.used)
    .slice(0, limit);
}

const CUISINE_BOOST = 0.5;

export const APPLIANCE_BOOST = 0.1;

// Rank library recipes by how many of their ingredients are in the pantry.
// With schoolNutFree, recipes that are not nut-free are left out of lunchbox and snack suggestions.
// maxMinutes (quick mode) puts recipes ready in that time first, then the fastest of the rest,
// so there is always an answer even when nothing in the book is that quick.
// appliances (["airFryer", "oven"], what the family has) gives a small lift to recipes with a method
// for one of them, and quick mode counts the faster of the stove and appliance times.
// cuisines (from Profile) lifts the family's cuisines well above the rest, so most picks come
// from them, while a strong kitchen match from another cuisine can still show up.
export function suggestFromLibrary(pantry, { forWhom = "both", mealType = "", limit = 6, schoolNutFree = false, maxMinutes = 0, cuisines = [], frozen = [], appliances = [] } = {}) {
  const k = kitchen(pantry, frozen);
  const wanted = forWhom === "both" ? ["baby", "kid", "family"] : [forWhom, "family"];
  const minutes = (r) => fastestMinutes(r, appliances) || Infinity;
  const quick = (r) => minutes(r) <= maxMinutes;
  return LIBRARY.filter((x) => !x.leftover && wanted.includes(x.forWhom))
    .filter((x) => !mealType || x.mealType === mealType || (mealType === "lunch" && x.mealType === "lunchbox"))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((x) => {
      const needed = neededNames(x);
      const hit = needed.filter((n) => k.fresh.has(n)).length + needed.filter((n) => k.cold.has(n)).length * FROZEN_WEIGHT;
      const score = (needed.length ? hit / needed.length : 0) + (x.familyFavorite ? 0.15 : 0) + (cuisines.length && inCuisines(x, cuisines) ? CUISINE_BOOST : 0) + (usesAppliance(x, appliances) ? APPLIANCE_BOOST : 0);
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
export function topPicks(pantry, { cuisines = [], schoolNutFree = false, maxMissing = 2, limit = 15, isVegetable = () => false, frozen = [] } = {}) {
  const k = kitchen(pantry, frozen);
  if (!k.size) return [];
  const ranked = LIBRARY
    .filter((x) => !x.leftover)
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe))];
      const fresh = needed.filter((n) => k.fresh.has(n));
      const fromFreezer = needed.filter((n) => k.cold.has(n));
      const missing = needed.filter((n) => !k.has(n));
      const veg = fresh.filter(isVegetable).length + fromFreezer.filter(isVegetable).length * FROZEN_WEIGHT;
      const score = (needed.length ? (fresh.length + fromFreezer.length * FROZEN_WEIGHT) / needed.length : 0) + veg * 0.25 + ease(recipe) * 0.5
        - missing.length * 0.15 + (recipe.familyFavorite ? 0.1 : 0);
      return { recipe, missing, fromFreezer, used: fresh.length + fromFreezer.length, veg, score };
    })
    .filter((x) => x.used > 0 && x.missing.length <= maxMissing)
    .sort((a, b) => b.score - a.score);
  const mine = ranked.filter((x) => inCuisines(x.recipe, cuisines));
  return (mine.length ? mine : ranked).slice(0, limit);
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
