// Family recipes (HOUSE): the family's own recipes, the weeks already approved and one vegetable a week.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY, suggestFromLibrary, libraryById } from "../public/shared/recipes.js";
import { checkForAudience } from "../public/shared/safety.js";
import { encode, decodeInto } from "../public/shared/cloud-sync.js";
import {
  familyRecipeFrom, familyRecipeFields, familyRecipeProblems, upsertFamilyRecipe, familyRecipesIn, familyRecipesForSlot, isFamilyRecipe,
  weekStartOf, approvedDaysIn, approvedWeeks, weekHistory, APPROVED_WEEKS_MIN,
  vegName, vegetablesOf, headlineVeg, vegUsedInWeek, newVegFirst, preferredFirst,
} from "../public/shared/family-recipes.js";

const NOW = new Date("2026-11-01T10:00:00Z");
const pappu = { title: "Amma's tomato pappu", forWhom: "family", mealType: "dinner", prepMinutes: "30", cuisine: "Telugu",
  ingredients: "1 cup toor dal\n2 tomatoes\n1 cup chopped bottle gourd\nSalt, to taste", steps: "1. Pressure cook the dal.\n2. Add the tomatoes and gourd, simmer.", notes: "Kids like it thin." };

test("HOUSE-01 the form becomes a recipe like one from the book, marked as the family's", () => {
  const r = familyRecipeFrom(pappu, { now: NOW });
  assert.ok(isFamilyRecipe(r));
  assert.equal(r.source, "family");
  assert.match(r.id, /^fam-amma-s-tomato-pappu-/);
  assert.equal(r.forWhom, "family");
  assert.equal(r.mealType, "dinner");
  assert.equal(r.prepMinutes, 30);
  assert.equal(r.cuisine, "Telugu");
  assert.deepEqual(r.ingredients.map((i) => i.name), ["toor dal", "tomatoes", "chopped bottle gourd", "salt"]);
  assert.deepEqual(r.ingredients[0], { name: "toor dal", quantity: 1, unit: "cup", text: "1 cup toor dal" });
  assert.deepEqual(r.steps, ["Pressure cook the dal.", "Add the tomatoes and gourd, simmer."]);
  assert.equal(r.addedAt, NOW.toISOString());
  assert.deepEqual(r.tags, []);
  assert.equal(headlineVeg(r), "bottle gourd");
  // Nutrition tags come from the ingredients, like the book's recipes.
  const egg = familyRecipeFrom({ ...pappu, title: "Egg curry", ingredients: "4 eggs\n1 onion" }, { now: NOW });
  assert.deepEqual(egg.tags, ["egg"]);
  const nuts = familyRecipeFrom({ ...pappu, forWhom: "kid", mealType: "snack", title: "Badam milk", ingredients: "1 cup milk\n5 almonds, ground" }, { now: NOW });
  assert.deepEqual(nuts.tags, ["dairy", "nuts"]);
  assert.equal(nuts.nutFree, false);
});

test("HOUSE-02 the form says what is missing, and only allows a meal that person eats", () => {
  assert.deepEqual(familyRecipeProblems(pappu), []);
  assert.equal(familyRecipeProblems({}).length, 4);
  assert.deepEqual(familyRecipeProblems({ ...pappu, title: " " }), ["Give the recipe a name."]);
  assert.deepEqual(familyRecipeProblems({ ...pappu, ingredients: "\n \n" }), ["List at least one ingredient, one per line."]);
  assert.deepEqual(familyRecipeProblems({ ...pappu, steps: "" }), ["Write at least one step, one per line."]);
  // The school lunchbox is only the 4-year-old's.
  assert.deepEqual(familyRecipeProblems({ ...pappu, forWhom: "baby", mealType: "lunchbox" }), ["Pick the meal it is for."]);
  assert.deepEqual(familyRecipeProblems({ ...pappu, forWhom: "kid", mealType: "lunchbox" }), []);
});

