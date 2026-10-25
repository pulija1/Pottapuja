// Family breakfasts, busy weekday mornings, the baby's morning fruit, and the kitchen's groups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY, suggestFromLibrary } from "../public/shared/recipes.js";
import { parseRecipeMarkdown, recipeToMarkdown } from "../public/shared/recipe-book.js";
import { checkForAudience, isNutIngredient } from "../public/shared/safety.js";
import { normName } from "../public/shared/shopping.js";
import { kitchenGroupFor, groupKitchen, babyFruitFor, recipeHasFruit, BABY_FRUITS, isFruit } from "../public/shared/kitchen.js";

const PANTRY = ["rice", "egg", "bread", "banana", "peanut butter", "avocado", "milk"];

test("BRK-01 Whole family + Breakfast finds recipes (it used to find none), and so does every other meal", () => {
  for (const mealType of ["breakfast", "lunch", "lunchbox", "snack", "dinner", ""]) {
    const list = suggestFromLibrary(PANTRY, { forWhom: "family", mealType });
    assert.ok(list.length > 0, `family ${mealType || "any"}`);
    assert.ok(list.every((r) => ["family", "kid"].includes(r.forWhom)), mealType);
  }
  // With an empty kitchen too.
  assert.ok(suggestFromLibrary([], { forWhom: "family", mealType: "breakfast" }).length > 0);
  // The family's own breakfasts come before the 4-year-old's.
  assert.equal(suggestFromLibrary([], { forWhom: "family", mealType: "breakfast" })[0].forWhom, "family");
});

test("BRK-02 the book has family breakfasts made the night before and no-cook ones", () => {
  const family = LIBRARY.filter((r) => r.forWhom === "family" && r.mealType === "breakfast");
  assert.ok(family.filter((r) => r.busyMorning === "make-ahead").length >= 4, "make-ahead");
  assert.ok(family.filter((r) => r.busyMorning === "no-cook").length >= 3, "no-cook");
  for (const t of ["Overnight oats with banana and cinnamon", "Peanut butter banana toast", "Avocado toast with lemon"]) assert.ok(family.some((r) => r.title === t), t);
  assert.ok(LIBRARY.some((r) => r.forWhom === "kid" && r.busyMorning && r.tags.includes("egg")), "a make-ahead egg breakfast for the 4-year-old");
});

test("BRK-03 busy morning puts make-ahead and no-cook breakfasts first, for everyone", () => {
  for (const forWhom of ["family", "kid", "baby", "both"]) {
    const list = suggestFromLibrary(["egg", "rava", "onion", "tomato"], { forWhom, mealType: "breakfast", busyMorning: true, limit: 4 });
    assert.ok(list.length && list.every((r) => r.busyMorning), `${forWhom}: ${list.map((r) => r.title)}`);
  }
  // Off (the weekend), a cooked breakfast can come first again.
  const weekend = suggestFromLibrary(["egg", "rava", "onion", "tomato", "carrot", "mustard seeds", "urad dal", "curry leaves", "ghee"], { forWhom: "kid", mealType: "breakfast", limit: 3 });
  assert.ok(weekend.some((r) => !r.busyMorning), weekend.map((r) => r.title).join());
});

test("BRK-04 peanut butter is fine at breakfast, but never in a nut-free lunchbox or snack box", () => {
  const pb = LIBRARY.filter((r) => r.mealType === "breakfast" && r.busyMorning && r.ingredients.some((i) => isNutIngredient(i.name)));
  assert.ok(pb.length >= 2);
  for (const r of pb) assert.ok(checkForAudience(r, { schoolNutFree: true }).safe, `${r.title} is a breakfast at home`);
  for (const mealType of ["lunchbox", "snack"]) {
    for (const forWhom of ["kid", "family"]) {
      const list = suggestFromLibrary(PANTRY, { forWhom, mealType, schoolNutFree: true, limit: 40 });
      const nuts = list.filter((r) => r.forWhom === "kid" && !checkForAudience(r, { schoolNutFree: true }).safe);
      assert.deepEqual(nuts.map((r) => r.title), [], `${forWhom} ${mealType}`);
    }
  }
});

