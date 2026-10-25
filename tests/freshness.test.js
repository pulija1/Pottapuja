// Use-by dates on kitchen food (FRESH), cooking first what runs out, the freezer last, the
// cuisine's staples taken as at home, and quick breakfasts from the kitchen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shelfLifeDays, expiryOf, kitchenExpiry, useSoonWeights, goneBy, staplesFor, staplesSummary, daysLeftLabel } from "../public/shared/freshness.js";
import { LIBRARY, suggestFromLibrary, readyToCook, topPicks, quickBreakfasts } from "../public/shared/recipes.js";
import { checkRecipe } from "../public/shared/safety.js";
import { buildPrompt, parseRequest, SYSTEM } from "../public/shared/ai-prompt.js";
import { contextText, planWindow, PLAN_RULES } from "../public/shared/plan-chat.js";
import { defaultState, cleanPantryDates } from "../public/store.js";

const TODAY = "2026-10-25"; // Sunday

test("FRESH-01 fridge shelf life: greens go first, onions and potatoes last, rice and spices never", () => {
  assert.equal(shelfLifeDays("Palakura (spinach)"), 4);
  assert.equal(shelfLifeDays("Bendakaya (okra)"), 4);
  assert.equal(shelfLifeDays("ladies finger"), 4);
  assert.equal(shelfLifeDays("carrots"), 21);
  assert.equal(shelfLifeDays("onion"), 30);
  assert.equal(shelfLifeDays("idli/dosa batter"), 4);
  assert.equal(shelfLifeDays("curd"), 7);
  // Not in the table: the kitchen group's default.
  assert.equal(shelfLifeDays("snow peas"), 7);
  for (const n of ["rice", "toor dal", "mustard seeds", "ghee", "almond powder", "biscuits"]) assert.equal(shelfLifeDays(n), null, n);
});

test("FRESH-02 a typed-in date wins; without one the date is estimated from when it came in", () => {
  assert.deepEqual(expiryOf("okra", { added: "2026-10-24", expires: "2026-10-30" }, TODAY), { expires: "2026-10-30", estimated: false, daysLeft: 5 });
  assert.deepEqual(expiryOf("okra", { added: "2026-10-24", expires: "" }, TODAY), { expires: "2026-10-28", estimated: true, daysLeft: 3 });
  assert.deepEqual(expiryOf("okra", undefined, TODAY), { expires: "2026-10-29", estimated: true, daysLeft: 4 }, "no entry: from today");
  assert.equal(expiryOf("rice", {}, TODAY), null);
  assert.equal(expiryOf("rice", { expires: "2026-11-01" }, TODAY).daysLeft, 7, "anything can be dated by hand");
  const list = kitchenExpiry(["rice", "carrot", "spinach", "okra"], { spinach: { added: "2026-10-24" }, okra: { expires: "2026-10-26" } }, TODAY);
  assert.deepEqual(list.map((e) => e.name), ["okra", "spinach", "carrot"], "soonest first, rice left out");
  assert.equal(daysLeftLabel(0), "today");
  assert.equal(daysLeftLabel(1), "tomorrow");
  assert.equal(daysLeftLabel(3), "in 3 days");
});

test("FRESH-03 use-soon weights depend on the day being planned, and a used-up item drops out", () => {
  const pantry = ["okra", "spinach", "carrot"];
  const dates = { okra: { added: TODAY, expires: "2026-10-27" }, spinach: { added: "2026-10-20", expires: "" }, carrot: { added: TODAY } };
  const today = useSoonWeights(pantry, dates, { today: TODAY });
  assert.equal(today.get("okra"), 0.7, "two days left");
  assert.equal(today.get("spinach"), 1, "past its estimated date: use it now");
  assert.equal(today.has("carrot"), false, "three weeks left");
  const friday = useSoonWeights(pantry, dates, { today: TODAY, onKey: "2026-10-30" });
  assert.equal(friday.has("okra"), false, "past the date typed in by Friday");
  assert.equal(friday.has("spinach"), false, "an estimate past by more than a day is gone too");
  const skip = useSoonWeights(pantry, dates, { today: TODAY, skip: new Set(["okra"]) });
  assert.equal(skip.has("okra"), false);
  // Past a typed-in date, a later day can't count on it; an estimate never takes food away.
  assert.deepEqual(goneBy(pantry, dates, { today: TODAY, onKey: "2026-10-28" }), ["okra"]);
  assert.deepEqual(goneBy(pantry, dates, { today: TODAY, onKey: "2026-10-27" }), []);
  assert.deepEqual(goneBy(pantry, dates, { today: TODAY }), [], "nothing is taken away today");
});

