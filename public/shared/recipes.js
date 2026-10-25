// The family recipe book. The recipes live in plain Markdown files in the repository's
// recipes/ folder (see recipes/README.md), so they can be read and edited without the app or AI.
// This module loads them once at startup: from disk under Node (server, tests) and over HTTP in
// the browser. Every baby recipe must pass checkRecipe(..., { age: "baby" }); the tests enforce that.

import { normName } from "./shopping.js";
import { checkForAudience } from "./safety.js";
import { RECIPE_FILES, parseRecipeMarkdown, combineBooks } from "./recipe-book.js";

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

// Water, salt, oil, turmeric and anything used by the pinch don't count as missing.
const BASICS = new Set(["water", "salt", "oil", "turmeric"]);
const neededNames = (recipe) => (recipe?.ingredients || [])
  .filter((i) => i.unit !== "pinch")
  .map((i) => normName(i.name))
  .filter((n) => n && !BASICS.has(n));
const pantrySet = (pantry) => new Set((pantry || []).map((p) => normName(typeof p === "string" ? p : p.name)));

// Ingredients of a recipe that are not in the pantry (basics and pinches left out).
export function missingForRecipe(recipe, pantry) {
  const have = pantrySet(pantry);
  return [...new Set(neededNames(recipe).filter((n) => !have.has(n)))];
}

// Recipes that can be cooked from the pantry right now, or with at most `maxMissing` items to buy.
// Fewest missing first, then the family favorites, then the most ingredients used.
export function readyToCook(pantry, { forWhom = "", maxMissing = 0, schoolNutFree = false, limit = 12 } = {}) {
  const have = pantrySet(pantry);
  if (!have.size) return [];
  return LIBRARY.filter((x) => !forWhom || x.forWhom === forWhom)
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((recipe) => {
      const needed = [...new Set(neededNames(recipe))];
      const missing = needed.filter((n) => !have.has(n));
      return { recipe, missing, used: needed.length - missing.length };
    })
    .filter((x) => x.used > 0 && x.missing.length <= maxMissing)
    .sort((a, b) => a.missing.length - b.missing.length || (b.recipe.familyFavorite ? 1 : 0) - (a.recipe.familyFavorite ? 1 : 0) || b.used - a.used)
    .slice(0, limit);
}

// Rank library recipes by how many of their ingredients are in the pantry.
// With schoolNutFree, recipes that are not nut-free are left out of lunchbox and snack suggestions.
// maxMinutes (quick mode) puts recipes ready in that time first, then the fastest of the rest,
// so there is always an answer even when nothing in the book is that quick.
export function suggestFromLibrary(pantry, { forWhom = "both", mealType = "", limit = 6, schoolNutFree = false, maxMinutes = 0 } = {}) {
  const have = pantrySet(pantry);
  const wanted = forWhom === "both" ? ["baby", "kid", "family"] : [forWhom, "family"];
  const quick = (r) => r.prepMinutes > 0 && r.prepMinutes <= maxMinutes;
  const minutes = (r) => r.prepMinutes || Infinity;
  return LIBRARY.filter((x) => wanted.includes(x.forWhom))
    .filter((x) => !mealType || x.mealType === mealType || (mealType === "lunch" && x.mealType === "lunchbox"))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((x) => {
      const needed = neededNames(x);
      const hit = needed.filter((n) => have.has(n)).length;
      const score = (needed.length ? hit / needed.length : 0) + (x.familyFavorite ? 0.15 : 0);
      return { recipe: x, score, hit };
    })
    .sort((a, b) => b.score - a.score || b.hit - a.hit)
    // Quick mode: a recipe that uses something from the kitchen beats one that doesn't, however fast.
    .sort((a, b) => !maxMinutes ? 0 : (b.hit > 0) - (a.hit > 0) || quick(b.recipe) - quick(a.recipe) || (quick(a.recipe) ? 0 : minutes(a.recipe) - minutes(b.recipe)))
    .slice(0, limit)
    .map((s) => s.recipe);
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
export function cookByVegetables(vegetables, { maxMinutes = 0, onlyQuick = false } = {}) {
  const picked = [...new Set((vegetables || []).map((v) => normName(v)).filter(Boolean))];
  const out = { fry: [], curry: [] };
  if (!picked.length) return out;
  const minutes = (r) => r.prepMinutes || Infinity;
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
