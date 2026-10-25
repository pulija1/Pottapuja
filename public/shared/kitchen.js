// What's in the kitchen, sorted into the groups the Recipes tab shows (vegetables, fruits, dips,
// bread, snacks, ...), and the fruits that are safe for the baby. Pure functions, no I/O here.

import { normName, aisleFor } from "./shopping.js";

const words = (list) => new RegExp(`\\b(?:${list.join("|")})(?:s|es)?\\b`);

// Checked in this order, first match wins, before the shopping aisles fill in the rest.
const RULES = [
  ["dips", words(["peanut butter", "almond butter", "nut butter", "sunflower seed butter", "hummus", "chutney", "salsa", "guacamole", "jam", "nutella", "mayo", "mayonnaise", "ketchup", "cream cheese", "dip", "spread", "pesto", "tahini", "podi", "pickle", "sauce", "honey"])],
  ["bread", words(["bread", "pav", "pav bun", "bun", "pita", "naan", "tortilla", "chapati", "roti", "paratha", "thepla", "bagel", "english muffin", "croissant", "wrap", "kulcha", "phulka"])],
  ["snacks", words(["chip", "crisp", "biscuit", "cracker", "cookie", "granola", "granola bar", "puff", "makhana", "murukku", "chakli", "mixture", "namkeen", "popcorn", "cereal", "cornflake", "rusk", "khakhra", "pretzel", "wafer", "cake", "muffin", "chikki", "ladoo", "laddu"])],
  ["fruits", words(["banana", "apple", "pear", "papaya", "mango", "chikoo", "chiku", "sapota", "grape", "pomegranate", "orange", "avocado", "guava", "watermelon", "melon", "muskmelon", "berry", "berries", "blueberry", "strawberry", "raspberry", "plum", "kiwi", "pineapple", "peach", "apricot", "cherry", "custard apple", "sitaphal", "jackfruit", "lychee", "fig", "tangerine", "mandarin", "clementine"])],
];

// Shopping aisle -> kitchen group, for everything the rules above don't catch.
const FROM_AISLE = {
  "Vegetables": "vegetables", "Fruits": "fruits", "Dairy & eggs": "dairy", "Rice, dals & flours": "grains",
  "Spices & tempering": "spices", "Oil, nuts & dry fruits": "nuts", "Baby care": "other", "School & household": "other", "Other": "other",
};

export const KITCHEN_GROUPS = [
  { id: "vegetables", label: "Vegetables", icon: "🥕" },
  { id: "fruits", label: "Fruits", icon: "🍎" },
  { id: "dips", label: "Dips & spreads", icon: "🥜" },
  { id: "bread", label: "Bread & wraps", icon: "🍞" },
  { id: "snacks", label: "Snacks", icon: "🍪" },
  { id: "dairy", label: "Milk, curd & eggs", icon: "🥛" },
  { id: "grains", label: "Rice, dals & flours", icon: "🍚" },
  { id: "nuts", label: "Nuts, oil & dry fruits", icon: "🌰" },
  { id: "spices", label: "Spices & tempering", icon: "🧂" },
  { id: "other", label: "Other", icon: "🧺" },
];

export function kitchenGroupFor(name) {
  const n = normName(name);
  if (!n) return "other";
  // "Raw banana" and "raw mango" are cooked as vegetables.
  if (/\braw (banana|mango|papaya|jackfruit)\b/.test(n)) return "vegetables";
  if (/\b(almond|nut|seed) (powder|flour)\b/.test(n)) return "nuts";
  if (/\bbaby cereal\b/.test(n)) return "grains";
  for (const [id, re] of RULES) if (re.test(n)) return id;
  return FROM_AISLE[aisleFor(n)] || "other";
}

// The kitchen list in its groups, in KITCHEN_GROUPS order, empty groups left out.
export function groupKitchen(pantry) {
  const by = new Map(KITCHEN_GROUPS.map((g) => [g.id, []]));
  for (const p of pantry || []) {
    const name = typeof p === "string" ? p : p?.name;
    if (String(name || "").trim()) by.get(kitchenGroupFor(name)).push(name);
  }
  return KITCHEN_GROUPS.map((g) => ({ ...g, items: by.get(g.id) })).filter((g) => g.items.length);
}

export const isFruit = (name) => kitchenGroupFor(name) === "fruits";

// Fruits for an 8-month-old and how to give them: soft and ripe, mashed or steamed.
// Fruits not on this list (pomegranate seeds, whole grapes, guava with its hard seeds) are left out.
export const BABY_FRUITS = [
  { name: "banana", how: "ripe banana, mashed" },
  { name: "avocado", how: "ripe avocado, mashed" },
  { name: "papaya", how: "ripe papaya, seeds out, mashed" },
  { name: "mango", how: "ripe mango, mashed" },
  { name: "chikoo", how: "ripe chikoo, every seed out, mashed" },
  { name: "pear", how: "ripe pear, peeled and mashed (steam it if it's firm)" },
  { name: "apple", how: "apple, peeled, steamed soft and mashed" },
  { name: "peach", how: "ripe peach, peeled and mashed" },
  { name: "plum", how: "ripe plum, peeled and mashed" },
  { name: "kiwi", how: "ripe kiwi, mashed" },
  { name: "watermelon", how: "seedless watermelon, mashed" },
  { name: "strawberry", how: "strawberries, mashed" },
  { name: "blueberry", how: "blueberries, squashed flat or mashed" },
  { name: "grapes", how: "grapes, quartered lengthwise and squashed" },
  { name: "orange", how: "orange segments, membrane off, in small soft pieces" },
];
const BABY_FRUIT_BY_NAME = new Map(BABY_FRUITS.map((f) => [normName(f.name), f]));

const babyFruit = (name) => {
  const n = normName(name);
  return BABY_FRUIT_BY_NAME.get(n) || BABY_FRUIT_BY_NAME.get(n.replace(/s$/, "")) || null;
};

// True when a recipe already has a fruit the baby can have.
export function recipeHasFruit(recipe) {
  return (recipe?.ingredients || []).some((i) => isFruit(i.name) && babyFruit(i.name));
}

// A fruit for the baby's breakfast: one from the kitchen when there is one (rotating with `seed`),
// otherwise a ripe banana, which is the easiest to have on hand.
export function babyFruitFor(pantry, seed = 0) {
  const have = [];
  for (const p of pantry || []) {
    const f = babyFruit(typeof p === "string" ? p : p?.name);
    if (f && !have.includes(f)) have.push(f);
  }
  if (!have.length) return { ...BABY_FRUITS[0], inKitchen: false };
  return { ...have[Math.abs(seed) % have.length], inKitchen: true };
}