test("BRK-05 the baby's busy-morning breakfasts all have a fruit, and the fruit ones come first", () => {
  const baby = LIBRARY.filter((r) => r.forWhom === "baby" && r.mealType === "breakfast" && r.busyMorning);
  assert.ok(baby.length >= 4);
  for (const r of baby) assert.ok(recipeHasFruit(r), r.title);
  const top = suggestFromLibrary([], { forWhom: "baby", mealType: "breakfast", limit: 3 });
  assert.ok(top.every((r) => r.forWhom !== "baby" || recipeHasFruit(r)), top.map((r) => r.title).join());
});

test("BRK-06 a fruit for the baby's morning: one from the kitchen, otherwise banana; never pomegranate seeds", () => {
  assert.equal(babyFruitFor([]).name, "banana");
  assert.equal(babyFruitFor([]).inKitchen, false);
  const f = babyFruitFor(["rice", "Boppayi (papaya)"]);
  assert.equal(f.name, "papaya");
  assert.ok(f.inKitchen);
  assert.match(f.how, /mashed/);
  assert.equal(babyFruitFor(["danimma (pomegranate)", "jama pandu (guava)"]).name, "banana", "not safe for the baby, so banana");
  const two = new Set([0, 1].map((seed) => babyFruitFor(["mango", "pear"], seed).name));
  assert.deepEqual([...two].sort(), ["mango", "pear"], "rotates with the seed");
  for (const b of BABY_FRUITS) assert.ok(isFruit(b.name), b.name);
});

test("BRK-07 Telugu fruit names match the English ones", () => {
  assert.equal(normName("Arati pandu (banana)"), "banana");
  assert.equal(normName("Sapota (chikoo)"), "chikoo");
  assert.equal(normName("sapota"), "chikoo");
  assert.equal(normName("jama pandu"), "guava");
  assert.equal(normName("Danimma"), "pomegranate");
  assert.equal(normName("Draksha (grapes)"), "grapes");
});

test("BRK-08 the kitchen sorts into vegetables, fruits, dips, bread, snacks and the rest", () => {
  const want = {
    vegetables: ["Vankaya (brinjal)", "Palakura (spinach)", "tomato", "Mamidikaya (raw mango)", "raw banana"],
    fruits: ["Arati pandu (banana)", "apple", "avocado", "Strawberries", "Sapota (chikoo)", "mango"],
    dips: ["peanut butter", "hummus", "coconut chutney", "mild salsa", "fruit jam", "cream cheese"],
    bread: ["bread", "whole wheat bread", "pita bread", "flour tortilla", "chapatis", "pav bun", "thepla"],
    snacks: ["biscuits", "granola", "makhana", "cornflakes", "crackers"],
    dairy: ["milk", "curd", "paneer", "egg", "cheddar cheese", "butter"],
    grains: ["rice", "toor dal", "rava", "idli/dosa batter", "rolled oats", "atta"],
    nuts: ["almond powder", "cashews", "coconut"],
    spices: ["turmeric", "mustard seeds", "jeera"],
  };
  for (const [group, names] of Object.entries(want)) for (const n of names) assert.equal(kitchenGroupFor(n), group, n);
  const groups = groupKitchen(["rice", "apple", "peanut butter", "bread", "okra", "biscuits"]);
  assert.deepEqual(groups.map((g) => g.id), ["vegetables", "fruits", "dips", "bread", "snacks", "grains"]);
  assert.deepEqual(groups[0].items, ["okra"]);
});

test("BRK-09 the Busy morning line is read and written back", () => {
  const { recipes, problems } = parseRecipeMarkdown(`
### Night oats

- **For:** family
- **Meal:** breakfast
- **Busy morning:** make ahead

**Ingredients**

- 1 cup rolled oats

**Steps**

1. Soak overnight.

### Bread and jam

- **For:** kid
- **Meal:** breakfast
- **Busy morning:** No-cook

**Ingredients**

- 1 slice bread

**Steps**

1. Spread.
`);
  assert.deepEqual(problems, []);
  assert.deepEqual(recipes.map((r) => r.busyMorning), ["make-ahead", "no-cook"]);
  const again = parseRecipeMarkdown(recipeToMarkdown(recipes[0])).recipes[0];
  assert.equal(again.busyMorning, "make-ahead");
});
