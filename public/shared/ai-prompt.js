// The recipe AI's instructions, request cleaning, answer schema and safety screening. Shared by
// the server (lib/ai.js) and the browser (ai-browser.js), so both ask Claude the same way and
// drop the same unsafe answers.

import { checkForAudience } from "./safety.js";
import { appliancePrompt } from "./appliances.js";

export const MODEL = "claude-opus-5-5";

export const SYSTEM = `You plan meals for a South Indian family (Telugu, Tamil, Kannada and Kerala home cooking) with an 8-month-old baby and a 4-year-old who goes to school.

Write practical home recipes that use the ingredients the family already has, adding as few extra ingredients as possible. When the parent lists food that runs out soon, build the recipes around it first. Freezer food keeps for months, so use it only when it helps. The pantry staples the parent lists are always at home: use them freely and never count them as extra ingredients.

Rules for the 8-month-old (forWhom "baby"):
- No salt, no sugar or jaggery, and never honey.
- No whole or chopped nuts; finely ground nut powder only.
- Texture must be puree, mashed, porridge or soft finger food. Nothing hard, round or chewy.
- Mild: no chilli, pepper or garam masala. A pinch of turmeric, jeera or hing is fine.
- Eggs fully cooked. No tea, coffee, pickles, papad or packaged foods.

Rules for the 4-year-old (forWhom "kid"):
- Mild spice. No whole nuts. Cut grapes lengthwise.
- Lunchbox recipes must travel well for 4 hours unrefrigerated and be easy to eat with fingers or a spoon.
- If the parent says the school is nut-free, lunchbox and snack recipes must contain no peanuts or tree nuts (seed butters are fine).

Family recipes (forWhom "family") should say in the notes how to take out a plain baby portion before salt and spice go in.

Telugu dishes and vegetables go by their Telugu names with the English in brackets, for example "Vankaya kura (brinjal curry)" or "sorakaya (bottle gourd)". The family's kitchen list may use either name.

Use quantities as numbers and short units (g, kg, ml, cup, tbsp, tsp, pcs, pinch). Keep steps short and clear.`;

export const FOR_WHOM = ["baby", "kid", "family"];
export const MEAL_TYPES = ["breakfast", "lunch", "lunchbox", "snack", "dinner"];

const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

// JSON schema for Claude's structured output (the server's zod schema has the same shape).
export const RECIPE_LIST_SCHEMA = obj({
  recipes: {
    type: "array",
    items: obj({
      title: { type: "string" },
      forWhom: { type: "string", enum: FOR_WHOM },
      mealType: { type: "string", enum: MEAL_TYPES },
      texture: { type: "string" },
      prepMinutes: { type: "number" },
      ingredients: { type: "array", items: obj({ name: { type: "string" }, quantity: { type: "number" }, unit: { type: "string" } }) },
      steps: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    }),
  },
});

export const QUICK_MINUTES = 20;

export function buildPrompt({ ingredients, forWhom, mealType, notes, count, schoolNutFree, quick, appliances = [], useSoon = [], staples = [] }) {
  const who = forWhom === "both" ? "the baby and the 4-year-old (mix of both)" : forWhom === "baby" ? "the 8-month-old baby" : forWhom === "kid" ? "the 4-year-old" : "the whole family";
  return [
    `Ingredients we have: ${ingredients.join(", ") || "(nothing listed, suggest staples)"}.`,
    useSoon.length ? `Use these first, they run out soon: ${useSoon.join(", ")}.` : "",
    staples.length ? `Pantry staples always at home: ${staples.join(", ")}.` : "",
    `Suggest ${count} recipe${count === 1 ? "" : "s"} for ${who}.`,
    mealType ? `Meal: ${mealType}.` : "",
    quick ? `It must be quick: ready in ${QUICK_MINUTES} minutes or less, with few ingredients and short steps.` : "",
    schoolNutFree ? "The school is nut-free." : "",
    appliancePrompt(appliances),
    notes ? `Extra notes from the parent: ${notes}` : "",
  ].filter(Boolean).join("\n");
}

// Clean and bound the request body.
export function parseRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const list = Array.isArray(b.ingredients) ? b.ingredients : [];
  const ingredients = list
    .map((s) => String(s ?? "").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 60);
  const forWhom = ["baby", "kid", "family", "both"].includes(b.forWhom) ? b.forWhom : "both";
  const mealType = ["breakfast", "lunch", "lunchbox", "snack", "dinner", ""].includes(b.mealType ?? "") ? (b.mealType ?? "") : "";
  const notes = String(b.notes ?? "").slice(0, 300);
  const quick = b.quick === true;
  const count = quick ? 1 : Math.min(6, Math.max(1, Number.parseInt(b.count, 10) || 4));
  const schoolNutFree = b.schoolNutFree === true;
  const appliances = [...new Set((Array.isArray(b.appliances) ? b.appliances : []).filter((a) => ["airFryer", "airFryerDual", "oven"].includes(a)))];
  const names = (v, max) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s ?? "").trim().slice(0, 60)).filter(Boolean))].slice(0, max);
  // "okra (2 days left)" is fine: the AI reads it as text.
  const useSoon = names(b.useSoon, 20);
  const staples = names(b.staples, 40);
  return { ingredients, forWhom, mealType, notes, count, schoolNutFree, quick, appliances, useSoon, staples };
}

// Attach safety results; drop recipes that fail the age rules.
export function screen(recipes, opts = {}) {
  const kept = [];
  const rejected = [];
  for (const r of recipes) {
    const safety = checkForAudience(r, opts);
    if (safety.safe) kept.push({ ...r, safety });
    else rejected.push({ title: r.title, forWhom: r.forWhom, errors: safety.errors });
  }
  return { kept, rejected };
}