test("FRESH-04 suggestions cook first what runs out, and safety and nut-free rules still hold", () => {
  const pantry = defaultState().pantry.concat("okra", "spinach");
  const staples = staplesFor([]);
  const useSoon = new Map([["okra", 1]]);
  const plain = suggestFromLibrary(pantry, { forWhom: "family", mealType: "dinner", staples, limit: 3 });
  const soon = suggestFromLibrary(pantry, { forWhom: "family", mealType: "dinner", staples, useSoon, limit: 3 });
  assert.ok(soon[0].ingredients.some((i) => /okra/i.test(i.name)), `first pick uses the okra: ${soon[0].title}`);
  assert.notDeepEqual(soon.map((r) => r.id), plain.map((r) => r.id));
  const ready = readyToCook(pantry, { staples, useSoon, maxMissing: 1, limit: 3 });
  assert.ok(ready.some((x) => x.recipe.ingredients.some((i) => /okra/i.test(i.name))));
  const picks = topPicks(pantry, { staples, useSoon, limit: 3 });
  assert.ok(picks[0].recipe.ingredients.some((i) => /okra/i.test(i.name)), picks[0].recipe.title);
  // Expiry never brings in an unsafe or nut lunchbox.
  const lunch = suggestFromLibrary(["peanut butter", "bread"], { forWhom: "kid", mealType: "lunchbox", schoolNutFree: true, useSoon: new Map([["peanut butter", 1]]), limit: 20 });
  for (const r of lunch) assert.ok(checkRecipe(r, { age: "kid", lunchbox: true, schoolNutFree: true, nutFreeSwap: r.nutFreeSwap }).safe || r.forWhom === "family", r.title);
  const baby = suggestFromLibrary(pantry, { forWhom: "baby", useSoon, staples, limit: 40 }).filter((r) => r.forWhom === "baby");
  assert.ok(baby.length);
  for (const r of baby) assert.ok(checkRecipe(r, { age: "baby" }).safe, r.title);
});

test("FRESH-05 the freezer is low priority: a fresh match beats the same match from the freezer", () => {
  const peas = LIBRARY.filter((r) => r.forWhom === "kid" && r.mealType === "lunchbox" && r.ingredients.some((i) => /\bpeas\b/.test(i.name)));
  assert.ok(peas.length, "the book has lunchboxes with peas");
  const opt = { forWhom: "kid", mealType: "lunchbox", limit: 200 };
  const fresh = suggestFromLibrary(["peas", "potato", "carrot"], opt);
  const frozen = suggestFromLibrary(["potato", "carrot"], { ...opt, frozen: [{ name: "Frozen peas", qty: 1 }] });
  const none = suggestFromLibrary(["potato", "carrot"], opt);
  const rank = (list, r) => list.findIndex((x) => x.id === r.id);
  const r = peas.find((x) => rank(fresh, x) >= 0 && rank(frozen, x) >= 0);
  assert.ok(rank(fresh, r) <= rank(frozen, r), `${r.title}: fresh ${rank(fresh, r)}, frozen ${rank(frozen, r)}`);
  assert.ok(rank(frozen, r) <= rank(none, r), "the freezer still counts for something");
});

test("FRESH-06 cuisine staples count as at home: rice, dals, spices, oil and onions are never missing", () => {
  const south = staplesFor([]);
  for (const n of ["rice", "toor dal", "moong dal", "mustard seeds", "jeera", "turmeric", "onion", "oil", "tamarind"]) assert.ok(south.includes(n), n);
  assert.deepEqual(staplesFor(["telugu"]), south, "Telugu is the South Indian set");
  assert.ok(staplesFor(["north"]).includes("atta") && staplesFor(["north"]).includes("garam masala"));
  assert.ok(!staplesFor(["mexican"]).includes("toor dal"));
  assert.match(staplesSummary([]), /rice, dals, spices.*oil.*onion/);
  // Tomato pappu needs only the tomato once the staples count.
  const pappu = LIBRARY.find((r) => /tomato pappu/i.test(r.title));
  const without = readyToCook(["tomato"], { maxMissing: 0, limit: 200 });
  const withStaples = readyToCook(["tomato"], { maxMissing: 0, limit: 200, staples: south });
  assert.ok(!without.some((x) => x.recipe.id === pappu.id));
  assert.ok(withStaples.some((x) => x.recipe.id === pappu.id));
});