test("HOUSE-03 editing keeps the id and when it was added; the fields round-trip", () => {
  const r = familyRecipeFrom(pappu, { now: NOW });
  const f = familyRecipeFields(r);
  assert.equal(f.title, pappu.title);
  assert.equal(f.ingredients.split("\n")[0], "1 cup toor dal");
  assert.equal(f.ingredients.split("\n").at(-1), "Salt, to taste");
  // Edited back exactly as typed: "2 cups" stays "2 cups".
  const cups = familyRecipeFrom({ ...pappu, ingredients: "2 cups rice\n3 carrots, grated" }, { now: NOW });
  assert.equal(familyRecipeFields(cups).ingredients, "2 cups rice\n3 carrots, grated");
  const later = new Date("2026-11-05T10:00:00Z");
  const edited = familyRecipeFrom({ ...f, title: "Tomato pappu (Amma's)" }, { prev: r, now: later });
  assert.equal(edited.id, r.id);
  assert.equal(edited.addedAt, r.addedAt);
  assert.equal(edited.updatedAt, later.toISOString());
  assert.equal(edited.title, "Tomato pappu (Amma's)");
  assert.deepEqual(edited.ingredients, r.ingredients);
  assert.deepEqual(edited.steps, r.steps);
  // Saving replaces it in the saved list instead of adding a second copy.
  const saved = [{ id: "s1", title: "AI upma" }, r];
  upsertFamilyRecipe(saved, edited);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].title, "Tomato pappu (Amma's)");
  upsertFamilyRecipe(saved, familyRecipeFrom({ ...pappu, title: "Ragi java", forWhom: "baby", mealType: "breakfast" }, { now: later }));
  assert.equal(familyRecipesIn(saved).length, 2);
  assert.deepEqual(familyRecipesForSlot(saved, "baby", "breakfast").map((x) => x.title), ["Ragi java"]);
  assert.deepEqual(familyRecipesForSlot(saved, "family", "dinner").map((x) => x.title), ["Tomato pappu (Amma's)"]);
  // A whole-family breakfast, lunch or snack is offered for the 4-year-old's meals; a family dinner stays the family's.
  upsertFamilyRecipe(saved, familyRecipeFrom({ ...pappu, title: "Sunday upma", forWhom: "family", mealType: "breakfast" }, { now: later }));
  upsertFamilyRecipe(saved, familyRecipeFrom({ ...pappu, title: "Lemon rice", forWhom: "family", mealType: "lunch" }, { now: later }));
  assert.deepEqual(familyRecipesForSlot(saved, "kid", "breakfast").map((x) => x.title), ["Sunday upma"]);
  assert.deepEqual(familyRecipesForSlot(saved, "baby", "breakfast").map((x) => x.title), ["Ragi java"]);
  assert.deepEqual(familyRecipesForSlot(saved, "kid", "lunchbox").map((x) => x.title), ["Lemon rice"]);
  assert.deepEqual(familyRecipesForSlot(saved, "kid", "dinner").map((x) => x.title), []);
});

test("HOUSE-04 a baby family recipe is still checked for age safety", () => {
  const honey = familyRecipeFrom({ title: "Honey oats", forWhom: "baby", mealType: "breakfast", ingredients: "2 tbsp oats\n1 tsp honey", steps: "Cook the oats." }, { now: NOW });
  assert.equal(checkForAudience(honey).safe, false);
  const ok = familyRecipeFrom({ title: "Carrot mash", forWhom: "baby", mealType: "lunch", ingredients: "1 carrot\nwater", steps: "Steam and mash smooth." }, { now: NOW });
  assert.equal(checkForAudience(ok).safe, true);
});

test("HOUSE-05 family recipes sync with the saved recipes, item by item", () => {
  const r = familyRecipeFrom(pappu, { now: NOW });
  const state = { savedRecipes: [r], days: {}, shopping: [], todos: [], reminders: [] };
  const docs = encode(state);
  const other = { savedRecipes: [], days: {}, shopping: [], todos: [], reminders: [] };
  decodeInto(other, docs);
  assert.equal(other.savedRecipes.length, 1);
  assert.ok(isFamilyRecipe(other.savedRecipes[0]));
  assert.deepEqual(other.savedRecipes[0], r);
});

test("HOUSE-06 the planner ranks a family recipe ahead of the book's for its meal", () => {
  const r = familyRecipeFrom({ title: "Nanamma's ragi dosa", forWhom: "kid", mealType: "breakfast", ingredients: "1 cup ragi flour\n1 cup idli batter", steps: "Mix and make thin dosas." }, { now: NOW });
  const pantry = ["eggs", "bread", "milk", "potato", "onion", "tomato"];
  const without = suggestFromLibrary(pantry, { forWhom: "kid", mealType: "breakfast", limit: 5 });
  assert.ok(!without.some(isFamilyRecipe));
  const withIt = suggestFromLibrary(pantry, { forWhom: "kid", mealType: "breakfast", limit: 5, extra: [r] });
  assert.equal(withIt[0].id, r.id);
  // A family recipe for someone else, or another meal, isn't offered.
  assert.ok(!suggestFromLibrary(pantry, { forWhom: "baby", mealType: "breakfast", limit: 40, extra: [r] }).some(isFamilyRecipe));
  assert.ok(!suggestFromLibrary(pantry, { forWhom: "kid", mealType: "dinner", limit: 40, extra: [r] }).some(isFamilyRecipe));
});

