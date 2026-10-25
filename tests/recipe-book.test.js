// The Markdown recipe book (recipes/*.md): parsing, safety of every recipe, and pantry matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIngredient, parseRecipeMarkdown, combineBooks, nutritionTags, recipeToMarkdown, RECIPE_FILES } from "../public/shared/recipe-book.js";
import { LIBRARY, RECIPE_BOOK_STATUS, readyToCook, missingForRecipe, suggestFromLibrary, cuisinesOf, inCuisines, topPicks, leftoverKind, leftoverRecipesFor, freezerSet } from "../public/shared/recipes.js";
import { aisleFor, missingFromPantry } from "../public/shared/shopping.js";
import { checkForAudience, checkRecipe, isSchoolFood } from "../public/shared/safety.js";
import { normName } from "../public/shared/shopping.js";

const book = (f) => readFileSync(new URL(`../recipes/${f}`, import.meta.url), "utf8");

test("BOOK-01 ingredient lines: amount, unit, name and note", () => {
  assert.deepEqual(parseIngredient("- 1½ cups rice, washed"), { name: "rice", quantity: 1.5, unit: "cup", note: "washed" });
  assert.deepEqual(parseIngredient("- 2 tbsp almond powder"), { name: "almond powder", quantity: 2, unit: "tbsp" });
  assert.deepEqual(parseIngredient("- 6 curry leaves"), { name: "curry leaves", quantity: 6, unit: "pcs" });
  assert.deepEqual(parseIngredient("- ¼ onion, very finely chopped"), { name: "onion", quantity: 0.25, unit: "pcs", note: "very finely chopped" });
  assert.deepEqual(parseIngredient("- 1 1/2 cup milk"), { name: "milk", quantity: 1.5, unit: "cup" });
  assert.deepEqual(parseIngredient("- 2-3 slices bread"), { name: "bread", quantity: 2, unit: "slice" });
  assert.deepEqual(parseIngredient("- Salt, to taste"), { name: "salt", quantity: null, unit: "", note: "to taste" });
  assert.deepEqual(parseIngredient("- ½ cup milk (or water, breast milk), warm"), { name: "milk (or water, breast milk)", quantity: 0.5, unit: "cup", note: "warm" });
});

test("BOOK-02 a recipe block becomes a recipe with its fields, steps and notes", () => {
  const { recipes, problems } = parseRecipeMarkdown(`
## Breakfast

### Egg and cheese quesadilla

- **For:** kid
- **Meal:** School lunchbox
- **Cuisine:** Mexican American
- **Time:** 10 min
- **Nut-free swap:** none needed
- **Family favorite:** yes

**Ingredients**

- 1 flour tortilla
- 1 egg, scrambled
- 2 tbsp cheddar cheese, grated

**Steps**

1. Scramble the egg.
2. Fill the tortilla
   and toast it.

**Notes:** Cut into
wedges.
`, "test.md");
  assert.deepEqual(problems, []);
  const r = recipes[0];
  assert.equal(r.id, "lib-egg-and-cheese-quesadilla");
  assert.equal(r.forWhom, "kid");
  assert.equal(r.mealType, "lunchbox");
  assert.equal(r.cuisine, "Mexican American");
  assert.equal(r.prepMinutes, 10);
  assert.equal(r.section, "Breakfast");
  assert.equal(r.familyFavorite, true);
  assert.equal(r.nutFreeSwap, "none needed");
  assert.equal(r.ingredients.length, 3);
  assert.deepEqual(r.steps, ["Scramble the egg.", "Fill the tortilla and toast it."]);
  assert.equal(r.notes, "Cut into wedges.");
  assert.deepEqual(r.tags, ["egg", "dairy"]);
  assert.equal(r.source, "library");
});

test("BOOK-03 a broken recipe is skipped and reported with its file and line; duplicate ids are reported", () => {
  const md = "### No steps\n\n- **For:** kid\n- **Meal:** snack\n\n**Ingredients**\n\n- 1 apple\n\n### Nobody\n\n- **Meal:** snack\n\n**Ingredients**\n\n- 1 apple\n\n**Steps**\n\n1. Eat.\n";
  const { recipes, problems } = parseRecipeMarkdown(md, "x.md");
  assert.equal(recipes.length, 0);
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => [p.file, p.line, p.title]), [["x.md", 1, "No steps"], ["x.md", 10, "Nobody"]]);
  const one = "### Apple\n\n- **For:** kid\n- **Meal:** snack\n\n**Ingredients**\n\n- 1 apple\n\n**Steps**\n\n1. Slice.\n";
  const combined = combineBooks([parseRecipeMarkdown(one, "a.md"), parseRecipeMarkdown(one, "b.md")]);
  assert.equal(combined.recipes.length, 1);
  assert.match(combined.problems[0].message, /Same id/);
});

