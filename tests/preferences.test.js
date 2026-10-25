// Each child's needs from Profile (PREF) and breakfasts that fit a real morning (MORN).
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefsFor, prefProblem, prefBoost, prefsPrompt, prefStaples, cleanPrefs } from "../public/shared/preferences.js";
import { LIBRARY, suggestFromLibrary, quickBreakfasts, breakfastKind, fitsMorning } from "../public/shared/recipes.js";
import { buildPrompt, parseRequest } from "../public/shared/ai-prompt.js";
import { planChanges, libraryRefs, contextText, planWindow } from "../public/shared/plan-chat.js";
import { checkRecipe } from "../public/shared/safety.js";

const gassyIron = { prefs: { baby: { tags: ["gassy", "ironCereal"], note: "loves pear" } } };
const byTitle = (re) => LIBRARY.find((r) => re.test(r.title));

test("PREF-01 settings are cleaned: unknown needs dropped, the note trimmed", () => {
  assert.deepEqual(cleanPrefs({ baby: { tags: ["gassy", "bogus"], note: "  x  " }, kid: { tags: [] }, dog: { tags: ["noEgg"] } }), { baby: { tags: ["gassy"], note: "x" } });
  assert.equal(prefsFor({}, "baby").tags.size, 0);
  assert.deepEqual(prefStaples(gassyIron), ["iron-fortified baby cereal"]);
  assert.deepEqual(prefStaples({}), []);
});

test("PREF-02 a gassy baby gets no cabbage, cauliflower or whole beans; no egg and no dairy are kept", () => {
  const cauli = { title: "Cauliflower mash", forWhom: "baby", ingredients: [{ name: "cauliflower" }] };
  assert.equal(prefProblem(cauli, "baby", gassyIron), "can give the baby gas");
  assert.equal(prefProblem(cauli, "baby", {}), "");
  assert.equal(prefProblem(cauli, "kid", { prefs: { kid: { tags: ["picky"] } } }), "", "the kid's settings don't touch the baby rule");
  assert.equal(prefProblem({ ingredients: [{ name: "egg" }] }, "kid", { prefs: { kid: { tags: ["noEgg"] } } }), "has egg");
  assert.equal(prefProblem({ ingredients: [{ name: "paneer" }] }, "kid", { prefs: { kid: { tags: ["noDairy"] } } }), "has milk or dairy");
  assert.equal(prefProblem({ ingredients: [{ name: "peanut butter" }] }, "kid", { prefs: { kid: { tags: ["noDairy"] } } }), "", "peanut butter isn't dairy");
  assert.equal(prefProblem({ ingredients: [{ name: "chicken" }] }, "kid", { prefs: { kid: { tags: ["vegetarian"] } } }), "has meat or fish");
  const baby = suggestFromLibrary(["cauliflower", "broccoli", "rajma", "rice", "moong dal", "banana"], { forWhom: "baby", limit: 60, settings: gassyIron }).filter((r) => r.forWhom === "baby");
  assert.ok(baby.length);
  for (const r of baby) assert.ok(!r.ingredients.some((i) => /cauliflower|broccoli|rajma|cabbage|chana/i.test(i.name)), r.title);
});

test("PREF-03 iron-fortified cereal: the baby's breakfast leans to it, and it counts as at home", () => {
  const top = suggestFromLibrary(["banana"], { forWhom: "baby", mealType: "breakfast", limit: 3, settings: gassyIron, child: "baby", staples: prefStaples(gassyIron) });
  assert.match(top[0].title, /Iron-fortified cereal/);
  for (const r of LIBRARY.filter((x) => /baby cereal/.test(x.ingredients.map((i) => i.name).join()))) assert.ok(checkRecipe(r, { age: "baby" }).safe, r.title);
  assert.ok(prefBoost(top[0], "baby", gassyIron, { mealType: "breakfast" }) > 1);
});