// ---------- approved weeks ----------
const ids = { breakfast: ["lib-ragi-porridge", "lib-idli-dal-mash", "lib-rava-kanji"], dinner: LIBRARY.filter((r) => r.forWhom === "family" && r.mealType === "dinner").slice(0, 7).map((r) => r.id) };
const meal = (id) => ({ recipeId: id, title: libraryById(id)?.title || id, forWhom: libraryById(id)?.forWhom || "family" });
// A week of days from `sunday`, `approved` of them approved (from Sunday on).
function week(days, sunday, approved, { breakfast = ids.breakfast[0], dinners = ids.dinner } = {}) {
  for (let i = 0; i < 7; i++) {
    const k = new Date(`${sunday}T12:00:00`);
    k.setDate(k.getDate() + i);
    const key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`;
    days[key] = { meals: { baby_breakfast: meal(breakfast), family_dinner: meal(dinners[i % dinners.length]) }, schedule: [], status: i < approved ? "approved" : "pending" };
  }
  return days;
}

test("HOUSE-07 a week counts as approved with 5 or more approved days; weeks run Sunday to Saturday", () => {
  assert.equal(weekStartOf("2026-11-04"), "2026-11-01");   // Wednesday -> Sunday
  assert.equal(weekStartOf("2026-11-01"), "2026-11-01");
  assert.equal(weekStartOf("2026-11-07"), "2026-11-01");   // Saturday
  const days = {};
  week(days, "2026-10-04", 7);
  week(days, "2026-10-11", 5);
  week(days, "2026-10-18", 4);   // not enough
  week(days, "2026-10-25", 6);
  assert.equal(approvedDaysIn(days, "2026-10-11"), 5);
  assert.equal(approvedDaysIn(days, "2026-10-18"), 4);
  // Only weeks before the week being planned, newest first.
  assert.deepEqual(approvedWeeks(days, "2026-11-03"), ["2026-10-25", "2026-10-11", "2026-10-04"]);
  assert.deepEqual(approvedWeeks(days, "2026-10-28"), ["2026-10-11", "2026-10-04"]);
  // An approved day with nothing on it doesn't count.
  const empty = { "2026-10-04": { meals: {}, schedule: [], status: "approved" } };
  assert.equal(approvedDaysIn(empty, "2026-10-04"), 0);
});

test("HOUSE-08 with fewer than 3 approved weeks there is no history and the usual suggestions stay", () => {
  const days = {};
  week(days, "2026-10-11", 7);
  week(days, "2026-10-18", 7);
  week(days, "2026-10-25", 3);
  assert.equal(APPROVED_WEEKS_MIN, 3);
  assert.equal(weekHistory(days, "2026-11-02"), null);
  assert.equal(weekHistory({}, "2026-11-02"), null);
});

test("HOUSE-09 with 3 approved weeks each slot gets what those weeks had, most used first", () => {
  const days = {};
  week(days, "2026-10-11", 7, { breakfast: ids.breakfast[1] });
  week(days, "2026-10-18", 7, { breakfast: ids.breakfast[0] });
  week(days, "2026-10-25", 7, { breakfast: ids.breakfast[0] });
  const h = weekHistory(days, "2026-11-02");
  assert.deepEqual(h.weeks, ["2026-10-25", "2026-10-18", "2026-10-11"]);
  // Two weeks of ragi porridge beat one week of idli mash.
  assert.deepEqual(h.bySlot.baby_breakfast, [ids.breakfast[0], ids.breakfast[1]]);
  // Every dinner of those weeks, the one eaten on the same weekday (Monday) first.
  assert.equal(h.bySlot.family_dinner.length, 7);
  assert.equal(h.bySlot.family_dinner[0], ids.dinner[1]);
  assert.equal(weekHistory(days, "2026-11-04").bySlot.family_dinner[0], ids.dinner[3]);   // Wednesday
  // The same weekday decides first, even against a dish approved on many other days: three weeks of
  // Mon vankaya, Tue-Thu dal, Fri chana and Sat/Sun sambar give Monday the vankaya, Sunday the sambar.
  const [vankaya, dal, chana, sambar] = ids.dinner;
  const plan = [sambar, vankaya, dal, dal, dal, chana, sambar];
  const days3 = {};
  for (const sunday of ["2026-10-11", "2026-10-18", "2026-10-25"]) week(days3, sunday, 7, { dinners: plan });
  const order = (k) => weekHistory(days3, k).bySlot.family_dinner[0];
  assert.deepEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map(order), plan);
  // Days still waiting for approval are left out.
  const days2 = {};
  week(days2, "2026-10-11", 5);
  week(days2, "2026-10-18", 5);
  week(days2, "2026-10-25", 5);
  assert.ok(!weekHistory(days2, "2026-11-02").bySlot.family_dinner.includes(ids.dinner[5]));
});

// ---------- one vegetable a week ----------
test("HOUSE-10 vegetables are known by their plain names", () => {
  assert.equal(vegName("small potato"), "potato");
  assert.equal(vegName("Bendakaya"), "okra");
  assert.equal(vegName("vankaya"), "brinjal");
  assert.equal(vegName("grated carrot"), "carrot");
  assert.equal(vegName("pumpkin puree"), "pumpkin");
  assert.equal(vegName("carrots grated"), "carrot");
  assert.equal(vegName("gongura leaves"), "gongura");
  assert.equal(vegName("curry leaves"), "");
  assert.equal(vegName("onion"), "");
  assert.equal(vegName("tomato"), "");
  assert.equal(vegName("small corn tortillas"), "");
  assert.equal(vegName("chicken drumsticks"), "");
  assert.equal(vegName("toor dal"), "");
  assert.deepEqual(vegetablesOf({ ingredients: [{ name: "brinjal" }, { name: "potato" }, { name: "onion" }] }), ["brinjal", "potato"]);
});

test("HOUSE-11 a vegetable used on another day of the week goes behind the new ones", () => {
  const okra = LIBRARY.find((r) => r.forWhom === "family" && r.mealType === "dinner" && headlineVeg(r) === "okra");
  const brinjal = LIBRARY.find((r) => r.forWhom === "family" && r.mealType === "dinner" && headlineVeg(r) === "brinjal");
  const potato = LIBRARY.find((r) => r.forWhom === "family" && r.mealType === "dinner" && headlineVeg(r) === "potato");
  const plain = LIBRARY.find((r) => r.forWhom === "family" && r.mealType === "dinner" && !headlineVeg(r));
  assert.ok(okra && brinjal && potato && plain);
  const days = {
    "2026-11-02": { meals: { family_dinner: meal(okra.id) }, status: "approved" },        // Monday, this week
    "2026-11-03": { meals: { family_dinner: meal(brinjal.id) }, status: "pending" },     // Tuesday, this week
    "2026-10-30": { meals: { family_dinner: meal(potato.id) }, status: "approved" },     // last week: doesn't count
  };
  const used = vegUsedInWeek(days, "2026-11-04", libraryById);
  assert.ok(used.has("okra") && used.has("brinjal"));
  assert.ok(!used.has("potato"));
  // The day being planned doesn't count against itself.
  assert.ok(!vegUsedInWeek(days, "2026-11-02", libraryById).has("okra"));
  assert.deepEqual(newVegFirst([okra, brinjal, potato, plain], used).map((r) => r.id), [potato.id, plain.id, okra.id, brinjal.id]);
  // Nothing used yet: the order stays.
  assert.deepEqual(newVegFirst([okra, potato], new Set()).map((r) => r.id), [okra.id, potato.id]);
  // A recipe marked to use often keeps its place.
  assert.deepEqual(newVegFirst([okra, potato], used, { keep: new Set([okra.id]) }).map((r) => r.id), [okra.id, potato.id]);
});

test("HOUSE-12 preferred recipes move to the front in the given order", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(preferredFirst(list, ["c", "a"]).map((r) => r.id), ["c", "a", "b", "d"]);
  assert.deepEqual(preferredFirst(list, []).map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(preferredFirst(list, ["x", "d", "d"]).map((r) => r.id), ["d", "a", "b", "c"]);
});
