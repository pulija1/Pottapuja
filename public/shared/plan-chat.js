// The week-planning chat: Claude plans the week's meals and changes them as the parent talks
// ("no eggs this week", "swap Tuesday dinner"). This module holds the instructions, the answer
// schema, the recipe-book catalog and the per-turn context, and turns Claude's answer into safe
// calendar changes. The browser sends it with the family's own key (ai-browser.js).

import { SLOTS } from "./plan.js";
import { addDays, fromKey, isSchoolDay } from "./dates.js";
import { checkRecipe, isNutIngredient } from "./safety.js";
import { appliancePrompt } from "./appliances.js";
import { SYSTEM as RECIPE_RULES } from "./ai-prompt.js";

export const SLOT_IDS = SLOTS.map((s) => s.id);
// How many days from the start of the week on screen the chat may plan: this week and the next.
export const WINDOW_DAYS = 14;

export const PLAN_RULES = `${RECIPE_RULES}

You are now the family's weekly meal planner, talking with a parent in a chat inside their meal planner app. Each parent message comes with the current plan, the kitchen and the family's settings. Answer with a short, friendly reply and the calendar changes to make.

Meal slots (use these ids):
- baby_breakfast, baby_lunch, baby_snack, baby_dinner: the 8-month-old. Baby recipes only (forWhom baby).
- kid_breakfast: the 4-year-old. A kid breakfast, or a family breakfast that suits a 4-year-old.
- kid_lunchbox: school lunchbox, Monday to Friday only. Never on Saturday or Sunday.
- kid_snack: snack box / after-school snack.
- family_dinner: the whole family. Family dinners only.

How to plan:
- Prefer recipes from the recipe book: give their ref (like r12, or s3 for the family's saved recipes) and their exact title. Prefer ones that use what is in the kitchen and the freezer, then the family's cuisines and favourites.
- Only when nothing in the book fits, make up a dish: leave ref empty and give its ingredients (with quantities), short steps and notes, following the age rules above.
- School days (Monday to Friday) are busy mornings: breakfasts are warm and made the night before, then reheated in the microwave (upma, idli, parathas, egg burritos), with an easy side dip, or need no cooking. Recipe-book lines marked "make-ahead" or "no-cook" are made for this.
- If the school is nut-free, the lunchbox and the snack box never contain peanuts or tree nuts.
- Each day, the 4-year-old should get an egg, a milk food and some nuts across breakfast, lunchbox, snack and family dinner (lines are tagged egg, dairy, nuts), unless the parent says otherwise.
- Don't serve the same dish two days running. A family curry can come back the next day as a leftover makeover.
- Use the air fryer or oven when the family has one and it makes the dish easier.
- Remember what the parent asked earlier in the chat (for example "no eggs this week") and keep to it in later changes.
- "This week" means the days of the week on screen from today on. Only change dates in the planning window, never days before today.
- Fill empty slots freely. Change a meal that is already planned only when the parent asks for it. Leave days marked "approved" alone unless the parent asks to change them.
- To clear a slot, give ref "" and title "".
- If the parent only asks a question, answer it and make no changes.
- In the reply, say in a sentence or two what you planned or changed, and anything to buy. Don't list every meal: the app shows the changes.`;

const str = { type: "string" };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const PLAN_CHAT_SCHEMA = obj({
  reply: str,
  changes: {
    type: "array",
    items: obj({
      date: { type: "string", description: "YYYY-MM-DD" },
      slot: { type: "string", enum: SLOT_IDS },
      ref: { type: "string", description: "Recipe-book ref such as r12 or s3, or empty for a new dish" },
      title: str,
      ingredients: { type: "array", items: obj({ name: str, quantity: { type: "number" }, unit: str }) },
      steps: { type: "array", items: str },
      notes: str,
    }),
  },
});

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (key) => DAY_NAMES[fromKey(key).getDay()];

// One line per recipe: ref, who and meal, title, minutes, cuisine, tags and key ingredients.
function catalogLine(ref, r) {
  const main = (r.ingredients || []).map((i) => i.name).filter((n) => !/^(water|salt|oil|turmeric)$/i.test(n)).slice(0, 8);
  const flags = [
    r.prepMinutes ? `${r.prepMinutes} min` : "",
    r.cuisine || "",
    (r.tags || []).join(","),
    r.busyMorning || "",
    r.reheat ? "reheats" : "",
    r.familyFavorite ? "favourite" : "",
    (r.ingredients || []).some((i) => isNutIngredient(i.name)) ? "has nuts" : "",
    r.leftover ? "leftover makeover" : "",
  ].filter(Boolean);
  return `${ref} | ${r.forWhom} ${r.mealType} | ${r.title} | ${flags.join(" · ")} | ${main.join(", ")}`;
}

// The recipe book, as one block that stays the same between turns (so it can be cached).
// Side dips are left out: they go with a breakfast, not in a slot of their own.
export function libraryRefs(library) {
  const refs = new Map();
  library.forEach((r, i) => { if (r.mealType !== "side") refs.set(`r${i}`, r); });
  return refs;
}
export function catalogText(library) {
  return `The family's recipe book (ref | for whom and meal | title | details | key ingredients):\n` +
    [...libraryRefs(library)].map(([ref, r]) => catalogLine(ref, r)).join("\n");
}

export function savedRefs(saved) {
  return new Map((saved || []).map((r, i) => [`s${i}`, r]));
}

// The dates the chat may plan: from today (or the start of the week on screen) for WINDOW_DAYS from that week's Sunday.
export function planWindow(selected, today) {
  const sunday = addDays(selected, -fromKey(selected).getDay());
  const dates = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const k = addDays(sunday, i);
    if (k >= today) dates.push(k);
  }
  return { dates, weekStart: sunday, weekEnd: addDays(sunday, 6) };
}

