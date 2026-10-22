// Built-in South Indian recipes. Used when the AI is unavailable, and to fill gaps in AI results.
// Every baby recipe here must pass checkRecipe(..., { age: "baby" }); the tests enforce that.

import { normName } from "./shopping.js";
import { DATASET_RECIPES } from "./dataset.js";
import { checkForAudience } from "./safety.js";

const r = (id, title, forWhom, mealType, texture, prepMinutes, ingredients, steps, notes = "") => ({
  id: "lib-" + id, title, forWhom, mealType, texture, prepMinutes,
  ingredients: ingredients.map(([name, quantity, unit]) => ({ name, quantity, unit })),
  steps, notes, source: "library",
});

export const LIBRARY = [
  // ---- Baby (8 months): soft, no salt, no sugar, no honey ----
  r("ragi-porridge", "Ragi porridge (ragi kanji)", "baby", "breakfast", "porridge", 10,
    [["ragi flour", 2, "tbsp"], ["water", 1, "cup"], ["banana", 0.5, "pcs"]],
    ["Whisk ragi flour into cold water so there are no lumps.",
     "Cook on low heat, stirring, for 6 to 8 minutes until thick and glossy.",
     "Cool to lukewarm and stir in mashed ripe banana for sweetness."],
    "Iron and calcium rich. Introduce one new food at a time."),
  r("moong-khichdi", "Moong dal khichdi (soft)", "baby", "lunch", "mashed", 25,
    [["rice", 2, "tbsp"], ["moong dal", 1, "tbsp"], ["carrot", 0.25, "pcs"], ["ghee", 0.5, "tsp"], ["turmeric", 1, "pinch"], ["water", 1.5, "cup"]],
    ["Wash rice and moong dal well.",
     "Pressure cook with chopped carrot, a pinch of turmeric and water for 4 to 5 whistles.",
     "Mash well, loosen with warm water, and stir in ghee. No salt."]),
  r("banana-mash", "Mashed banana", "baby", "snack", "mashed", 3,
    [["banana", 1, "pcs"]],
    ["Pick a ripe banana with brown spots.", "Mash with a fork until smooth. Serve right away."]),
  r("idli-dal-mash", "Soft idli mashed with dal water", "baby", "breakfast", "mashed", 5,
    [["idli/dosa batter", 0.5, "cup"], ["moong dal", 1, "tbsp"], ["ghee", 0.25, "tsp"]],
    ["Steam a plain idli from the batter (no salt added to the baby's portion).",
     "Cook moong dal until very soft and keep the dal water.",
     "Mash the idli with dal water and a drop of ghee to a smooth paste."]),
  r("carrot-potato-puree", "Carrot and potato puree", "baby", "lunch", "puree", 15,
    [["carrot", 1, "pcs"], ["potato", 1, "pcs"], ["ghee", 0.25, "tsp"]],
    ["Peel and cube carrot and potato.", "Steam until fork tender, about 10 minutes.",
     "Blend or mash with a little steaming water and ghee until smooth."]),
  r("sweet-potato-mash", "Sweet potato mash (genasu)", "baby", "snack", "mashed", 15,
    [["sweet potato", 1, "pcs"], ["ghee", 0.25, "tsp"]],
    ["Steam the sweet potato until soft.", "Peel and mash with a little ghee and warm water."]),
  r("rava-kanji", "Soft rava porridge", "baby", "breakfast", "porridge", 10,
    [["rava", 2, "tbsp"], ["ghee", 0.5, "tsp"], ["water", 1, "cup"], ["apple", 0.5, "pcs"]],
    ["Roast rava in ghee for 2 minutes on low heat.", "Add water slowly while stirring, cook until soft.",
     "Steam and mash the apple, and stir it in for natural sweetness."]),
  r("curd-rice-mash", "Mashed curd rice", "baby", "lunch", "mashed", 5,
    [["rice", 3, "tbsp"], ["curd", 2, "tbsp"]],
    ["Cook rice until very soft and mash it well.", "Cool to room temperature, then mix in fresh homemade curd. No salt."]),
  r("apple-puree", "Steamed apple puree", "baby", "snack", "puree", 12,
    [["apple", 1, "pcs"]],
    ["Peel, core and chop the apple.", "Steam for 8 to 10 minutes until soft.", "Blend smooth."]),
  r("dal-soup", "Toor dal and vegetable soup", "baby", "dinner", "puree", 20,
    [["toor dal", 1, "tbsp"], ["tomato", 0.5, "pcs"], ["pumpkin", 2, "tbsp"], ["jeera", 1, "pinch"], ["ghee", 0.25, "tsp"]],
    ["Pressure cook dal with tomato, pumpkin and a pinch of jeera.",
     "Blend smooth and strain. Add ghee. No salt."]),
  r("egg-yolk-mash", "Fully cooked egg mashed with rice", "baby", "dinner", "mashed", 15,
    [["egg", 1, "pcs"], ["rice", 2, "tbsp"], ["ghee", 0.25, "tsp"]],
    ["Hard boil the egg for 12 minutes so it is fully cooked.",
     "Mash the egg finely with soft-cooked rice and ghee. Watch for any reaction the first time."]),

  // ---- Kid (4 years, school) ----
  r("lemon-rice", "Lemon rice (nimmakaya pulihora)", "kid", "lunchbox", "", 20,
    [["rice", 1, "cup"], ["lemon", 1, "pcs"], ["turmeric", 0.25, "tsp"], ["mustard seeds", 0.5, "tsp"], ["chana dal", 1, "tsp"], ["curry leaves", 6, "pcs"], ["oil", 1, "tbsp"], ["salt", 0.5, "tsp"]],
    ["Cook rice so the grains stay separate and let it cool.",
     "Heat oil, add mustard seeds, chana dal and curry leaves, then turmeric.",
     "Mix the tempering into the rice with salt and lemon juice."],
    "Mild version: skip green chilli for the lunchbox."),
  r("mini-idli-podi", "Mini idlis with ghee and mild podi", "kid", "lunchbox", "", 20,
    [["idli/dosa batter", 1, "cup"], ["ghee", 1, "tsp"], ["idli podi", 1, "tsp"]],
    ["Steam mini idlis for 10 minutes.", "Toss warm idlis in ghee and a little mild podi."]),
  r("veg-upma", "Vegetable upma", "kid", "breakfast", "", 20,
    [["rava", 0.5, "cup"], ["carrot", 0.5, "pcs"], ["peas", 2, "tbsp"], ["onion", 0.5, "pcs"], ["mustard seeds", 0.5, "tsp"], ["curry leaves", 5, "pcs"], ["ghee", 1, "tsp"], ["salt", 0.25, "tsp"], ["water", 1.5, "cup"]],
    ["Dry roast rava until fragrant.", "Temper mustard seeds and curry leaves in ghee, saute onion, carrot and peas.",
     "Add water and salt, bring to a boil, stir in rava and cook covered for 3 minutes."]),
  r("curd-rice-pomegranate", "Curd rice with pomegranate", "kid", "lunchbox", "", 10,
    [["rice", 0.75, "cup"], ["curd", 0.5, "cup"], ["milk", 2, "tbsp"], ["pomegranate", 2, "tbsp"], ["salt", 0.25, "tsp"]],
    ["Mash cooked rice lightly, mix with curd, a splash of milk (keeps it from souring by lunch) and salt.",
     "Top with pomegranate arils."]),
  r("ragi-dosa", "Ragi dosa with coconut chutney", "kid", "breakfast", "", 20,
    [["ragi flour", 0.5, "cup"], ["rice flour", 2, "tbsp"], ["curd", 2, "tbsp"], ["onion", 0.25, "pcs"], ["coconut", 3, "tbsp"], ["salt", 0.25, "tsp"]],
    ["Mix ragi flour, rice flour, curd, salt and water into a thin batter.",
     "Pour onto a hot tawa, sprinkle chopped onion and cook till crisp.",
     "Grind coconut with a little water and salt for a mild chutney."]),
  r("tomato-rice", "Mild tomato rice", "kid", "lunchbox", "", 25,
    [["rice", 1, "cup"], ["tomato", 2, "pcs"], ["onion", 1, "pcs"], ["ghee", 1, "tbsp"], ["turmeric", 0.25, "tsp"], ["salt", 0.5, "tsp"]],
    ["Saute onion and tomato in ghee until mushy.", "Add turmeric, salt, washed rice and water, and pressure cook for 2 whistles."]),
  r("semiya-upma", "Vegetable semiya upma", "kid", "snack", "", 15,
    [["vermicelli", 0.75, "cup"], ["carrot", 0.5, "pcs"], ["beans", 4, "pcs"], ["ghee", 1, "tsp"], ["salt", 0.25, "tsp"]],
    ["Roast vermicelli in ghee till golden.", "Cook vegetables in water with salt, add vermicelli and cook until dry."]),
  r("ven-pongal", "Ven pongal", "kid", "breakfast", "", 25,
    [["rice", 0.5, "cup"], ["moong dal", 0.25, "cup"], ["ghee", 1, "tbsp"], ["jeera", 0.5, "tsp"], ["ginger", 0.5, "tsp"], ["salt", 0.5, "tsp"]],
    ["Pressure cook rice and moong dal soft.", "Temper jeera and ginger in ghee, pour over and mix with salt.",
     "Use a pinch of crushed pepper only if your child likes it."]),
  r("chapati-potato-roll", "Chapati roll with potato palya", "kid", "lunchbox", "", 25,
    [["atta", 1, "cup"], ["potato", 2, "pcs"], ["onion", 0.5, "pcs"], ["turmeric", 0.25, "tsp"], ["oil", 1, "tbsp"], ["salt", 0.5, "tsp"]],
    ["Make soft chapatis.", "Saute onion, add boiled mashed potato, turmeric and salt.",
     "Spread the palya on a chapati, roll tightly and cut into pinwheels."]),
  r("egg-dosa", "Egg dosa", "kid", "dinner", "", 10,
    [["idli/dosa batter", 0.5, "cup"], ["egg", 1, "pcs"], ["salt", 1, "pinch"]],
    ["Spread a dosa, crack an egg on top and spread it.", "Cook covered until the egg is fully set, then flip briefly."]),

  // ---- Family ----
  r("sambar-rice", "Sambar rice (bisi bele style, mild)", "family", "dinner", "", 40,
    [["rice", 1, "cup"], ["toor dal", 0.5, "cup"], ["tamarind", 1, "tbsp"], ["sambar powder", 1, "tbsp"], ["carrot", 1, "pcs"], ["beans", 6, "pcs"], ["ghee", 1, "tbsp"], ["salt", 1, "tsp"]],
    ["Pressure cook rice and dal together with vegetables.",
     "Add tamarind water, sambar powder and salt and simmer.",
     "Before adding salt and sambar powder, set aside plain rice, dal and vegetables for the baby and mash them."],
    "Not checked for the baby as written: take the baby's portion out before salt and spice."),
];