test("BOOK-04 egg, milk/dairy and nuts are worked out from the ingredients", () => {
  const tags = (...names) => nutritionTags({ ingredients: names.map((name) => ({ name })) });
  assert.deepEqual(tags("eggs", "paneer", "cashew powder"), ["egg", "dairy", "nuts"]);
  assert.deepEqual(tags("eggplant", "coconut milk", "butter", "ghee", "nutmeg"), []);
  assert.deepEqual(tags("peanut butter"), ["nuts"]);
  assert.deepEqual(tags("yogurt"), ["dairy"]);
});

test("BOOK-05 every file loads with no problems, and every recipe passes the safety check", () => {
  assert.deepEqual(RECIPE_BOOK_STATUS.failed, []);
  assert.deepEqual(RECIPE_BOOK_STATUS.problems, []);
  assert.ok(LIBRARY.length >= 100, "recipes: " + LIBRARY.length);
  for (const r of LIBRARY) {
    const res = checkForAudience(r);
    assert.equal(res.safe, true, `${r.file} "${r.title}": ${JSON.stringify(res.errors)}`);
  }
  for (const r of LIBRARY.filter((x) => x.forWhom === "baby")) {
    assert.ok(["puree", "mashed", "porridge", "soft finger food", "soft"].includes(r.texture), `${r.title}: texture "${r.texture}"`);
    assert.equal(checkRecipe(r, { age: "baby" }).warnings.filter((w) => w.rule !== "cow-milk-drink").length, 0, r.title);
  }
});

test("BOOK-06 the 4-year-old has an egg breakfast for every day of the week, plus dairy and nut options", () => {
  const kid = LIBRARY.filter((r) => r.forWhom === "kid");
  assert.ok(kid.filter((r) => r.mealType === "breakfast" && r.tags.includes("egg")).length >= 7);
  assert.ok(kid.filter((r) => r.tags.includes("dairy")).length >= 20);
  assert.ok(kid.filter((r) => r.tags.includes("nuts")).length >= 10);
  const cuisines = new Set(kid.map((r) => r.cuisine));
  for (const c of ["South Indian", "Indian American", "Mexican American", "American"]) assert.ok(cuisines.has(c), c);
  // School food with nuts says what to do if the school turns nut-free.
  for (const r of kid.filter((x) => isSchoolFood(x) && x.tags.includes("nuts"))) assert.ok(r.nutFreeSwap, r.title);
  // And no kid recipe uses whole nuts.
  for (const r of kid) assert.ok(!checkRecipe(r, { age: "kid" }).warnings.some((w) => w.rule === "whole-nuts"), r.title);
});

test("BOOK-07 recipes moved from the old built-in list keep their ids, so saved plans still find them", () => {
  const ids = ["lib-ragi-porridge", "lib-moong-khichdi", "lib-egg-yolk-mash", "lib-lemon-rice", "lib-egg-dosa", "lib-sambar-rice",
    "ds-paneer-paratha", "ds-oats-waffles", "ds-pb-jam-sandwich", "ds-chicken-quesadilla", "ds-cheese-nuts-snack", "ds-plum-snack"];
  for (const id of ids) assert.ok(LIBRARY.some((r) => r.id === id), id);
});

test("BOOK-08 ready to cook: recipes the pantry can make now, and ones a single item short", () => {
  const pantry = ["eggs", "whole wheat bread", "milk", "almond powder", "banana", "butter"];
  const now = readyToCook(pantry, { maxMissing: 0, limit: 100 });
  assert.ok(now.length > 0);
  for (const x of now) assert.deepEqual(missingForRecipe(x.recipe, pantry), []);
  assert.ok(now.some((x) => x.recipe.title.startsWith("French toast sticks")), now.map((x) => x.recipe.title).join(", "));
  const nearly = readyToCook(pantry, { maxMissing: 1, limit: 100 }).filter((x) => x.missing.length === 1);
  assert.ok(nearly.length > 0);
  assert.deepEqual(readyToCook([], {}), []);
  // Nut-free school: nut lunchbox and snack recipes are left out.
  assert.ok(!readyToCook(["apple", "peanut butter", "yogurt"], { schoolNutFree: true, limit: 100 }).some((x) => x.recipe.title.startsWith("Apple slices with peanut butter")));
  assert.equal(suggestFromLibrary(["corn tortilla", "egg", "black beans", "mild salsa", "queso fresco", "avocado"], { forWhom: "kid", mealType: "breakfast", limit: 1 })[0].title, "Huevos rancheros soft tacos (mild)");
});

