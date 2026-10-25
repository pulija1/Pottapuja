// Each child's needs, set in 👤 Profile under their name: a gassy tummy, iron-fortified cereal,
// no egg yet, and so on, plus a free-text note. Suggestions follow them, and the AI is told.
// Pure functions, no I/O here.
//
// settings.prefs = { baby: { tags: ["gassy", "ironCereal"], note: "" }, kid: { tags: [], note: "" } }

const word = (list) => new RegExp(`\\b(?:${list.join("|")})(?:s|es)?\\b`, "i");

// Foods that commonly give a baby gas, held back while the tummy is gassy.
const GASSY = word(["cabbage", "cauliflower", "broccoli", "brussels sprout", "rajma", "kidney bean", "black bean", "pinto bean", "chana", "chickpea", "chole", "kabuli chana", "whole moong", "green moong", "sprout", "radish", "mullangi"]);
// Gentle on the tummy: a little lift.
const GENTLE = word(["moong dal", "rice", "banana", "papaya", "pear", "pumpkin", "bottle gourd", "sorakaya", "carrot", "jeera", "cumin", "hing", "ajwain", "curd", "ragi", "baby cereal", "apple"]);
const EGG = /\beggs?\b/i;
const DAIRY = /\b(milk|curd|yogh?urt|dahi|paneer|cheese|cheddar|mozzarella|butter|buttermilk|cream|ghee|khoa|ricotta|raita|lassi|kheer|payasam)\b/i;
const NOT_DAIRY = /\b(coconut|almond|oat|soy|rice|cashew|peanut)\s+(milk|cream|butter)\b|\bpeanut butter\b|\bnut butter\b/i;
const MEAT = word(["chicken", "mutton", "lamb", "goat", "beef", "pork", "fish", "prawn", "shrimp", "kodi", "chepala", "keema", "bacon", "ham", "sausage", "tuna", "salmon"]);
const IRON = word(["baby cereal", "ragi", "spinach", "palak", "palakura", "methi", "moong dal", "masoor", "toor dal", "rajma", "chana", "egg", "jaggery", "dates", "beetroot", "amaranth", "thotakura", "poha", "chicken", "mutton"]);

// The options in Profile, per child. `hard` ones leave a recipe out; the others steer the ranking.
export const PREF_OPTIONS = {
  baby: [
    { id: "gassy", label: "Gassy tummy", hint: "holds back cabbage, cauliflower, broccoli, whole beans and chana; leans to moong dal, rice, banana, pear, jeera", ai: "has a gassy tummy: avoid cabbage, cauliflower, broccoli, whole beans, chana and rajma; prefer moong dal, rice, ripe banana, papaya, pear, pumpkin and bottle gourd, with a pinch of roasted jeera or hing" },
    { id: "ironCereal", label: "Iron-fortified cereal", hint: "breakfast leans to iron-fortified baby cereal", ai: "eats iron-fortified baby cereal: use it at breakfast (mixed with water, breast milk or formula, with mashed fruit) and in porridges" },
    { id: "noEgg", label: "No egg yet", hard: true, ai: "doesn't eat egg yet: no egg at all" },
    { id: "noDairy", label: "No milk or curd", hard: true, ai: "has no cow's milk, curd, paneer or cheese" },
    { id: "constipation", label: "Gets constipated", hint: "leans to pear, papaya, prune and ragi; less banana and rice", ai: "gets constipated: prefer pear, papaya, prunes, ragi and more water; go easy on banana and rice" },
  ],
  kid: [
    { id: "noEgg", label: "No egg", hard: true, ai: "doesn't eat egg" },
    { id: "noDairy", label: "No milk or dairy", hard: true, ai: "has no milk, curd, paneer, cheese or butter" },
    { id: "vegetarian", label: "Vegetarian (no meat or fish)", hard: true, ai: "is vegetarian: no meat or fish" },
    { id: "picky", label: "Picky eater", hint: "favourites and simple, familiar food first", ai: "is a picky eater: simple, familiar food, mild, vegetables hidden in" },
    { id: "moreIron", label: "Needs more iron", hint: "leans to ragi, greens, dal, egg and dates", ai: "needs more iron: use ragi, spinach and other greens, dals, egg and dates, with some vitamin C" },
  ],
};