// Add recipes from the research dataset that we don't already have (by title word overlap).
const STOP = new Set(["and", "with", "the", "of", "soft", "mild", "style", "water"]);
const words = (t) => new Set(t.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).map((w) => w.replace(/(ed|s)$/, "")).filter((w) => w && !STOP.has(w)));
const similar = (a, b) => {
  const A = words(a), B = words(b);
  const common = [...A].filter((w) => B.has(w)).length;
  return common / Math.min(A.size, B.size) >= 0.66;
};
const builtIn = LIBRARY.slice();
for (const d of DATASET_RECIPES) {
  if (!builtIn.some((x) => similar(x.title, d.title))) LIBRARY.push(d);
}

export function libraryById(id) {
  return LIBRARY.find((x) => x.id === id) || null;
}

// Rank library recipes by how many of their ingredients are in the pantry.
// With schoolNutFree, recipes that are not nut-free are left out of lunchbox and snack suggestions.
export function suggestFromLibrary(pantry, { forWhom = "both", mealType = "", limit = 6, schoolNutFree = false } = {}) {
  const have = new Set((pantry || []).map((p) => normName(typeof p === "string" ? p : p.name)));
  const BASICS = new Set(["water", "salt", "oil", "turmeric"]);
  const wanted = forWhom === "both" ? ["baby", "kid", "family"] : [forWhom, "family"];
  return LIBRARY.filter((x) => wanted.includes(x.forWhom))
    .filter((x) => !mealType || x.mealType === mealType || (mealType === "lunch" && x.mealType === "lunchbox"))
    .filter((x) => !schoolNutFree || x.forWhom !== "kid" || checkForAudience(x, { schoolNutFree: true }).safe)
    .map((x) => {
      const needed = x.ingredients.map((i) => normName(i.name)).filter((n) => !BASICS.has(n));
      const hit = needed.filter((n) => have.has(n)).length;
      const score = (needed.length ? hit / needed.length : 0) + (x.familyFavorite ? 0.15 : 0);
      return { recipe: x, score, hit };
    })
    .sort((a, b) => b.score - a.score || b.hit - a.hit)
    .slice(0, limit)
    .map((s) => s.recipe);
}