test("PREF-04 the AI is told each child's needs, and the planning chat leaves out meals that break them", () => {
  const needs = prefsPrompt({ prefs: { baby: { tags: ["gassy", "ironCereal"], note: "loves pear" }, kid: { tags: ["noEgg"] } } });
  assert.match(needs, /The 8-month-old has a gassy tummy.*iron-fortified baby cereal.*"loves pear"/);
  assert.match(needs, /The 4-year-old doesn't eat egg/);
  assert.equal(prefsPrompt({}), "");
  const p = buildPrompt(parseRequest({ ingredients: ["rice"], childNeeds: needs }));
  assert.match(p, /Each child's needs, always keep to them:\nThe 8-month-old has a gassy tummy/);
  const w = planWindow("2026-10-26", "2026-10-26");
  assert.match(contextText({ today: "2026-10-26", window: w, needs }), /Each child's needs:\nThe 8-month-old/);
  const refs = libraryRefs(LIBRARY);
  const ref = (pred) => [...refs].find(([, r]) => pred(r))[0];
  const eggKid = ref((r) => r.forWhom === "kid" && r.mealType === "lunchbox" && r.ingredients.some((i) => /\beggs?\b/.test(i.name)));
  const out = planChanges([{ date: "2026-10-27", slot: "kid_lunchbox", ref: eggKid }], { dates: w.dates, refs, settings: { prefs: { kid: { tags: ["noEgg"] } } } });
  assert.equal(out.apply.length, 0);
  assert.equal(out.skipped[0].why, "has egg");
});

test("MORN-01 breakfasts by when the work happens: muffins and parathas are weekend batches, upma the night before", () => {
  assert.equal(breakfastKind(byTitle(/^Make-ahead egg muffins/)), "weekend");
  assert.equal(breakfastKind(byTitle(/^Aloo paratha \(made the night/)), "weekend");
  assert.equal(breakfastKind(byTitle(/^Vegetable upma \(made the night/)), "night");
  assert.equal(breakfastKind(byTitle(/^Peanut butter banana toast/)), "no-cook");
  assert.equal(breakfastKind(byTitle(/^Masala egg bhurji/)), "morning");
  assert.equal(breakfastKind(byTitle(/^Ven pongal/)), "slow");
  // Every make-ahead breakfast says when and how long.
  for (const r of LIBRARY.filter((x) => x.mealType === "breakfast" && x.busyMorning === "make-ahead")) assert.ok(r.prepAhead?.minutes, r.title);
});

test("MORN-02 on a school day nothing slow, and a weekend batch only while it keeps; weekends take anything", () => {
  const muffins = byTitle(/^Make-ahead egg muffins/);   // keeps 4 days
  const burritos = byTitle(/^Egg and potato breakfast burritos/);   // freezes
  assert.equal(fitsMorning(muffins, "2026-10-26"), true, "Monday");
  assert.equal(fitsMorning(muffins, "2026-10-29"), true, "Thursday, 4 days on");
  assert.equal(fitsMorning(muffins, "2026-10-30"), false, "Friday, past keeping");
  assert.equal(fitsMorning(burritos, "2026-10-30"), true, "frozen ones keep all week");
  assert.equal(fitsMorning(byTitle(/^Ven pongal/), "2026-10-27"), false);
  assert.equal(fitsMorning(byTitle(/^Ven pongal/), "2026-10-31"), true, "Saturday");
  // The planning chat drops a slow breakfast on a school day.
  const refs = libraryRefs(LIBRARY);
  const pongal = [...refs].find(([, r]) => /^Ven pongal/.test(r.title))[0];
  const w = planWindow("2026-10-26", "2026-10-26");
  const out = planChanges([{ date: "2026-10-27", slot: "kid_breakfast", ref: pongal }, { date: "2026-10-31", slot: "kid_breakfast", ref: pongal }], { dates: w.dates, refs });
  assert.deepEqual(out.apply.map((a) => a.date), ["2026-10-31"]);
  assert.equal(out.skipped[0].why, "can't be ready on a school morning");
});

test("MORN-03 easy breakfasts come grouped by when: no slow ones, and the night-before ones are easy", () => {
  const list = quickBreakfasts(["egg", "bread", "milk", "rava", "potato", "flour tortilla", "carrot", "banana", "rolled oats", "curd", "spinach", "cheddar cheese", "butter", "tomato", "black beans"], { limit: 60, staples: ["rice", "onion", "oil"] });
  const kinds = new Set(list.map((x) => x.kind));
  assert.ok(!kinds.has("slow"));
  assert.ok(kinds.has("night") && kinds.has("weekend") && (kinds.has("morning") || kinds.has("no-cook")), [...kinds].join());
  for (const x of list.filter((y) => y.kind === "morning")) assert.ok(x.minutes <= 15, x.recipe.title);
  for (const x of list.filter((y) => y.kind === "night")) assert.ok((x.recipe.prepAhead?.minutes || 0) <= 20, x.recipe.title);
  const noEgg = quickBreakfasts(["egg", "bread", "milk"], { limit: 60, settings: { prefs: { kid: { tags: ["noEgg"] } } } });
  assert.ok(!noEgg.some((x) => x.recipe.forWhom === "kid" && x.recipe.ingredients.some((i) => /\beggs?\b/.test(i.name))));
});
