import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecipe, checkForAudience } from "../public/shared/safety.js";
import { LIBRARY, suggestFromLibrary } from "../public/shared/recipes.js";
import { addDays, addMonths, monthGrid, occurrences, isDateKey, toKey } from "../public/shared/dates.js";
import { mergeItems, normName, aisleFor, missingFromPantry } from "../public/shared/shopping.js";
import { emptyDay, approveDay, markEdited, pendingFor, dayStatus } from "../public/shared/plan.js";
import { parseRequest, screen } from "../lib/ai.js";

const baby = (ingredients, steps = [], extra = {}) => ({ title: "t", forWhom: "baby", texture: "mashed", ingredients: ingredients.map((name) => ({ name, quantity: 1, unit: "tsp" })), steps, ...extra });

test("honey, salt, sugar and whole nuts are blocked for the baby", () => {
  for (const bad of ["honey", "salt", "sugar", "jaggery", "cashews", "peanuts", "whole grapes", "popcorn"]) {
    assert.equal(checkRecipe(baby(["rice", bad]), { age: "baby" }).safe, false, bad);
  }
});

test("negated and look-alike words do not trigger", () => {
  assert.equal(checkRecipe(baby(["rice", "coconut", "nutmeg"], ["Do not add salt.", "No honey."]), { age: "baby" }).safe, true);
  assert.equal(checkRecipe(baby(["unsalted butter"]), { age: "baby" }).safe, true);
  assert.equal(checkRecipe(baby(["peanut powder"]), { age: "baby" }).safe, true);
  assert.equal(checkRecipe(baby(["rice"], ["Add 1 teaspoon ghee"]), { age: "baby" }).safe, true);
});

test("salt in the steps is caught", () => {
  assert.equal(checkRecipe(baby(["rice"], ["Add a pinch of salt and mash."]), { age: "baby" }).safe, false);
});

test("nut-free lunchbox only when the school-is-nut-free setting is on", () => {
  const r = { title: "x", forWhom: "kid", mealType: "lunchbox", ingredients: [{ name: "peanut butter", quantity: 1, unit: "tbsp" }], steps: [] };
  assert.equal(checkForAudience(r).safe, true);
  assert.equal(checkForAudience(r, { schoolNutFree: true }).safe, false);
  assert.equal(checkForAudience({ ...r, mealType: "dinner" }, { schoolNutFree: true }).safe, true);
  const sun = { ...r, ingredients: [{ name: "sunflower butter", quantity: 1, unit: "tbsp" }] };
  assert.equal(checkForAudience(sun, { schoolNutFree: true }).safe, true);
});

test("whole nuts warn for the 4-year-old, nut butter does not", () => {
  const kid = (name) => checkRecipe({ title: "x", ingredients: [{ name }], steps: [] }, { age: "kid" });
  assert.equal(kid("cashews").warnings[0].rule, "whole-nuts");
  assert.equal(kid("peanut butter").warnings.length, 0);
});

test("nut-free setting filters library suggestions and family favorites rank up", () => {
  const withNuts = suggestFromLibrary([], { forWhom: "kid", limit: 100 });
  const nutFree = suggestFromLibrary([], { forWhom: "kid", limit: 100, schoolNutFree: true });
  assert.ok(withNuts.some((r) => r.id === "ds-pb-jam-sandwich"));
  assert.ok(!nutFree.some((r) => r.id === "ds-pb-jam-sandwich"));
  assert.equal(suggestFromLibrary(["bread", "peanut butter", "berry jam"], { forWhom: "kid", limit: 1 })[0].id, "ds-pb-jam-sandwich");
});

test("every built-in recipe passes its own age checks", () => {
  for (const r of LIBRARY) assert.equal(checkForAudience(r).safe, true, r.title + " " + JSON.stringify(checkForAudience(r).errors));
});

test("library suggestions prefer what is in the pantry", () => {
  const out = suggestFromLibrary(["ragi flour", "banana"], { forWhom: "baby", limit: 1 });
  assert.equal(out[0].id, "lib-ragi-porridge");
});

test("date keys never shift across months, leap years or DST", () => {
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(isDateKey("2026-02-30"), false);
  assert.equal(toKey(new Date(2026, 9, 22, 23, 59)), "2026-10-22");
  const g = monthGrid("2026-10-15");
  assert.equal(g.length, 42);
  assert.equal(g.filter((c) => c.inMonth).length, 31);
  assert.equal(g.find((c) => c.inMonth).key, "2026-10-01");
});

