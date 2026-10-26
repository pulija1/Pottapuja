// Recipes by age (AGE): the book's sections for the baby, the 4-year-old and the family, and the
// recipes marked to use often, which the meal planner picks first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY, suggestFromLibrary } from "../public/shared/recipes.js";
import { AGE_SECTIONS, SECTION_MEALS, regularsFor, isRegular, toggleRegular, ageSection, regularsFirst } from "../public/shared/regulars.js";

test("AGE-01 each section holds only that person's recipes, by meal, without dips or leftover makeovers", () => {
  for (const who of AGE_SECTIONS) {
    const byMeal = ageSection(LIBRARY, who, {});
    assert.deepEqual(Object.keys(byMeal), SECTION_MEALS[who]);
    const all = Object.values(byMeal).flat();
    assert.ok(all.length > 10, who);
    for (const [meal, list] of Object.entries(byMeal)) for (const r of list) {
      assert.equal(r.forWhom, who);
      assert.equal(r.mealType, meal);
      assert.ok(!r.leftover);
    }
  }
  assert.ok(ageSection(LIBRARY, "baby", {}).lunch.length > 0);
  assert.ok(ageSection(LIBRARY, "kid", {}).lunchbox.length > 0);
});

test("AGE-02 marking a recipe to use often puts it first in its section and can be undone", () => {
  const last = ageSection(LIBRARY, "baby", {}).dinner.at(-1);
  let settings = { regulars: toggleRegular({}, "baby", last.id) };
  assert.ok(isRegular(settings, "baby", last.id));
  assert.ok(!isRegular(settings, "kid", last.id));
  assert.equal(ageSection(LIBRARY, "baby", settings).dinner[0].id, last.id);
  settings = { regulars: toggleRegular(settings, "baby", last.id) };
  assert.deepEqual(regularsFor(settings, "baby"), []);
});

test("AGE-03 hand-edited or synced settings are cleaned up", () => {
  assert.deepEqual(regularsFor({ regulars: { kid: ["a", "a", 3, "", null, "b"] } }, "kid"), ["a", "b"]);
  assert.deepEqual(regularsFor({ regulars: "x" }, "kid"), []);
  assert.deepEqual(regularsFor(null, "baby"), []);
  assert.deepEqual(toggleRegular({}, "nobody", "a"), { baby: [], kid: [], family: [] });
});

test("AGE-04 regularsFirst moves the ones used often to the front and keeps the rest in order", () => {
  const list = ["a", "b", "c", "d"].map((id) => ({ id }));
  assert.deepEqual(regularsFirst(list, ["c"]).map((r) => r.id), ["c", "a", "b", "d"]);
  assert.equal(regularsFirst(list, []), list);
});

test("AGE-05 the planner's suggestions lift a recipe used often above a better kitchen match", () => {
  const pantry = ["rice", "moong dal", "carrot", "banana", "ragi flour", "curd", "ghee"];
  const before = suggestFromLibrary(pantry, { forWhom: "baby", mealType: "dinner", limit: 40 }).filter((r) => r.forWhom === "baby");
  const pick = before.at(-1);
  const after = suggestFromLibrary(pantry, { forWhom: "baby", mealType: "dinner", limit: 40, regulars: [pick.id] }).filter((r) => r.forWhom === "baby");
  assert.notEqual(before[0].id, pick.id);
  assert.equal(after[0].id, pick.id);
});