test("BOOK-09 writing a recipe back to Markdown and reading it again gives the same recipe", () => {
  for (const r of LIBRARY.slice(0, 40)) {
    const again = parseRecipeMarkdown(recipeToMarkdown(r), r.file).recipes[0];
    for (const k of ["id", "title", "forWhom", "mealType", "texture", "prepMinutes", "cuisine", "steps", "notes", "tags"]) assert.deepEqual(again[k], r[k], `${r.title} ${k}`);
    assert.deepEqual(again.ingredients, r.ingredients, r.title);
  }
});

test("BOOK-11 the links in the recipe book README point at real recipes", () => {
  const slug = (t) => t.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
  const anchors = Object.fromEntries(RECIPE_FILES.map((f) => [f, new Set(book(f).split("\n").filter((l) => /^#{1,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))))]));
  anchors["README.md"] = new Set(book("README.md").split("\n").filter((l) => /^#{1,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
  const links = [...RECIPE_FILES, "README.md"].flatMap((f) => [...book(f).matchAll(/\]\(([\w-]+\.md)(?:#([\w-]+))?\)/g)].map((m) => [f, m[1], m[2]]));
  assert.ok(links.length >= 21);
  for (const [from, file, anchor] of links) {
    assert.ok(anchors[file], `${from} links to missing file ${file}`);
    if (anchor) assert.ok(anchors[file].has(anchor), `${from} links to ${file}#${anchor}`);
  }
});

test("BOOK-11 Telugu curries: family dinners with a baby portion, and Telugu vegetable names match the recipes", () => {
  const telugu = LIBRARY.filter((r) => r.file === "telugu-curries.md");
  assert.ok(telugu.length >= 15, "recipes: " + telugu.length);
  for (const r of telugu) {
    assert.equal(r.forWhom, "family", r.title);
    assert.equal(r.mealType, "dinner", r.title);
    assert.equal(r.cuisine, "Telugu", r.title);
    assert.ok(r.steps.some((s) => /baby portion/i.test(s)), r.title + ": no baby portion step");
  }
  for (const [te, en] of [["Vankaya (brinjal)", "brinjal"], ["sorakaya", "bottle gourd"], ["Bendakaya", "okra"], ["beerakaya", "ridge gourd"],
    ["Palakura (spinach)", "spinach"], ["gongura", "gongura"], ["Pachi mirapakaya (green chilli)", "green chilli"], ["kandi pappu", "toor dal"]]) {
    assert.equal(normName(te), en, te);
  }
  assert.equal(normName("pachi mirapakaya"), normName("green chillies"));
  // A kitchen filled with Telugu names is ready to cook a Telugu curry.
  const pantry = ["Vankaya (brinjal)", "Ullipaya (onion)", "Tamata (tomato)", "rice", "mustard seeds", "curry leaves", "red chilli powder", "coriander powder"];
  assert.ok(readyToCook(pantry, { maxMissing: 0, limit: 100 }).some((x) => x.recipe.title.startsWith("Vankaya kura")));
});

test("BOOK-12 cuisines from Profile: South Indian counts as Telugu and Tamil, and suggestions lean toward the picked ones", () => {
  assert.deepEqual(cuisinesOf({ cuisine: "South Indian" }), ["telugu", "tamil"]);
  assert.deepEqual(cuisinesOf({ cuisine: "Telugu (Hyderabadi)" }), ["telugu"]);
  assert.deepEqual(cuisinesOf({ cuisine: "Telugu / Mexican fusion" }), ["telugu", "mexican"]);
  assert.deepEqual(cuisinesOf({ cuisine: "Punjabi" }), ["north"]);
  assert.deepEqual(cuisinesOf({ cuisine: "Mexican American" }), ["mexican"]);
  assert.deepEqual(cuisinesOf({ cuisine: "Japanese" }), []);
  assert.ok(inCuisines({ cuisine: "Japanese" }, []), "nothing picked means every cuisine");
  for (const c of ["telugu", "tamil", "north", "mexican"]) assert.ok(LIBRARY.filter((r) => cuisinesOf(r).includes(c)).length >= 8, c);
  const picks = suggestFromLibrary([], { forWhom: "kid", mealType: "lunchbox", limit: 6, cuisines: ["mexican"] });
  assert.ok(picks.filter((r) => inCuisines(r, ["mexican"])).length >= 4, picks.map((r) => r.cuisine).join(", "));
});

test("BOOK-13 top picks: easy recipes that use the kitchen's vegetables, from the picked cuisines only", () => {
  const isVeg = (n) => aisleFor(n) === "Vegetables" && !/onion|tomato|chill?i|curry leaves|garlic|ginger/.test(n);
  const pantry = ["Bendakaya (okra)", "onion", "tomato", "rice", "curry leaves", "mustard seeds", "red chilli powder"];
  const top = topPicks(pantry, { cuisines: ["telugu"], isVegetable: isVeg, limit: 5 });
  assert.ok(top.length > 0 && top.length <= 5);
  for (const x of top) assert.ok(inCuisines(x.recipe, ["telugu"]), x.recipe.title + " " + x.recipe.cuisine);
  assert.ok(top[0].veg > 0, top[0].recipe.title + " should use the okra");
  // Ranked by score, and nothing in it needs yesterday's leftovers.
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
  assert.ok(!top.some((x) => x.recipe.leftover));
  // Nothing in the picked cuisines fits: the other cuisines are used rather than showing nothing.
  const other = topPicks(["sushi rice", "nori", "cucumber"], { cuisines: ["telugu"], maxMissing: 6 });
  assert.ok(other.length > 0 && other.some((x) => !inCuisines(x.recipe, ["telugu"])));
  assert.deepEqual(topPicks([], { cuisines: ["telugu"] }), []);
});

test("BOOK-14 leftovers: yesterday's curry suggests a makeover, and the leftover never goes on the shopping list", () => {
  const byTitle = (t) => LIBRARY.find((r) => r.title.startsWith(t));
  assert.equal(leftoverKind(byTitle("Kodi kura")), "chicken curry");
  assert.equal(leftoverKind(byTitle("Hyderabadi chicken curry")), "chicken curry");
  assert.equal(leftoverKind(byTitle("Mild butter chicken")), "chicken curry");
  assert.equal(leftoverKind(byTitle("Tomato pappu")), "dal");
  assert.equal(leftoverKind(byTitle("Palak paneer with roti")), "paneer curry");
  assert.equal(leftoverKind(byTitle("Chicken tinga tacos")), "");
  assert.equal(leftoverKind(byTitle("Sambar rice")), "");
  assert.equal(leftoverKind({ title: "Chicken curry" }), "chicken curry");
  assert.equal(leftoverKind({ title: "Rajma chawal" }), "beans curry");
  const ideas = leftoverRecipesFor("chicken curry");
  assert.ok(ideas.some((r) => r.title === "Roti chicken curry quesadilla" && r.forWhom === "kid"));
  assert.ok(ideas.some((r) => r.forWhom === "family"));
  assert.ok(leftoverRecipesFor("vegetable curry").some((r) => r.leftover.includes("any curry")));
  assert.deepEqual(leftoverRecipesFor(""), []);
  const q = byTitle("Roti chicken curry quesadilla");
  assert.deepEqual(q.leftover, ["chicken curry"]);
  assert.deepEqual(missingForRecipe(q, ["roti"]).sort(), ["cheese", "butter", "coriander leaves"].map(normName).sort());
  assert.ok(!missingFromPantry(q, []).some((i) => /leftover/.test(i.name)));
  // Makeovers are never offered as plain "ready to cook" recipes: they need the leftover.
  assert.ok(!readyToCook(["roti", "cheese", "butter", "coriander leaves"], { maxMissing: 0, limit: 100 }).some((x) => x.recipe.leftover));
  for (const r of LIBRARY.filter((x) => x.leftover)) assert.ok(r.forWhom !== "baby", r.title + ": leftovers are not for the baby");
});

test("BOOK-15 the freezer counts as in the kitchen, after fresh vegetables", () => {
  const cold = freezerSet([{ name: "Frozen peas", qty: 2 }, { name: "Parathas", qty: 4 }, { name: "Idli batter", qty: 0 }, "sweet corn"]);
  assert.ok(cold.has("peas") && cold.has(normName("paratha")) && cold.has("sweet corn"));
  assert.ok(!cold.has("idli batter"), "none left");
  const isVeg = (n) => aisleFor(n) === "Vegetables";
  const pantry = ["rice", "onion", "tomato", "cumin seeds", "ghee"];
  const withFreezer = topPicks(pantry, { frozen: [{ name: "Frozen peas", qty: 1 }], isVegetable: isVeg, limit: 15, maxMissing: 3 });
  const peas = withFreezer.find((x) => x.fromFreezer.includes("peas"));
  assert.ok(peas, "a recipe uses the frozen peas");
  // Frozen peas are not on the shopping list for a recipe that uses them.
  const ready = readyToCook(pantry, { frozen: ["peas"], maxMissing: 3, limit: 200 });
  for (const x of ready) assert.ok(!x.missing.includes("peas"));
  // The same peas fresh rank at least as high as frozen ones.
  const fresh = topPicks([...pantry, "peas"], { isVegetable: isVeg, limit: 200, maxMissing: 3 }).find((x) => x.recipe.id === peas.recipe.id);
  assert.ok(fresh.score >= peas.score);
});
