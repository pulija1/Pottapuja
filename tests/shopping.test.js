// Shopping list merging and grouping (SHOP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeItems, normName, aisleFor, missingFromPantry, groupByAisle, formatQty } from "../public/shared/shopping.js";

const item = (name, quantity, unit, extra = {}) => ({ name, quantity, unit, ...extra });

test("SHOP-01 only items missing from the pantry are needed", () => {
  const r = { ingredients: [item("toor dal", 100, "g"), item("tamarind", 20, "g"), item("salt", 1, "tsp")] };
  assert.deepEqual(missingFromPantry(r, ["Thuvaram paruppu"]).map((i) => i.name), ["tamarind"]);
});

test("SHOP-02 the same ingredient from two recipes is summed", () => {
  const out = mergeItems([item("toor dal", 200, "g"), item("Tuvar dal", 150, "gms")]);
  assert.equal(out.length, 1);
  assert.equal(formatQty(out[0]), "350 g");
});

test("SHOP-02b grams and kilos merge into kilos", () => {
  const out = mergeItems([item("rice", 500, "g"), item("rice", 1, "kg")]);
  assert.equal(formatQty(out[0]), "1.5 kg");
});

test("SHOP-02c merging into an item that had no quantity still converts to kg", () => {
  const out = mergeItems([item("rice", null, "g"), item("rice", 1500, "g")]);
  assert.equal(out.length, 1);
  assert.equal(formatQty(out[0]), "1.5 kg");
});

test("SHOP-03 cups and grams stay separate lines", () => {
  const out = mergeItems([item("rice", 1, "cup"), item("rice", 200, "g")]);
  assert.equal(out.length, 2);
});

test("SHOP-03b bunches, dozens and pieces", () => {
  assert.equal(formatQty(mergeItems([item("eggs", 1, "dozen"), item("egg", 6, "")])[0]), "18 pcs");
  assert.equal(formatQty(mergeItems([item("curry leaves", 1, "bunch"), item("karivepaku", 1, "bunch")])[0]), "2 bunch");
});

test("SHOP-04 aisles for common South Indian groceries", () => {
  const cases = {
    "toor dal": "Rice, dals & flours", "curry leaves": "Vegetables", "drumstick": "Vegetables",
    "curd": "Dairy & eggs", "tamarind": "Spices & tempering", "mustard seeds": "Spices & tempering",
    "banana": "Fruits", "raw banana": "Vegetables", "cashews": "Oil, nuts & dry fruits",
    "diapers": "Baby care", "green chilli": "Vegetables",
  };
  for (const [n, a] of Object.entries(cases)) assert.equal(aisleFor(n), a, n);
});

test("SHOP-04b spice powders go to spices, not vegetables", () => {
  assert.equal(aisleFor("red chilli powder"), "Spices & tempering");
  assert.equal(aisleFor("chilli powder"), "Spices & tempering");
  assert.equal(aisleFor("coriander powder"), "Spices & tempering");
});

test("SHOP-04c plural vegetables with a describing word are still vegetables", () => {
  for (const n of ["small onions", "cherry tomatoes", "baby potatoes", "green beans"]) assert.equal(aisleFor(n), "Vegetables", n);
});

test("SHOP-04d look-alike words don't land in the wrong aisle", () => {
  assert.equal(aisleFor("pearl millet"), "Rice, dals & flours");
  assert.equal(aisleFor("baby corn"), "Vegetables");
  assert.equal(aisleFor("eggplant"), "Vegetables");
});

test("SHOP-05 bought state merges: one unbought line keeps the item on the list", () => {
  const out = mergeItems([item("ghee", 100, "g", { bought: true }), item("ghee", 100, "g", { bought: false })]);
  assert.equal(out[0].bought, false);
});

test("SHOP-06 blank and junk rows are dropped, not crashed on", () => {
  assert.deepEqual(mergeItems([null, {}, item("  ", 1, "g"), item("x", "abc", "g")]).map((i) => i.name), ["x"]);
  assert.deepEqual(mergeItems(undefined), []);
});

test("SHOP-09 grouping an empty list gives no groups", () => {
  assert.deepEqual(groupByAisle([]), []);
});

test("SHOP-10 synonyms in Telugu, Tamil and Hindi", () => {
  assert.equal(normName("Pesara Pappu"), "moong dal");
  assert.equal(normName("thayir"), "curd");
  assert.equal(normName("sooji"), "rava");
  assert.equal(normName("Potatoes"), "potato");
});
