import { test } from "node:test";
import assert from "node:assert/strict";
import { foodArt, TONES } from "../public/shared/food-art.js";
import { LIBRARY } from "../public/shared/recipes.js";

test("dishes get a picture that matches the dish, not an ingredient in its name", () => {
  assert.equal(foodArt("Egg dosa").emoji, "🥞");
  assert.equal(foodArt("Ragi porridge").emoji, "🥣");
  assert.equal(foodArt("Sweet potato mash").emoji, "🥣");
  assert.equal(foodArt("Bendakaya fry").emoji, "🥘");
  assert.equal(foodArt("Tomato pappu").emoji, "🍛");
  assert.equal(foodArt("Roti quesadilla").emoji, "🌮");
});

test("grocery and kitchen items get their own picture", () => {
  assert.equal(foodArt("bananas").emoji, "🍌");
  assert.equal(foodArt("Palakura (spinach)").emoji, "🥬");
  assert.equal(foodArt("curry leaves").emoji, "🌿");
  assert.equal(foodArt("sweet potato").emoji, "🍠");
  assert.equal(foodArt("potato").emoji, "🥔");
  assert.equal(foodArt("toor dal").emoji, "🍛");
});

test("unknown names fall back to the meal, and the colour is stable", () => {
  assert.equal(foodArt({ title: "Grandma's special", mealType: "lunchbox" }).emoji, "🍱");
  assert.equal(foodArt("zzz").emoji, "🍽️");
  assert.equal(foodArt("okra").tone, foodArt("okra").tone);
  assert.ok(foodArt("okra").tone >= 0 && foodArt("okra").tone < TONES);
  assert.deepEqual(foodArt(null), { emoji: "🍽️", tone: foodArt("").tone });
});

test("most recipes in the family book get a picture of the dish", () => {
  const named = LIBRARY.filter((r) => foodArt({ title: r.title }).emoji !== "🍽️");
  assert.ok(named.length / LIBRARY.length > 0.85, `${named.length} of ${LIBRARY.length}: ${LIBRARY.filter((r) => foodArt({ title: r.title }).emoji === "🍽️").map((r) => r.title).slice(0, 30).join(", ")}`);
});