// Everything Claude needs to know this turn, written as plain text before the parent's words.
export function contextText({ today, window, days = {}, refOf = () => "", pantry = [], frozen = [], cuisines = [], appliances = [], schoolNutFree = false, cookable = [], saved = [] }) {
  const lines = [];
  lines.push(`Today is ${dayName(today)} ${today}. The week on screen is ${window.weekStart} to ${window.weekEnd}. Planning window: ${window.dates[0]} to ${window.dates.at(-1)}.`);
  lines.push("", "Current plan:");
  for (const k of window.dates) {
    const day = days[k];
    const slots = SLOTS.filter((s) => !s.schoolOnly || isSchoolDay(k));
    const planned = slots.filter((s) => day?.meals?.[s.id]?.title).map((s) => {
      const m = day.meals[s.id];
      const ref = refOf(m);
      return `${s.id}=${m.title}${ref ? ` (${ref})` : ""}`;
    });
    const empty = slots.filter((s) => !day?.meals?.[s.id]?.title).map((s) => s.id);
    lines.push(`${k} ${dayName(k)}${isSchoolDay(k) ? " school day" : " weekend"}${day?.status === "approved" ? " [approved]" : ""}: ${planned.join("; ") || "nothing planned"}${empty.length && planned.length ? ` | empty: ${empty.join(", ")}` : ""}`);
  }
  lines.push("", `In the kitchen: ${pantry.join(", ") || "(nothing listed)"}`);
  const cold = frozen.map((f) => f.name || f).filter(Boolean);
  lines.push(`In the freezer: ${cold.join(", ") || "(nothing)"}`);
  if (cookable.length) lines.push(`Recipe-book recipes that can be cooked from the kitchen and freezer now: ${cookable.join(", ")}`);
  lines.push(`Cuisines the family cooks most: ${cuisines.join(", ") || "any"}`);
  const app = appliancePrompt(appliances);
  if (app) lines.push(app);
  lines.push(schoolNutFree ? "The school is nut-free." : "The school allows nuts.");
  if (saved.length) {
    lines.push("", "The family's saved recipes:");
    for (const [ref, r] of saved) lines.push(catalogLine(ref, r));
  }
  return lines.join("\n");
}

export function userTurn(context, text) {
  return `<plan_and_kitchen>\n${context}\n</plan_and_kitchen>\n\nParent: ${String(text || "").slice(0, 1000)}`;
}

// Turn Claude's changes into ones the app can apply. Each change must be in the planning window,
// in a slot that exists that day, and pass the age and nut-free checks for that slot.
//   refs: Map of "r12"/"s3" -> recipe. Returns { apply: [{ date, slot, recipe | null, isNew }], skipped: [{ date, slot, title, why }] }.
export function planChanges(changes, { dates, refs, schoolNutFree = false, stamp = Date.now().toString(36) }) {
  const inWindow = new Set(dates);
  const apply = [];
  const skipped = [];
  const seen = new Set();
  (Array.isArray(changes) ? changes : []).forEach((c, i) => {
    const slot = SLOTS.find((s) => s.id === c?.slot);
    const title = String(c?.title || "").trim().slice(0, 120);
    const skip = (why) => skipped.push({ date: c?.date, slot: c?.slot, title, why });
    if (!slot) return skip("unknown meal");
    if (!inWindow.has(c.date)) return skip("outside the days being planned");
    if (slot.schoolOnly && !isSchoolDay(c.date)) return skip("no lunchbox on weekends");
    const key = `${c.date}/${slot.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!title && !c.ref) return apply.push({ date: c.date, slot: slot.id, recipe: null, isNew: false });

    let recipe = c.ref ? refs.get(String(c.ref).trim()) : null;
    let isNew = false;
    if (!recipe) {
      if (!title) return skip("unknown recipe");
      const ingredients = (Array.isArray(c.ingredients) ? c.ingredients : []).slice(0, 40)
        .map((x) => ({ name: String(x?.name || "").trim().slice(0, 60), quantity: Number.isFinite(x?.quantity) ? x.quantity : null, unit: String(x?.unit || "").slice(0, 12) }))
        .filter((x) => x.name);
      const steps = (Array.isArray(c.steps) ? c.steps : []).map((s) => String(s || "").slice(0, 400)).filter(Boolean).slice(0, 20);
      // Claude named a book recipe without its ref: use the book's own.
      const byTitle = [...refs.values()].find((r) => r.title.toLowerCase() === title.toLowerCase());
      if (byTitle) recipe = byTitle;
      else {
        if (!ingredients.length) return skip("no ingredients given");
        recipe = { id: `plan-${stamp}-${i}`, title, forWhom: slot.who, mealType: slot.id.split("_")[1], texture: "", prepMinutes: 0, ingredients, steps, notes: String(c.notes || "").slice(0, 400), source: "ai" };
        isNew = true;
      }
    }
    if (slot.who === "baby" && recipe.forWhom !== "baby") return skip("not a baby recipe");
    if (slot.who === "family" && recipe.forWhom === "baby") return skip("a baby recipe, not a family dinner");
    if (slot.who === "kid" && recipe.forWhom === "baby") return skip("a baby recipe");
    if (slot.who !== "family") {
      const res = checkRecipe(recipe, { age: slot.who, lunchbox: slot.id === "kid_lunchbox" || slot.id === "kid_snack", schoolNutFree, nutFreeSwap: recipe.nutFreeSwap });
      if (!res.safe) return skip(res.errors[0].message);
    }
    apply.push({ date: c.date, slot: slot.id, recipe, isNew });
  });
  return { apply, skipped };
}
