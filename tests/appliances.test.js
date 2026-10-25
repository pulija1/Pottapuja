// Cooking appliances (air fryer, oven): Profile settings, the recipe book's method lines,
// suggestions, two-basket pairing and the AI prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApplianceLine, ownedAppliances, methodsFor, fastestMinutes, basketPairs, appliancePrompt, applianceRequest } from "../public/shared/appliances.js";
import { parseRecipeMarkdown, recipeToMarkdown } from "../public/shared/recipe-book.js";
import { LIBRARY, suggestFromLibrary } from "../public/shared/recipes.js";
import { buildPrompt, parseRequest } from "../public/shared/ai-prompt.js";

const MD = `
### Okra fry

- **For:** family
- **Meal:** dinner
- **Time:** 25 min
- **Air fryer:** 15 min at 200°C. Toss in oil, shake every 5 minutes.
- **Oven:** 25–30 min at 220°C (425°F) on a lined tray.

**Ingredients**

- 250 g okra
- 1 tsp salt

**Steps**

1. Fry the okra.
`;

test("APPL-01 method lines give the text, total minutes and °C", () => {
  assert.deepEqual(parseApplianceLine("15 min at 200°C. Shake every 5 minutes."), { text: "15 min at 200°C. Shake every 5 minutes.", minutes: 15, tempC: 200 });
  assert.equal(parseApplianceLine("25–30 min at 220°C (425°F)").minutes, 30);
  assert.equal(parseApplianceLine("25–30 min at 220°C (425°F)").tempC, 220);
  assert.equal(parseApplianceLine("Roast until soft").minutes, null);
  assert.equal(parseApplianceLine(""), null);
});

test("APPL-02 the recipe book reads Air fryer and Oven lines and writes them back", () => {
  const { recipes, problems } = parseRecipeMarkdown(MD, "t.md");
  assert.deepEqual(problems, []);
  const [r] = recipes;
  assert.equal(r.airFryer.minutes, 15);
  assert.equal(r.oven.tempC, 220);
  const again = parseRecipeMarkdown(recipeToMarkdown(r), "t.md").recipes[0];
  assert.deepEqual(again.airFryer, r.airFryer);
  assert.deepEqual(again.oven, r.oven);
});

test("APPL-03 Profile settings decide which methods count", () => {
  const [r] = parseRecipeMarkdown(MD, "t.md").recipes;
  assert.deepEqual(ownedAppliances({}), []);
  assert.deepEqual(ownedAppliances({ airFryer: "dual", oven: true }), ["airFryer", "oven"]);
  assert.deepEqual(ownedAppliances({ airFryer: "single", oven: false }), ["airFryer"]);
  assert.deepEqual(ownedAppliances({ airFryer: "yes", oven: "true" }), []);
  assert.deepEqual(methodsFor(r, []), []);
  assert.deepEqual(methodsFor(r, ["oven"]).map((m) => m.key), ["oven"]);
  assert.equal(fastestMinutes(r, []), 25);
  assert.equal(fastestMinutes(r, ["airFryer"]), 15);
  assert.equal(fastestMinutes(r, ["oven"]), 25);
});

test("APPL-04 the book has air fryer and oven methods, and the new file loads", () => {
  assert.ok(LIBRARY.filter((r) => r.airFryer).length >= 15);
  assert.ok(LIBRARY.filter((r) => r.oven).length >= 10);
  assert.ok(LIBRARY.some((r) => r.file === "air-fryer-and-oven.md" && r.forWhom === "baby"));
  for (const r of LIBRARY.filter((x) => x.airFryer || x.oven)) {
    for (const m of [r.airFryer, r.oven].filter(Boolean)) assert.ok(m.minutes > 0, `${r.title}: method line must start with the time`);
  }
});

test("APPL-05 suggestions lean toward recipes the family's appliances can make", () => {
  const pantry = ["okra", "potato", "onion", "rice", "toor dal", "paneer", "curd", "capsicum"];
  const without = suggestFromLibrary(pantry, { forWhom: "family", mealType: "dinner", limit: 40 });
  const withFryer = suggestFromLibrary(pantry, { forWhom: "family", mealType: "dinner", limit: 40, appliances: ["airFryer"] });
  const rank = (list) => list.findIndex((r) => r.airFryer);
  assert.ok(rank(withFryer) <= rank(without));
  const share = (list) => list.slice(0, 5).filter((r) => r.airFryer).length;
  assert.ok(share(withFryer) >= share(without));
});

test("APPL-06 quick mode counts the air fryer time", () => {
  const okra = LIBRARY.find((r) => r.title.startsWith("Bendakaya vepudu"));
  assert.ok(okra.prepMinutes > 20 && okra.airFryer.minutes <= 20);
  const opt = { forWhom: "family", mealType: "dinner", limit: 60, maxMinutes: 20 };
  const quickIds = (list) => list.filter((r) => fastestMinutes(r, opt.appliances || []) <= 20).map((r) => r.id);
  assert.ok(!quickIds(suggestFromLibrary(["okra"], opt)).includes(okra.id));
  const withFryer = suggestFromLibrary(["okra"], { ...opt, appliances: ["airFryer"] });
  const quick = withFryer.filter((r) => fastestMinutes(r, ["airFryer"]) <= 20);
  assert.ok(quick.some((r) => r.id === okra.id));
  assert.deepEqual(withFryer.slice(0, quick.length), quick, "the recipes ready in 20 minutes come first");
});

test("APPL-07 a two-basket air fryer pairs two dishes, longest first", () => {
  const a = { id: "a", title: "Wedges", airFryer: { text: "20 min at 200°C", minutes: 20, tempC: 200 } };
  const b = { id: "b", title: "Tikka", airFryer: { text: "10 min at 200°C", minutes: 10, tempC: 200 } };
  const c = { id: "c", title: "Dal", prepMinutes: 30 };
  assert.deepEqual(basketPairs([a, b], { airFryer: "single" }), []);
  assert.deepEqual(basketPairs([a], { airFryer: "dual" }), []);
  const [p] = basketPairs([b, c, a, a], { airFryer: "dual" });
  assert.deepEqual(p.baskets.map((x) => x.recipe.id), ["a", "b"]);
  assert.equal(p.minutes, 20);
});

test("APPL-08 the AI is told about the appliances", () => {
  assert.deepEqual(applianceRequest({ airFryer: "dual", oven: true }), ["airFryerDual", "oven"]);
  assert.deepEqual(applianceRequest({ airFryer: "single" }), ["airFryer"]);
  const req = parseRequest({ ingredients: ["okra"], appliances: ["airFryerDual", "oven", "microwave", "oven"] });
  assert.deepEqual(req.appliances, ["airFryerDual", "oven"]);
  const p = buildPrompt(req);
  assert.match(p, /two-basket air fryer/);
  assert.match(p, /conventional oven/);
  assert.match(p, /one in each basket/);
  assert.doesNotMatch(buildPrompt(parseRequest({ ingredients: ["okra"] })), /air fryer|oven/);
  assert.equal(appliancePrompt([]), "");
});
