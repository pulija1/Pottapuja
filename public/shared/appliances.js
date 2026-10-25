// The cooking appliances the family has (set in 👤 Profile) and how the recipe book uses them.
// A recipe can say how to make it in the air fryer or the oven with an "- **Air fryer:**" or
// "- **Oven:**" line that starts with the total time ("12 min at 200°C. Toss ..."). When the family
// has that appliance, the app shows the method, counts its time for quick recipes, and leans the
// suggestions toward it. With a two-basket air fryer, two air-fryer dishes on the same day are
// paired so they cook side by side and finish together. Pure functions, no I/O here.

export const APPLIANCES = {
  airFryer: { label: "Air fryer", icon: "🍟" },
  oven: { label: "Oven", icon: "♨️" },
};

// settings.airFryer is "dual" (two baskets, like the Ninja dual zone), "single" or ""; settings.oven is true or false.
export function ownedAppliances(settings) {
  const s = settings || {};
  const out = [];
  if (s.airFryer === "dual" || s.airFryer === "single") out.push("airFryer");
  if (s.oven === true) out.push("oven");
  return out;
}

export const hasDualBasket = (settings) => settings?.airFryer === "dual";

// "12 min at 200°C. Toss the okra in oil, shake halfway." -> { text, minutes: 12, tempC: 200 }
export function parseApplianceLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const min = text.match(/(\d+)\s*(?:-|–|to)?\s*(\d+)?\s*min/i);
  const temp = text.match(/(\d{2,3})\s*°?\s*C\b/);
  return { text, minutes: min ? Number(min[2] || min[1]) : null, tempC: temp ? Number(temp[1]) : null };
}

// The air fryer and oven methods of a recipe that the family can use, air fryer first.
export function methodsFor(recipe, owned) {
  return (owned || []).filter((k) => recipe?.[k]?.text).map((k) => ({ key: k, ...APPLIANCES[k], ...recipe[k] }));
}

export const usesAppliance = (recipe, owned) => methodsFor(recipe, owned).length > 0;

// The fastest way the family can make it: the stove time, or an appliance's time if that is shorter.
export function fastestMinutes(recipe, owned) {
  const times = [recipe?.prepMinutes, ...methodsFor(recipe, owned).map((m) => m.minutes)].filter((n) => n > 0);
  return times.length ? Math.min(...times) : null;
}

// Two-basket air fryer: pair up the air fryer dishes of one day, two to a load. Each pair runs at
// once, the longer one starts first and the other joins when the time left matches (Ninja calls it
// Smart Finish or Sync), so both come out together. Returns [{ baskets: [{recipe, minutes, tempC}, ...], minutes }].
export function basketPairs(recipes, settings) {
  if (!hasDualBasket(settings)) return [];
  const seen = new Set();
  const fried = (recipes || [])
    .filter((r) => r?.airFryer?.text && !seen.has(r.id) && seen.add(r.id))
    .map((recipe) => ({ recipe, minutes: recipe.airFryer.minutes || null, tempC: recipe.airFryer.tempC || null }))
    .sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  const pairs = [];
  for (let i = 0; i + 1 < fried.length; i += 2) {
    const baskets = [fried[i], fried[i + 1]];
    pairs.push({ baskets, minutes: Math.max(...baskets.map((b) => b.minutes || 0)) || null });
  }
  return pairs;
}

// One line for the AI prompt, or "" when the family has neither.
export function appliancePrompt(list) {
  const set = new Set(list || []);
  const fryer = set.has("airFryerDual") ? "a two-basket air fryer (Ninja dual zone, two baskets that cook at once and can finish together)" : set.has("airFryer") ? "an air fryer" : "";
  const oven = set.has("oven") ? "a conventional oven" : "";
  const have = [fryer, oven].filter(Boolean);
  if (!have.length) return "";
  const both = set.has("airFryerDual") ? " When two parts of the meal can go in the air fryer, put one in each basket and say so." : "";
  return `Besides the stove, the family has ${have.join(" and ")}. Where it makes the dish quicker or easier (fries, roasting, tikka, baking), cook it there and give the temperature in °C and the time.${both} Count that time in prepMinutes.`;
}

// What to send with an AI request: "airFryerDual" | "airFryer", "oven".
export function applianceRequest(settings) {
  const owned = ownedAppliances(settings);
  return owned.map((k) => (k === "airFryer" && hasDualBasket(settings) ? "airFryerDual" : k));
}
