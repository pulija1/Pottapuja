// Age-safety rules for recipes. Pure functions, shared by the server and the browser.
//
// checkRecipe(recipe, { age: "baby" | "kid", lunchbox }) returns
//   { safe, errors: [{ rule, message, match }], warnings: [{ rule, message, match }] }
// A recipe is "safe" when it has no errors. Warnings are shown but do not block.

const NEGATION = /\b(no|without|skip|omit|avoid|don'?t add|do not add|never add|free of|instead of)\b[^.;,]{0,25}$/i;

// Words that contain "nut" but are not tree nuts or peanuts.
const NOT_NUTS = /\b(coconut|nutmeg|butternut|doughnut|donut|nutrition|nutritious|nutrient|nutrients)\b/gi;

const WHOLE_NUT = /\b(peanuts?|groundnuts?|cashews?|almonds?|walnuts?|pistachios?|hazelnuts?|pecans?|nuts?|kaju|badam|moongphali|pista)\b/i;
const GROUND_FORM = /\b(powder|powdered|ground|paste|butter|flour|meal|finely ground|milk)\b/i;

const RULES = {
  baby: [
    { rule: "honey", level: "error", re: /\bhoney\b/i,
      message: "Honey is not safe under 12 months (infant botulism risk)." },
    { rule: "added-salt", level: "error",
      re: /\b(salt|salted|namak|uppu|rock salt|sea salt|black salt|kala namak)\b/i,
      message: "No added salt under 12 months; a baby's kidneys cannot handle it." },
    { rule: "salty-foods", level: "error",
      re: /\b(pickles?|achaar|papads?|appalam|sambar powder|rasam powder|stock cubes?|bouillon|soy sauce|chips|namkeen|mixture)\b/i,
      message: "Salty or packaged foods are not for babies under 12 months." },
    { rule: "added-sugar", level: "error",
      re: /\b(sugar|jaggery|bellam|gur|sakkarai|syrup|candy|chocolate)\b/i,
      message: "No added sugar or jaggery under 12 months." },
    { rule: "cow-milk-drink", level: "warning",
      re: /\b(cow'?s? milk|whole milk|cow milk)\b/i,
      message: "Cow's milk is fine cooked into food, but not as a main drink before 12 months." },
    { rule: "tea-coffee", level: "error", re: /\b(tea(?!\s*spoon)|coffee|chai|decoction)\b/i,
      message: "No tea or coffee for babies." },
    { rule: "choking-whole", level: "error",
      re: /\b(whole grapes?|grapes?|popcorn|raw carrot|carrot sticks?|whole peas|whole chana|chickpeas whole|cherry tomatoes|pomegranate seeds|raisins?|kismis|dates pieces|hard candy|murukku|chakli|boondi)\b/i,
      message: "Choking hazard for an 8-month-old. Mash, puree or cook until soft." },
    { rule: "spicy", level: "warning",
      re: /\b(green chill?i(es)?|red chill?i(es)?|chill?i powder|mirchi|pepper powder|black pepper|cayenne|garam masala)\b/i,
      message: "Keep baby food mild: leave out chilli and strong spices." },
    { rule: "deep-fried", level: "warning", re: /\b(deep[- ]?fr(y|ied)|vada|bajji|bonda|pakora)\b/i,
      message: "Deep-fried food is hard to digest and can be a choking risk for babies." },
    { rule: "raw-egg", level: "error", re: /\b(raw egg|runny (egg|yolk)|half[- ]boiled|soft[- ]boiled)\b/i,
      message: "Eggs must be fully cooked for babies." },
  ],
  kid: [
    { rule: "whole-grapes", level: "warning", re: /\b(whole grapes?|cherry tomatoes)\b/i,
      message: "Cut grapes and cherry tomatoes lengthwise for a 4-year-old." },
    { rule: "popcorn-hard", level: "warning", re: /\b(popcorn|hard candy)\b/i,
      message: "Popcorn and hard candy are choking risks under 5." },
    { rule: "very-spicy", level: "warning", re: /\b(lots of chill?i|extra spicy|very spicy|ghost pepper)\b/i,
      message: "Keep it mild for a 4-year-old." },
    { rule: "caffeine", level: "warning", re: /\b(coffee|energy drink|cola)\b/i,
      message: "Avoid caffeine for young children." },
  ],
};

const BABY_TEXTURES = ["puree", "mashed", "soft", "porridge", "soft finger food"];

function normaliseText(s) {
  return String(s || "").replace(NOT_NUTS, " ");
}

function ingredientText(ing) {
  if (!ing) return "";
  if (typeof ing === "string") return ing;
  return [ing.name, ing.note].filter(Boolean).join(" ");
}

// True when the match at `index` in `text` is negated ("no salt", "without honey").
function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 40), index);
  return NEGATION.test(before);
}

