// Age-safety rules (test plan section AGE). Each test name starts with its plan ID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecipe, checkForAudience } from "../public/shared/safety.js";
import { LIBRARY } from "../public/shared/recipes.js";

const recipe = (forWhom, ingredients, steps = [], extra = {}) => ({
  title: "Test dish", forWhom, mealType: "lunch", texture: forWhom === "baby" ? "mashed" : "",
  ingredients: ingredients.map((name) => ({ name, quantity: 1, unit: "tsp" })), steps, notes: "", ...extra,
});
const babySafe = (ings, steps, extra) => checkRecipe(recipe("baby", ings, steps, extra), { age: "baby" }).safe;
const rules = (res) => [...res.errors, ...res.warnings].map((x) => x.rule);

test("AGE-01 honey in any position is blocked for the baby", () => {
  assert.equal(babySafe(["rice", "honey"]), false);
  assert.equal(babySafe(["rice"], ["Drizzle a little honey on top."]), false);
  assert.equal(checkRecipe({ ...recipe("baby", ["rice"]), title: "Honey ragi porridge" }, { age: "baby" }).safe, false);
});

test("AGE-02 whole nuts blocked for the baby, ground nut powder allowed", () => {
  for (const n of ["cashews", "peanuts", "almonds", "badam", "kaju", "groundnuts"]) assert.equal(babySafe(["rice", n]), false, n);
  assert.equal(babySafe(["almond powder"]), true);
  assert.equal(babySafe(["peanut butter"]), true);
});

test("AGE-02b whole cashews in milk payasam are still blocked (milk is not a ground form of the nut)", () => {
  assert.equal(babySafe(["rice", "milk"], ["Fry cashews in ghee and add to the payasam made with milk."]), false);
  assert.equal(babySafe(["whole cashews and milk"]), false);
});

test("AGE-03 salt, sugar and jaggery blocked for the baby", () => {
  for (const x of ["salt", "sugar", "jaggery", "bellam", "rock salt"]) assert.equal(babySafe(["rice", x]), false, x);
  assert.equal(babySafe(["rice"], ["Season with salt to taste."]), false);
});

test("AGE-03b a negation earlier in the sentence does not hide salt added later", () => {
  assert.equal(babySafe(["rice"], ["Do not add water now, then add salt and mash."]), false);
});

test("AGE-04 choking hazards blocked for the baby", () => {
  for (const x of ["grapes", "popcorn", "whole chana", "raw carrot", "raisins", "murukku"]) assert.equal(babySafe(["rice", x]), false, x);
});

test("AGE-05 cow's milk as a drink gives a warning, not an error", () => {
  const r = checkRecipe(recipe("baby", ["cow's milk"]), { age: "baby" });
  assert.equal(r.safe, true);
  assert.ok(rules(r).includes("cow-milk-drink"));
});

test("AGE-06 chilli and spice give a warning for the baby", () => {
  const r = checkRecipe(recipe("baby", ["rice", "green chilli"]), { age: "baby" });
  assert.ok(rules(r).includes("spicy"));
});

test("AGE-07 honey is caught in other cases and South Indian names", () => {
  assert.equal(babySafe(["HONEY"]), false);
  assert.equal(babySafe(["Honey-glazed carrots"]), false);
  for (const name of ["thene", "then (honey)", "madhu", "jenu"]) assert.equal(babySafe([name]), false, name);
});

test("AGE-08 everyday baby food is not flagged", () => {
  assert.equal(babySafe(["ragi flour", "water", "banana"], ["Cook until thick."]), true);
  assert.equal(babySafe(["rice", "moong dal", "ghee", "turmeric"], ["Pressure cook and mash. No salt."]), true);
  assert.equal(babySafe(["rice", "coconut", "nutmeg"]), true);
  assert.equal(babySafe(["rice"], ["Add 1 teaspoon of ghee"]), true);
  assert.equal(babySafe(["rice"], ["Steam until soft."]), true);
});

test("AGE-08b 'salt-free' and 'sugar-free' do not count as adding salt or sugar", () => {
  assert.equal(babySafe(["salt-free homemade paneer"]), true);
  assert.equal(babySafe(["sugar-free ragi malt"]), true);
});

test("AGE-09 honey is allowed for the 4-year-old", () => {
  assert.equal(checkRecipe(recipe("kid", ["honey", "ragi flour"]), { age: "kid" }).safe, true);
});

test("AGE-10 whole nuts and whole grapes warn for the 4-year-old", () => {
  assert.ok(rules(checkRecipe(recipe("kid", ["cashews"]), { age: "kid" })).includes("whole-nuts"));
  assert.ok(rules(checkRecipe(recipe("kid", ["whole grapes"]), { age: "kid" })).includes("whole-grapes"));
});

test("AGE-11 with the school nut-free setting on, nuts in the lunchbox and snack box are blocked", () => {
  const box = (ing, mealType = "lunchbox") => checkForAudience({ ...recipe("kid", [ing]), mealType }, { schoolNutFree: true });
  assert.equal(box("peanuts").safe, false);
  assert.equal(box("peanut powder").safe, false);
  assert.equal(box("cashews", "snack").safe, false);
  assert.equal(box("coconut").safe, true);
});

test("AGE-11b with the setting off (default), nuts in the lunchbox are allowed, still with the whole-nut warning", () => {
  const r = checkForAudience({ ...recipe("kid", ["cashews"]), mealType: "lunchbox" });
  assert.equal(r.safe, true);
  assert.ok(r.warnings.some((w) => w.rule === "whole-nuts"));
});

test("AGE-12 a family recipe gets the plain baby portion warning", () => {
  const r = checkForAudience(recipe("family", ["rice", "salt"]));
  assert.equal(r.safe, true);
  assert.ok(r.warnings.some((w) => w.rule === "baby-portion"));
});

test("AGE-13 bad input does not throw", () => {
  for (const bad of [null, undefined, 5, "x", {}, { ingredients: "honey" }, { ingredients: [null, 3, { name: null }] }]) {
    assert.doesNotThrow(() => checkRecipe(bad, { age: "baby" }));
    assert.doesNotThrow(() => checkForAudience(bad));
  }
  assert.equal(checkRecipe(null).safe, false);
});

test("OFF-05 every built-in recipe passes the safety check for its audience", () => {
  for (const r of LIBRARY) assert.equal(checkForAudience(r).safe, true, `${r.id}: ${JSON.stringify(checkForAudience(r).errors)}`);
});

test("OFF-05b every built-in baby recipe has a soft texture and no warnings about texture", () => {
  for (const r of LIBRARY.filter((x) => x.forWhom === "baby")) {
    const res = checkRecipe(r, { age: "baby" });
    assert.ok(!rules(res).includes("texture"), r.id);
  }
});
