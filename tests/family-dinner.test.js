// The family dinner ideas: from the kitchen, never leftovers or the freezer alone, and always at
// least five different vegetable curries to choose from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { familyDinnerIdeas, withVegCurries, isVegCurry, isMainVegetable, mainVegOf, oneEachVeg, VEG_CURRY_MIN, DINNER_POOL, LIBRARY } from "../public/shared/recipes.js";
import { normName } from "../public/shared/shopping.js";

// The app's starting kitchen, plus the vegetables of a usual shop.
const STARTER = ["rice", "moong dal", "toor dal", "ragi flour", "rava", "curd", "ghee", "carrot", "banana", "tomato", "onion", "idli/dosa batter", "curry leaves", "mustard seeds", "turmeric"];
const SHOPPED = [...STARTER, "okra", "brinjal", "potato", "bottle gourd", "spinach", "cauliflower"];
const FREEZER = [{ name: "Frozen peas", qty: 1 }, { name: "chicken", qty: 2 }, { name: "Frozen drumsticks", qty: 1 }];

const names = (r) => r.ingredients.map((i) => normName(i.name));
const kitchenVeg = (r, pantry) => names(r).filter((n) => isMainVegetable(n) && pantry.map(normName).includes(n));

test("FAM-01 family dinner ideas use a fresh vegetable or protein from the kitchen", () => {
  const ideas = familyDinnerIdeas(SHOPPED, { frozen: FREEZER });
  assert.ok(ideas.length >= DINNER_POOL);
  const pool = withVegCurries(ideas);
  for (const r of pool) {
    assert.equal(r.forWhom, "family");
    assert.equal(r.mealType, "dinner");
    assert.ok(kitchenVeg(r, SHOPPED).length, `${r.title} uses a vegetable from the kitchen`);
  }
});

test("FAM-02 no leftover makeover and nothing that needs yesterday's curry", () => {
  for (const pantry of [STARTER, SHOPPED, [...SHOPPED, "chicken", "roti", "egg"]]) {
    for (const r of familyDinnerIdeas(pantry, { frozen: FREEZER })) {
      assert.ok(!r.leftover, `${r.title} is not a leftover makeover`);
      assert.ok(!names(r).some((n) => /^leftover\b/.test(n)), `${r.title} needs no leftovers`);
    }
  }
});

test("FAM-03 nothing whose main thing is only in the freezer", () => {
  // Chicken and drumsticks are in the freezer, not the kitchen: no chicken curry, no drumstick curry.
  const ideas = familyDinnerIdeas(SHOPPED, { frozen: FREEZER });
  assert.ok(!ideas.some((r) => /chicken|kodi/i.test(r.title)), "no chicken from the freezer");
  assert.ok(!ideas.some((r) => names(r).includes("drumstick")), "no drumstick from the freezer");
  // With chicken fresh in the kitchen, a chicken curry is an idea again.
  const spices = ["ginger garlic paste", "red chilli powder", "coriander powder", "garam masala"];
  assert.ok(familyDinnerIdeas([...SHOPPED, ...spices, "chicken"], { frozen: FREEZER }).some((r) => /chicken|kodi/i.test(r.title)));
  // The freezer can still give a side thing: potato from the kitchen with frozen peas.
  assert.ok(familyDinnerIdeas(SHOPPED, { frozen: FREEZER }).some((r) => /aloo batani/i.test(r.title)));
});

test("FAM-04 at least five different vegetable curries, from the kitchen ones first", () => {
  for (const pantry of [STARTER, SHOPPED]) {
    const pool = withVegCurries(familyDinnerIdeas(pantry, { frozen: FREEZER }));
    const veg = pool.filter(isVegCurry);
    assert.ok(new Set(veg.map((r) => r.id)).size >= VEG_CURRY_MIN, `${veg.length} vegetable curries for ${pantry.length} items`);
    assert.equal(new Set(pool.map((r) => r.title)).size, pool.length, "all different");
  }
  // With a full shop, all five come from the kitchen.
  const shopped = withVegCurries(familyDinnerIdeas(SHOPPED, { frozen: FREEZER })).filter(isVegCurry);
  for (const r of shopped) assert.ok(kitchenVeg(r, SHOPPED).length, `${r.title} is from the kitchen`);
});

test("FAM-05 food running out comes earlier", () => {
  const gourd = (list) => list.findIndex((r) => names(r).includes("bottle gourd"));
  const before = gourd(familyDinnerIdeas(SHOPPED));
  const after = gourd(familyDinnerIdeas(SHOPPED, { useSoon: new Map([["bottle gourd", 1]]) }));
  assert.ok(after >= 0 && after < before, `bottle gourd moves up from ${before} to ${after}`);
});

test("FAM-06 vegetable curries: a curry with a vegetable and no meat or egg", () => {
  const byTitle = (t) => LIBRARY.find((r) => r.title.startsWith(t));
  assert.ok(isVegCurry(byTitle("Bendakaya tomato kura")));
  assert.ok(isVegCurry(byTitle("Palakura pappu")));
  assert.ok(!isVegCurry(byTitle("Kodi kura")), "chicken");
  assert.ok(!isVegCurry(byTitle("Kodiguddu pulusu")), "egg");
  assert.ok(!isVegCurry(byTitle("Bendakaya vepudu") || byTitle("Quick bendakaya vepudu")), "a fry");
  assert.ok(LIBRARY.filter((r) => r.forWhom === "family" && isVegCurry(r)).length >= 20);
});

test("FAM-07 the pool keeps at least five vegetable curries, ahead of the other dinners", () => {
  const ideas = familyDinnerIdeas(SHOPPED);
  const pool = withVegCurries(ideas);
  assert.ok(pool.length >= VEG_CURRY_MIN && pool.length <= DINNER_POOL);
  assert.ok(pool.filter(isVegCurry).length >= VEG_CURRY_MIN);
  // The vegetable curries first, then the rest, each in the ideas' own order.
  const at = (r) => ideas.indexOf(r);
  const firstOther = pool.findIndex((r) => !isVegCurry(r));
  if (firstOther >= 0) assert.ok(pool.slice(firstOther).every((r) => !isVegCurry(r)), "vegetable curries come first");
  for (const part of [pool.filter(isVegCurry), pool.filter((r) => !isVegCurry(r))]) assert.deepEqual(part.map(at), [...part.map(at)].sort((a, b) => a - b));
});

test("FAM-08 a new vegetable each time: never three brinjal curries in a row", () => {
  for (const pantry of [STARTER, SHOPPED, [...SHOPPED, "ivy gourd", "drumstick"]]) {
    const pool = withVegCurries(familyDinnerIdeas(pantry, { frozen: FREEZER }));
    const vegs = pool.map(mainVegOf);
    assert.equal(new Set(vegs).size, vegs.length, `one dish per vegetable: ${pool.map((r) => r.title).join(" | ")}`);
    assert.ok(new Set(pool.filter(isVegCurry).map(mainVegOf)).size >= VEG_CURRY_MIN, "5+ vegetables among the curries");
  }
  // The book has several brinjal curries; only the best one stays.
  const brinjal = LIBRARY.filter((r) => r.forWhom === "family" && isVegCurry(r) && mainVegOf(r) === "brinjal");
  assert.ok(brinjal.length >= 3);
  assert.equal(oneEachVeg(brinjal).length, 1);
  assert.equal(mainVegOf(LIBRARY.find((r) => r.title.startsWith("Vankaya bangaladumpa kura"))), "brinjal");
});