function findMatch(re, text) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  while ((m = global.exec(text)) !== null) {
    if (!isNegated(text, m.index)) return m;
    if (m[0].length === 0) global.lastIndex++;
  }
  return null;
}

export function checkRecipe(recipe, opts = {}) {
  const age = opts.age === "kid" ? "kid" : "baby";
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const add = (level, rule, message, match) => {
    const key = level + rule;
    if (seen.has(key)) return;
    seen.add(key);
    (level === "error" ? errors : warnings).push({ rule, message, match });
  };

  if (!recipe || typeof recipe !== "object") {
    return { safe: false, errors: [{ rule: "invalid", message: "No recipe given.", match: "" }], warnings };
  }

  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const pieces = [
    recipe.title,
    ...ingredients.map(ingredientText),
    ...steps,
  ].map(normaliseText);

  for (const r of RULES[age]) {
    for (const piece of pieces) {
      const m = findMatch(r.re, piece);
      if (m) { add(r.level, r.rule, r.message, m[0]); break; }
    }
  }

  // Whole nuts for babies: error unless the nut is clearly ground or a paste.
  if (age === "baby") {
    for (const piece of pieces) {
      const m = findMatch(WHOLE_NUT, piece);
      if (m && !GROUND_FORM.test(piece)) {
        add("error", "whole-nuts", "Whole or chopped nuts are a choking hazard for babies. Only finely ground nut powder is OK.", m[0]);
        break;
      }
    }
    const texture = String(recipe.texture || "").toLowerCase();
    if (texture && !BABY_TEXTURES.some((t) => texture.includes(t))) {
      add("warning", "texture", `Texture "${recipe.texture}" may be too firm for 8 months. Aim for mashed or soft.`, recipe.texture);
    }
  }

  if (age === "kid") {
    for (const piece of pieces) {
      const m = findMatch(WHOLE_NUT, piece);
      if (m && !GROUND_FORM.test(piece)) {
        add("warning", "whole-nuts", "Whole nuts are a choking risk under 5. Use chopped or powdered.", m[0]);
        break;
      }
    }
  }

  // Nut-free school (a user setting): no nuts in the lunchbox.
  if (age === "kid" && opts.lunchbox && opts.schoolNutFree) {
    for (const piece of pieces) {
      const m = findMatch(WHOLE_NUT, piece);
      if (m) {
        add("error", "school-nut-free", "School is nut-free: keep nuts out of the lunchbox." + (opts.nutFreeSwap ? " Swap: " + opts.nutFreeSwap : ""), m[0]);
        break;
      }
    }
  }

  return { safe: errors.length === 0, errors, warnings };
}

// True for peanut and tree-nut ingredients (including butters and powders), false for coconut, nutmeg etc.
export function isNutIngredient(name) {
  return WHOLE_NUT.test(normaliseText(name));
}

// A kid's lunchbox or snack-box recipe (these go to school).
export function isSchoolFood(recipe) {
  return String(recipe?.forWhom || "") === "kid" && /lunch\s*box|school|snack/i.test(String(recipe?.mealType || ""));
}

// Which ages a recipe should be checked for.
export function agesFor(recipe) {
  const who = String(recipe?.forWhom || "").toLowerCase();
  if (who === "baby") return ["baby"];
  if (who === "kid" || who === "family") return ["kid"];
  return ["baby", "kid"];
}

// Check a recipe for everyone it is meant for and merge the results.
// opts.schoolNutFree: the family's "school is nut-free" setting (off by default).
export function checkForAudience(recipe, opts = {}) {
  const out = { safe: true, errors: [], warnings: [], byAge: {} };
  for (const age of agesFor(recipe)) {
    const lunchbox = age === "kid" && /lunch\s*box|school|snack/i.test(String(recipe?.mealType || ""));
    const r = checkRecipe(recipe, { age, lunchbox, schoolNutFree: !!opts.schoolNutFree, nutFreeSwap: recipe?.nutFreeSwap });
    out.byAge[age] = r;
    if (!r.safe) out.safe = false;
    out.errors.push(...r.errors.map((e) => ({ ...e, age })));
    out.warnings.push(...r.warnings.map((w) => ({ ...w, age })));
  }
  if (String(recipe?.forWhom || "").toLowerCase() === "family") {
    out.warnings.push({ rule: "baby-portion", age: "baby", match: "",
      message: "Family dish: for the baby, take out a plain portion before adding salt, sugar or spice, and mash it." });
  }
  return out;
}
