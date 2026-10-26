// The 4-year-old's school lunches (LUNCH): her list in order, a school day at a time, week after week,
// skipping the chicken quesadilla without chicken and the idlis without idli batter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY } from "../public/shared/recipes.js";
import { checkRecipe } from "../public/shared/safety.js";
import { LUNCH_ROTATION, lunchFits, lunchesAfter, lunchTurn } from "../public/shared/lunch-rotation.js";

const ALL = LUNCH_ROTATION.map((l) => l.id);
const [PBJ, EGG_RICE, CHICKEN, IDLI, MAC, CREAM_CHEESE, WAFFLES] = ALL;
const lunch = (id) => ({ meals: { kid_lunchbox: { recipeId: id, title: id } } });
// 2026-10-26 is a Monday.
const MON = "2026-10-26";

test("LUNCH-01 every lunch on the list is a 4-year-old's lunchbox recipe in the book", () => {
  assert.equal(ALL.length, 7);
  for (const id of ALL) {
    const r = LIBRARY.find((x) => x.id === id);
    assert.ok(r, id);
    assert.equal(r.forWhom, "kid");
    assert.equal(r.mealType, "lunchbox");
    assert.ok(checkRecipe(r, { age: "kid", lunchbox: true }).safe, id);
  }
});

test("LUNCH-02 chicken and idli batter are needed in the kitchen for those two lunches", () => {
  const [, , chicken, idli] = LUNCH_ROTATION;
  assert.ok(lunchFits(chicken, ["Chicken (boneless)"]));
  assert.ok(lunchFits(chicken, [{ name: "chicken thighs" }]));
  assert.ok(!lunchFits(chicken, ["chicken masala"]));
  assert.ok(lunchFits(idli, ["idli/dosa batter"]));
  assert.ok(lunchFits(idli, ["Idly batter"]));
  assert.ok(!lunchFits(idli, ["idli rava"]));
  assert.ok(lunchFits(LUNCH_ROTATION[0], []));
});

test("LUNCH-03 the list goes round in order and skips what the kitchen can't make", () => {
  assert.deepEqual(lunchesAfter("", ["chicken", "idli batter"]), ALL);
  assert.deepEqual(lunchesAfter(EGG_RICE, []), [MAC, CREAM_CHEESE, WAFFLES, PBJ, EGG_RICE]);
  assert.deepEqual(lunchesAfter(EGG_RICE, ["chicken"])[0], CHICKEN);
  assert.deepEqual(lunchesAfter(CHICKEN, ["idli/dosa batter"])[0], IDLI);
  assert.deepEqual(lunchesAfter(WAFFLES, [])[0], PBJ);
  assert.deepEqual(lunchesAfter(MAC, [], (id) => id !== CREAM_CHEESE)[0], WAFFLES);
});

test("LUNCH-04 the next lunch follows the last one planned, across the weekend", () => {
  const days = { "2026-10-23": lunch(CREAM_CHEESE) }; // the Friday before
  assert.equal(lunchTurn(MON, { days, today: MON })[0], WAFFLES);
  // Monday was the waffles, so Tuesday starts the list again.
  assert.equal(lunchTurn("2026-10-27", { days: { ...days, [MON]: lunch(WAFFLES) }, today: MON })[0], PBJ);
  // With nothing planned, the list starts at the top.
  assert.equal(lunchTurn(MON, { days: {}, today: MON })[0], PBJ);
});

test("LUNCH-05 a week of empty school days goes down the list one lunch a day", () => {
  const week = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"];
  const plan = (kitchen) => week.map((k) => lunchTurn(k, { days: {}, today: MON, kitchen })[0]);
  assert.deepEqual(plan(["chicken", "idli batter"]), ALL);
  assert.deepEqual(plan([]), [PBJ, EGG_RICE, MAC, CREAM_CHEESE, WAFFLES, PBJ, EGG_RICE]);
});

test("LUNCH-06 a lunch that isn't on the list doesn't move it on, and past empty days don't count", () => {
  const days = { "2026-10-23": lunch(PBJ), [MON]: lunch("lib-lemon-rice-nimmakaya-pulihora") };
  assert.equal(lunchTurn("2026-10-27", { days, today: MON })[0], EGG_RICE);
  assert.equal(lunchTurn("2026-10-28", { days: { "2026-10-23": lunch(PBJ) }, today: "2026-10-28" })[0], EGG_RICE);
});