test("FRESH-07 quick breakfasts: ready in 20 minutes, at most one thing to buy, kid and family (or the baby's)", () => {
  const pantry = defaultState().pantry.concat("egg", "bread", "milk");
  const staples = staplesFor([]);
  const list = quickBreakfasts(pantry, { staples, limit: 10 });
  assert.ok(list.length >= 3, `found ${list.length}`);
  for (const x of list) {
    assert.equal(x.recipe.mealType, "breakfast");
    assert.ok(["kid", "family"].includes(x.recipe.forWhom), x.recipe.title);
    assert.ok(x.minutes <= 20 && x.missing.length <= 1, x.recipe.title);
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].missing.length <= list[i].missing.length, "fewest missing first");
  const baby = quickBreakfasts(pantry, { staples, forWhom: "baby", limit: 10 });
  assert.ok(baby.length);
  for (const x of baby) assert.ok(checkRecipe(x.recipe, { age: "baby" }).safe, x.recipe.title);
  // What runs out comes first among the ones with nothing to buy.
  const banana = quickBreakfasts(pantry, { staples, forWhom: "baby", limit: 10, useSoon: new Map([["banana", 1]]) });
  assert.ok(banana[0].recipe.ingredients.some((i) => /banana/i.test(i.name)), banana[0].recipe.title);
  const nutFree = quickBreakfasts(["peanut butter", "bread"], { schoolNutFree: true, limit: 20 });
  assert.ok(!nutFree.some((x) => x.recipe.forWhom === "kid" && x.recipe.ingredients.some((i) => /peanut/i.test(i.name))));
});

test("FRESH-08 the recipe AI hears what runs out and the staples; the request is bounded", () => {
  const req = parseRequest({ ingredients: ["okra"], useSoon: ["okra (runs out tomorrow)", "", "okra (runs out tomorrow)", 5], staples: Array(80).fill(0).map((_, i) => "s" + i) });
  assert.deepEqual(req.useSoon, ["okra (runs out tomorrow)", "5"]);
  assert.equal(req.staples.length, 40);
  const p = buildPrompt(parseRequest({ ingredients: ["okra", "rice"], useSoon: ["okra (runs out tomorrow)"], staples: ["rice", "toor dal"] }));
  assert.match(p, /Use these first, they run out soon: okra \(runs out tomorrow\)/);
  assert.match(p, /Pantry staples always at home: rice, toor dal/);
  assert.doesNotMatch(buildPrompt(parseRequest({ ingredients: ["okra"] })), /run out soon|staples always/);
  assert.match(SYSTEM, /runs out soon/);
  assert.match(SYSTEM, /never honey/, "the baby rules are still there");
});

test("FRESH-09 the planning chat gets each item's use-by date, what to cook first, the freezer as low priority and the staples", () => {
  const w = planWindow(TODAY, TODAY);
  const expiry = kitchenExpiry(["okra", "carrot", "rice"], { okra: { added: TODAY, expires: "2026-10-27" }, carrot: { added: TODAY } }, TODAY);
  const text = contextText({ today: TODAY, window: w, pantry: ["okra", "carrot", "rice"], frozen: [{ name: "Frozen peas" }], expiry, staples: ["rice", "toor dal"] });
  assert.match(text, /In the kitchen: okra \(use by Tue 2026-10-27\), carrot \(use by Sun 2026-11-15, estimated\), rice/);
  assert.match(text, /Runs out first, cook these early in the week: okra$/m);
  assert.match(text, /In the freezer \(low priority, keeps for months\): Frozen peas/);
  assert.match(text, /Pantry staples always at home: rice, toor dal/);
  assert.match(PLAN_RULES, /Cook fresh food before it runs out/);
  assert.match(PLAN_RULES, /Freezer food keeps for months: it is low priority/);
  assert.match(PLAN_RULES, /nut-free, the lunchbox and the snack box never contain peanuts/, "nut-free rule kept");
});

test("FRESH-10 saved use-by dates keep only their date strings", () => {
  assert.deepEqual(cleanPantryDates({ okra: { added: "2026-10-25", expires: "bad", x: 1 }, rice: "no", "": {}, carrot: { added: 5 } }),
    { okra: { added: "2026-10-25", expires: "" }, carrot: { added: "", expires: "" } });
  assert.deepEqual(cleanPantryDates([1, 2]), {});
  assert.deepEqual(defaultState().pantryDates, {});
});