test("repeating reminders", () => {
  assert.deepEqual(occurrences({ date: "2026-10-01", repeat: "weekly" }, "2026-10-01", "2026-10-22"), ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"]);
  assert.deepEqual(occurrences({ date: "2026-01-31", repeat: "monthly" }, "2026-02-01", "2026-03-31"), ["2026-02-28", "2026-03-31"]);
});

test("shopping list merges units and synonyms", () => {
  const out = mergeItems([
    { name: "Toor dal", quantity: 500, unit: "g" },
    { name: "tuvar dal", quantity: 1, unit: "kg" },
    { name: "tomatoes", quantity: 3, unit: "pcs" },
    { name: "Tomato", quantity: 2, unit: "" },
    { name: "milk", quantity: 1, unit: "l" },
    { name: "milk", quantity: 2, unit: "packet" },
  ]);
  const dal = out.find((i) => i.name === "toor dal");
  assert.deepEqual([dal.quantity, dal.unit], [1.5, "kg"]);
  assert.equal(out.find((i) => i.name === "tomato").quantity, 5);
  assert.equal(out.filter((i) => i.name === "milk").length, 2);
  assert.equal(normName("Sooji"), "rava");
  assert.equal(aisleFor("curd"), "Dairy & eggs");
});

test("missing ingredients skip water, salt and oil", () => {
  const r = LIBRARY.find((x) => x.id === "lib-ragi-porridge");
  assert.deepEqual(missingFromPantry(r, ["Ragi"]).map((i) => i.name), ["banana"]);
});

test("approval flow and pending items", () => {
  const today = "2026-10-22";
  const state = { days: {}, reminders: [{ id: "r1", title: "PTM", date: today, time: "10:00", repeat: "none", done: {} }], todos: [{ id: "t1", text: "Buy dresses", who: "kid", date: today, done: false }] };
  let p = pendingFor(state, today, today);
  assert.deepEqual(p.map((x) => x.type).sort(), ["plan", "reminder", "todo"]);

  const d = (state.days[today] = emptyDay());
  d.meals.kid_lunchbox = { title: "Lemon rice" };
  assert.equal(dayStatus(state, today), "pending");
  assert.ok(pendingFor(state, today, today).some((x) => x.type === "approval"));

  approveDay(d);
  assert.equal(dayStatus(state, today), "approved");
  assert.ok(!pendingFor(state, today, today).some((x) => x.type === "approval"));

  d.meals.baby_lunch = { title: "Khichdi" };
  markEdited(d);
  assert.equal(dayStatus(state, today), "pending");
  assert.equal(d.changedAfterApproval, true);

  // Past days only keep overdue reminders and to-dos.
  const past = pendingFor(state, today, "2026-10-25");
  assert.deepEqual(past.map((x) => x.type), ["reminder", "todo"]);
  assert.equal(past[0].overdue, true);
});

test("server input is bounded and AI output is screened", () => {
  const req = parseRequest({ ingredients: Array(100).fill("rice"), forWhom: "x", count: 99 });
  assert.equal(req.ingredients.length, 60);
  assert.equal(req.forWhom, "both");
  assert.equal(req.count, 6);
  const { kept, rejected } = screen([baby(["rice", "honey"]), baby(["rice"])]);
  assert.equal(kept.length, 1);
  assert.equal(rejected[0].errors[0].rule, "honey");
});

test("negation only covers the word right after it", () => {
  assert.equal(checkRecipe(baby(["rice"], ["Skip the sugar and add honey."]), { age: "baby" }).safe, false);
  assert.equal(checkRecipe(baby(["honeyed carrots"]), { age: "baby" }).safe, false);
  assert.equal(checkRecipe(baby(["rice"], ["Skip the sugar."]), { age: "baby" }).safe, true);
});

test("teaspoons merge into tablespoons and -ies plurals merge", () => {
  const out = mergeItems([{ name: "ghee", quantity: 1, unit: "tbsp" }, { name: "ghee", quantity: 3, unit: "tsp" }, { name: "berries", quantity: 1, unit: "cup" }, { name: "berry", quantity: 1, unit: "cup" }]);
  const ghee = out.find((i) => i.name === "ghee");
  assert.deepEqual([ghee.quantity, ghee.unit], [2, "tbsp"]);
  assert.equal(out.filter((i) => i.name === "berry").length, 1);
  assert.equal(normName("green chillies"), "green chilli");
});

test("QUICK-02 quick suggestions from the recipe book are ready in 20 minutes, or the fastest there is", () => {
  const [kid] = suggestFromLibrary(["eggs", "bread"], { forWhom: "kid", mealType: "breakfast", limit: 1, maxMinutes: 20 });
  assert.ok(kid.prepMinutes > 0 && kid.prepMinutes <= 20, kid.title + " " + kid.prepMinutes);
  const quick = suggestFromLibrary([], { forWhom: "baby", limit: 100, maxMinutes: 20 });
  const firstSlow = quick.findIndex((r) => !(r.prepMinutes <= 20));
  assert.ok(firstSlow === -1 || quick.slice(firstSlow).every((r) => !(r.prepMinutes <= 20)), "quick ones come first");
  // No family dinner in the book takes 20 minutes, so it offers the fastest one rather than nothing.
  // (Leftover makeovers need yesterday's curry, so they are never plain suggestions.)
  const dinners = LIBRARY.filter((r) => r.forWhom === "family" && r.mealType === "dinner" && !r.leftover);
  const [fast] = suggestFromLibrary([], { forWhom: "family", mealType: "dinner", limit: 1, maxMinutes: 20 });
  assert.equal(fast.prepMinutes, Math.min(...dinners.map((r) => r.prepMinutes || Infinity)));
});
