import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY } from "../public/shared/recipes.js";
import { PLAN_RULES, PLAN_CHAT_SCHEMA, catalogText, libraryRefs, planWindow, contextText, userTurn, planChanges, SLOT_IDS } from "../public/shared/plan-chat.js";

const refs = libraryRefs(LIBRARY);
const refOf = (pred) => [...refs].find(([, r]) => pred(r));

test("CHAT-01 the rules keep the age, nut-free and busy-morning rules and the slots", () => {
  assert.match(PLAN_RULES, /never honey/);
  assert.match(PLAN_RULES, /nut-free, the lunchbox and the snack box never contain/);
  assert.match(PLAN_RULES, /easy prep the night before/);
  assert.match(PLAN_RULES, /nothing is baked or cooked for long that morning/);
  for (const id of SLOT_IDS) assert.match(PLAN_RULES, new RegExp(id));
  assert.equal(PLAN_CHAT_SCHEMA.additionalProperties, false);
  assert.deepEqual(PLAN_CHAT_SCHEMA.properties.changes.items.required.sort(), ["date", "ingredients", "notes", "ref", "slot", "steps", "title"]);
});

test("CHAT-02 the catalog lists every book recipe but the side dips, by ref", () => {
  const text = catalogText(LIBRARY);
  const [ref, r] = refOf((x) => x.mealType === "dinner");
  assert.ok(text.includes(`${ref} | family dinner | ${r.title}`) || text.includes(`${ref} | ${r.forWhom} dinner | ${r.title}`));
  assert.equal(refs.size, LIBRARY.filter((x) => x.mealType !== "side").length);
  assert.equal(catalogText(LIBRARY), text, "the same every turn so it can be cached");
});

test("CHAT-03 the planning window starts today and covers the week on screen and the next", () => {
  const w = planWindow("2026-10-22", "2026-10-22"); // a Thursday
  assert.equal(w.weekStart, "2026-10-18");
  assert.equal(w.weekEnd, "2026-10-24");
  assert.equal(w.dates[0], "2026-10-22");
  assert.equal(w.dates.at(-1), "2026-10-31");
});

test("CHAT-04 the context shows the plan, approvals, kitchen, freezer and nut-free school", () => {
  const w = planWindow("2026-10-22", "2026-10-22");
  const text = contextText({ today: "2026-10-22", window: w, days: { "2026-10-23": { status: "approved", meals: { family_dinner: { title: "Dal", recipeId: "x" } } } },
    refOf: () => "r1", pantry: ["rice", "dal"], frozen: [{ name: "green peas" }], schoolNutFree: true });
  assert.match(text, /2026-10-23 Fri school day \[approved\]: family_dinner=Dal \(r1\)/);
  assert.match(text, /2026-10-24 Sat weekend: nothing planned/);
  assert.match(text, /In the kitchen: rice, dal/);
  assert.match(text, /In the freezer \(low priority, keeps for months\): green peas/);
  assert.match(text, /school is nut-free/);
  assert.match(userTurn(text, "No eggs this week"), /Parent: No eggs this week$/);
});

test("CHAT-05 changes: book recipes apply, unsafe, wrong-age, weekend-lunchbox and out-of-window ones are left out", () => {
  const dates = planWindow("2026-10-22", "2026-10-22").dates;
  const [babyRef] = refOf((x) => x.forWhom === "baby");
  const [dinnerRef] = refOf((x) => x.forWhom === "family" && x.mealType === "dinner");
  const [kidRef] = refOf((x) => x.forWhom === "kid" && x.mealType === "lunchbox");
  const honey = { date: "2026-10-23", slot: "baby_breakfast", ref: "", title: "Honey oats", ingredients: [{ name: "oats", quantity: 2, unit: "tbsp" }, { name: "honey", quantity: 1, unit: "tsp" }], steps: ["Cook"], notes: "" };
  const peanut = { date: "2026-10-23", slot: "kid_lunchbox", ref: "", title: "Peanut butter sandwich", ingredients: [{ name: "bread", quantity: 2, unit: "pcs" }, { name: "peanut butter", quantity: 1, unit: "tbsp" }], steps: ["Spread"], notes: "" };
  const { apply, skipped } = planChanges([
    { date: "2026-10-23", slot: "baby_lunch", ref: babyRef, title: "", ingredients: [], steps: [], notes: "" },
    { date: "2026-10-23", slot: "family_dinner", ref: dinnerRef, title: "", ingredients: [], steps: [], notes: "" },
    { date: "2026-10-23", slot: "baby_dinner", ref: dinnerRef, title: "", ingredients: [], steps: [], notes: "" },
    { date: "2026-10-24", slot: "kid_lunchbox", ref: kidRef, title: "", ingredients: [], steps: [], notes: "" },
    { date: "2026-10-20", slot: "family_dinner", ref: dinnerRef, title: "", ingredients: [], steps: [], notes: "" },
    { date: "2026-10-26", slot: "kid_snack", ref: "", title: "", ingredients: [], steps: [], notes: "" },
    honey, peanut,
  ], { dates, refs, schoolNutFree: true });
  assert.deepEqual(apply.map((a) => `${a.date}/${a.slot}`), ["2026-10-23/baby_lunch", "2026-10-23/family_dinner", "2026-10-26/kid_snack"]);
  assert.equal(apply[2].recipe, null, "an empty change clears the slot");
  assert.deepEqual(skipped.map((s) => s.why.slice(0, 20)), ["not a baby recipe", "no lunchbox on weeke", "outside the days bei", skipped[3].why.slice(0, 20), skipped[4].why.slice(0, 20)]);
  assert.match(skipped[3].why, /honey/i);
  assert.match(skipped[4].why, /nut-free/i);
});

test("CHAT-06 a new dish gets a recipe with its ingredients; a book title without its ref uses the book recipe", () => {
  const dates = ["2026-10-23"];
  const [ref, book] = refOf((x) => x.forWhom === "family" && x.mealType === "dinner");
  const { apply } = planChanges([
    { date: "2026-10-23", slot: "family_dinner", ref: "", title: book.title, ingredients: [], steps: [], notes: "" },
    { date: "2026-10-23", slot: "kid_snack", ref: "", title: "Cucumber sticks with curd dip", ingredients: [{ name: "cucumber", quantity: 1, unit: "pcs" }, { name: "curd", quantity: 0.5, unit: "cup" }], steps: ["Cut", "Serve"], notes: "" },
  ], { dates, refs, stamp: "t" });
  assert.equal(apply[0].recipe.id, book.id);
  assert.equal(apply[0].isNew, false);
  assert.ok(ref);
  assert.equal(apply[1].isNew, true);
  assert.equal(apply[1].recipe.forWhom, "kid");
  assert.equal(apply[1].recipe.mealType, "snack");
  assert.equal(apply[1].recipe.ingredients.length, 2);
});
