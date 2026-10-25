import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY } from "../public/shared/recipes.js";
import { parseRecipeMarkdown } from "../public/shared/recipe-book.js";
import { estimateNutrition, findFood, ingredientGrams, dailyShare, recipeServings } from "../public/shared/nutrition.js";

test("every ingredient in the recipe book is in the nutrition table", () => {
  const unknown = [];
  for (const r of LIBRARY) {
    const { missing } = estimateNutrition(r);
    if (missing.length) unknown.push(`${r.title}: ${missing.join(", ")}`);
  }
  assert.deepEqual(unknown, []);
});

// Family dishes can be a side served with rice (a vepudu with no rice in it), so their floor is low.
test("one serving stays in a sensible range for who it is for", () => {
  const limits = { baby: [20, 260], kid: [40, 520], family: [60, 750] };
  for (const r of LIBRARY) {
    const { perServing } = estimateNutrition(r);
    const [lo, hi] = limits[r.forWhom];
    assert.ok(perServing.kcal >= lo && perServing.kcal <= hi, `${r.title}: ${perServing.kcal} kcal per serving`);
  }
});

test("names that look alike match the right food", () => {
  const re = (name, note) => findFood({ name, note })?.re.source || "";
  assert.match(re("sona masoori rice"), /rice/);
  assert.match(re("chana masala powder"), /masala/);
  assert.match(re("coconut milk"), /coconut milk/);
  assert.match(re("peanut butter"), /peanut butter/);
  assert.match(re("idli podi"), /podi/);
  assert.match(re("eggplant"), /eggplant/);
  assert.equal(findFood({ name: "rice", note: "cooked" }).v[0], 130);
  assert.equal(findFood({ name: "rice" }).v[0], 360);
  assert.ok(findFood({ name: "chickpeas", note: "soaked overnight" }).v[0] > 300);
});

test("amounts turn into grams", () => {
  assert.equal(ingredientGrams({ name: "egg", quantity: 2, unit: "pcs" }), 100);
  assert.equal(ingredientGrams({ name: "rice", quantity: 1, unit: "cup" }), 185);
  assert.equal(ingredientGrams({ name: "ghee", quantity: 3, unit: "tsp" }), 205 / 16);
  assert.equal(ingredientGrams({ name: "paneer", quantity: 100, unit: "g" }), 100);
  assert.equal(ingredientGrams({ name: "salt", quantity: null, unit: "" }), null);
});

test("a recipe's numbers are for one serving and its share of the child's day", () => {
  const { recipes } = parseRecipeMarkdown(`### Two egg scramble
- **For:** kid
- **Meal:** breakfast
- **Serves:** 2 (1 egg each)

**Ingredients**

- 2 eggs
- Salt, to taste

**Steps**

1. Scramble.
`);
  const r = recipes[0];
  assert.equal(r.servings, 2);
  assert.equal(r.servingNote, "1 egg each");
  const { servings, perServing, missing } = estimateNutrition(r);
  assert.equal(servings, 2);
  assert.deepEqual(missing, []);
  assert.equal(perServing.kcal, 72);
  assert.equal(perServing.protein, 6.3);
  assert.equal(perServing.iron, 0.9);
  assert.equal(dailyShare(perServing, "kid").protein, 33);
  assert.deepEqual(dailyShare(perServing, "family"), {});
  assert.equal(recipeServings({ forWhom: "family" }), 4);
  assert.equal(recipeServings({ forWhom: "baby" }), 1);
});

test("ingredients the table doesn't know are listed, not guessed", () => {
  const { missing } = estimateNutrition({ forWhom: "kid", ingredients: [{ name: "dragon fruit", quantity: 1, unit: "pcs" }, { name: "egg", quantity: 1, unit: "pcs" }] });
  assert.deepEqual(missing, ["dragon fruit"]);
});
