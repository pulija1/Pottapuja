// Round 2: regression tests for the fixes in 9277ee0, plus new edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecipe, checkForAudience } from "../public/shared/safety.js";
import { aisleFor, mergeItems, formatQty } from "../public/shared/shopping.js";
import { occurrences } from "../public/shared/dates.js";

const baby = (ings, steps = [], title = "Test dish") => checkRecipe({ title, forWhom: "baby", texture: "mashed",
  ingredients: ings.map((name) => ({ name, quantity: 1, unit: "tsp" })), steps }, { age: "baby" });

test("AGE-14 nut powder made at home is allowed for the baby", () => {
  assert.equal(baby(["cashews ground to a fine paste"]).safe, true);
  assert.equal(baby(["rice"], ["Soak almonds overnight, peel and grind to a fine powder."]).safe, true);
});

test("AGE-15 nut cooking oils and 'nut-free' are not choking hazards", () => {
  for (const x of ["groundnut oil", "peanut oil", "nut-free"]) assert.equal(baby([x]).safe, true, x);
});

test("AGE-16 whole nuts next to a ground form are still caught", () => {
  assert.equal(baby(["peanut butter and roasted peanuts"]).safe, false);
  assert.equal(baby(["almond milk", "whole almonds"]).safe, false);
});

test("AGE-17 the word 'then' in steps is not read as honey", () => {
  assert.equal(baby(["rice"], ["Cook, then add ghee.", "Then mash well.", "Steam then serve."]).safe, true);
});

test("AGE-19 -free only cancels its own word", () => {
  assert.equal(baby(["sugar-free cereal", "sugar"]).safe, false);
  assert.equal(baby(["salt-free butter"], ["Add salt."]).safe, false);
});

test("SHOP-11 aisle fixes hold", () => {
  const cases = { "chilli powder": "Spices & tempering", "cashews": "Oil, nuts & dry fruits", "small onions": "Vegetables",
    "baby potatoes": "Vegetables", "baby corn": "Vegetables", "pearl millet": "Rice, dals & flours", "baby wipes": "Baby care",
    "lady finger": "Vegetables", "bhindi": "Vegetables" };
  for (const [n, a] of Object.entries(cases)) assert.equal(aisleFor(n), a, n);
});

test("SHOP-12 ml rolls up to litres", () => {
  assert.equal(formatQty(mergeItems([{ name: "oil", quantity: 500, unit: "ml" }, { name: "oil", quantity: 700, unit: "ml" }])[0]), "1.2 l");
});

test("REM-11 weekday repeat starting on a weekend skips to Monday", () => {
  assert.deepEqual(occurrences({ date: "2026-10-24", repeat: "weekdays" }, "2026-10-24", "2026-10-27"), ["2026-10-26", "2026-10-27"]);
});

test("REM-12 weekly repeat years later still lands on the right weekday", () => {
  assert.deepEqual(occurrences({ date: "2026-01-01", repeat: "weekly" }, "2029-01-01", "2029-01-14"), ["2029-01-04", "2029-01-11"]);
});

test("AGE-21 'whole' nuts are never treated as ground, even with a blend word later in the sentence", () => {
  assert.equal(baby(["rice"], ["Add whole cashews on top, then blend the rice."]).safe, false);
  assert.equal(baby(["rice"], ["Top with whole almonds and serve with a smooth paste of dal."]).safe, false);
});

test("AGE-22 a garnish of nuts after the blending step is still caught", () => {
  assert.equal(baby(["rice"], ["Blend the khichdi smooth, then sprinkle chopped cashews on top."]).safe, false);
});

test("AGE-23 a grinding word about something else in the same clause does not make the nut safe", () => {
  for (const s of ["Add cashews, and blend the rice.", "Add a few cashews to the bowl and mix with the paste.", "Add almonds whole and blend the dal."]) {
    assert.equal(baby(["rice"], [s]).safe, false, s);
  }
});

test("AGE-24 grinding that is clearly about the nut is allowed", () => {
  for (const s of ["Soak cashews and blend to a smooth paste.", "Grind almonds to a fine powder.", "Blend the soaked cashews until smooth."]) {
    assert.equal(baby(["rice"], [s]).safe, true, s);
  }
});
