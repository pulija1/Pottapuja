// The Markdown recipe book (recipes/*.md): parsing, safety of every recipe, and pantry matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIngredient, parseRecipeMarkdown, combineBooks, nutritionTags, recipeToMarkdown, RECIPE_FILES } from "../public/shared/recipe-book.js";
import { LIBRARY, RECIPE_BOOK_STATUS, readyToCook, missingForRecipe, suggestFromLibrary, cookByVegetables, dishType } from "../public/shared/recipes.js";
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

test("COOK-01 a time-short cook picks one Telugu vegetable and gets a quick fry and a quick curry", () => {
  const both = ["vankaya", "bendakaya", "sorakaya", "beerakaya", "dondakaya", "potlakaya", "kakarakaya", "munagakaya", "aratikaya",
    "chamadumpa", "gummadikaya", "bangaladumpa", "chilagada dumpa", "chikkudukaya", "goruchikkudu", "mullangi", "kandagadda",
    "cabbage", "cauliflower", "capsicum", "pachi batani", "palakura", "thotakura"];
  const curryOnly = ["gongura", "menthikura", "mamidikaya", "dosakaya", "tamata"];
  for (const veg of [...both, ...curryOnly]) {
    const { fry, curry } = cookByVegetables([veg], { maxMinutes: 20, onlyQuick: true });
    assert.ok(curry.length, veg + ": no quick curry");
    if (both.includes(veg)) assert.ok(fry.length, veg + ": no quick fry");
    for (const x of [...fry, ...curry]) assert.ok(x.recipe.prepMinutes <= 20, x.recipe.title);
  }
  // Every way of writing lady's finger finds the okra recipes.
  for (const name of ["Ladies finger", "lady's finger", "lady finger", "bhindi", "Bendakaya (okra)", "okra"]) {
    assert.equal(normName(name), "okra", name);
    assert.ok(cookByVegetables([name]).fry.some((x) => /bendakaya/i.test(x.recipe.title)), name);
  }
  assert.equal(normName("brinjals"), "brinjal");
  assert.equal(normName("ridge gourds"), "ridge gourd");
  assert.equal(normName("radishes"), "radish");
});

test("COOK-02 picking several vegetables puts the recipes that use all of them first", () => {
  for (const [vegs, dish] of [[["bendakaya", "bangaladumpa"], "fry"], [["vankaya", "bangaladumpa"], "curry"], [["vankaya", "bangaladumpa"], "fry"],
    [["cauliflower", "pachi batani"], "curry"], [["cabbage", "pachi batani"], "fry"], [["capsicum", "bangaladumpa"], "fry"], [["bangaladumpa", "pachi batani"], "curry"]]) {
    const list = cookByVegetables(vegs, { maxMinutes: 20 })[dish];
    assert.ok(list.length && list[0].all, vegs.join("+") + " " + dish + ": " + list[0]?.recipe.title);
    const firstPartial = list.findIndex((x) => !x.all);
    assert.ok(firstPartial === -1 || list.slice(firstPartial).every((x) => !x.all), "all-match recipes come first");
  }
  // A vegetable with no fry still shows the curries, and recipes with only one of the picks are listed after.
  const mixed = cookByVegetables(["gongura", "bendakaya"]);
  assert.ok(mixed.curry.some((x) => /gongura/i.test(x.recipe.title)) && mixed.fry.some((x) => /bendakaya/i.test(x.recipe.title)));
  assert.deepEqual(cookByVegetables([]), { fry: [], curry: [] });
});

test("COOK-03 every Telugu recipe is a fry or a curry, and quick ones fit in 20 minutes", () => {
  const telugu = LIBRARY.filter((r) => r.file === "telugu-curries.md");
  for (const r of telugu) assert.ok(["fry", "curry"].includes(dishType(r)), r.title + ": " + dishType(r));
  const quick = telugu.filter((r) => /^Quick/.test(r.section));
  assert.ok(quick.length >= 40, "quick recipes: " + quick.length);
  for (const r of quick) assert.ok(r.prepMinutes <= 20 && r.dish, r.title);
});