const names = (r) => (r?.ingredients || []).map((i) => String(typeof i === "string" ? i : i?.name || ""));
const has = (r, re) => names(r).some((n) => re.test(n));
const hasDairy = (r) => names(r).some((n) => DAIRY.test(n) && !NOT_DAIRY.test(n));

// The child's prefs from settings: { tags: Set, note }.
export function prefsFor(settings, who) {
  const p = settings?.prefs?.[who];
  const allowed = new Set((PREF_OPTIONS[who] || []).map((o) => o.id));
  return { tags: new Set((Array.isArray(p?.tags) ? p.tags : []).filter((t) => allowed.has(t))), note: String(p?.note || "").trim().slice(0, 200) };
}

// Why a recipe doesn't suit this child, or "" when it does. Only the hard rules (and, for a
// gassy baby, the foods that cause the most gas) leave a recipe out.
export function prefProblem(recipe, who, settings) {
  if (who !== "baby" && who !== "kid") return "";
  const { tags } = prefsFor(settings, who);
  if (!tags.size) return "";
  if (tags.has("noEgg") && has(recipe, EGG)) return "has egg";
  if (tags.has("noDairy") && hasDairy(recipe)) return "has milk or dairy";
  if (tags.has("vegetarian") && has(recipe, MEAT)) return "has meat or fish";
  if (who === "baby" && tags.has("gassy") && has(recipe, GASSY)) return "can give the baby gas";
  return "";
}

// A small lift (0 to about 1.5) for recipes that suit the child's needs.
export function prefBoost(recipe, who, settings, { mealType = "" } = {}) {
  if (who !== "baby" && who !== "kid") return 0;
  const { tags } = prefsFor(settings, who);
  if (!tags.size) return 0;
  let b = 0;
  if (tags.has("gassy") && has(recipe, GENTLE)) b += 0.3;
  if (tags.has("ironCereal") && has(recipe, /baby cereal/i)) b += mealType === "breakfast" || recipe.mealType === "breakfast" ? 1.5 : 0.5;
  if (tags.has("constipation")) b += has(recipe, /\b(pear|papaya|prune|ragi|apple)\b/i) ? 0.3 : has(recipe, /\b(banana|rice)\b/i) ? -0.2 : 0;
  if (tags.has("moreIron") && has(recipe, IRON)) b += 0.3;
  if (tags.has("picky")) b += (recipe.familyFavorite ? 0.3 : 0) + ((recipe.ingredients || []).length <= 6 ? 0.2 : 0);
  return b;
}

// One line per child for the AI, or "" when nothing is set: "The 8-month-old has a gassy tummy: ...".
export function prefsPrompt(settings) {
  const lines = [];
  for (const [who, label] of [["baby", "The 8-month-old"], ["kid", "The 4-year-old"]]) {
    const { tags, note } = prefsFor(settings, who);
    const parts = PREF_OPTIONS[who].filter((o) => tags.has(o.id)).map((o) => o.ai);
    if (note) parts.push(`the parent says: "${note}"`);
    if (parts.length) lines.push(`${label} ${parts.join("; ")}.`);
  }
  return lines.join("\n");
}

// Ingredients a child's needs say are always at home (the baby's iron-fortified cereal).
export function prefStaples(settings) {
  return prefsFor(settings, "baby").tags.has("ironCereal") ? ["iron-fortified baby cereal"] : [];
}

// Clean what the Profile form or the cloud gives back.
export function cleanPrefs(v) {
  const out = {};
  for (const who of ["baby", "kid"]) {
    const p = prefsFor({ prefs: v }, who);
    if (p.tags.size || p.note) out[who] = { tags: [...p.tags], note: p.note };
  }
  return out;
}
