// Shopping list helpers: name normalising, unit conversion, merging, and aisle grouping.

import { DATASET_ITEMS } from "./dataset.js";

const UNIT_ALIASES = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  l: "l", ltr: "l", litre: "l", liter: "l", litres: "l", liters: "l",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup",
  pc: "pcs", pcs: "pcs", piece: "pcs", pieces: "pcs", nos: "pcs", no: "pcs", "": "pcs",
  bunch: "bunch", bunches: "bunch", packet: "packet", packets: "packet", pack: "packet",
  dozen: "dozen",
};

// Units that convert into a common base so 500 g + 1 kg merge to 1.5 kg.
const BASE = { g: ["g", 1], kg: ["g", 1000], ml: ["ml", 1], l: ["ml", 1000], dozen: ["pcs", 12], pcs: ["pcs", 1], tsp: ["tsp", 1], tbsp: ["tsp", 3] };

export function normUnit(u) {
  const k = String(u ?? "").trim().toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES[k] ?? k;
}

const SYNONYMS = {
  "toor dal": "toor dal", "tuvar dal": "toor dal", "arhar dal": "toor dal", "kandi pappu": "toor dal", "thuvaram paruppu": "toor dal",
  "moong dal": "moong dal", "mung dal": "moong dal", "pesara pappu": "moong dal", "yellow moong dal": "moong dal", "split moong dal": "moong dal",
  "urad dal": "urad dal", "minapa pappu": "urad dal", "ulundu": "urad dal",
  "curd": "curd", "yogurt": "curd", "yoghurt": "curd", "perugu": "curd", "thayir": "curd", "dahi": "curd",
  "ragi flour": "ragi flour", "finger millet flour": "ragi flour", "nachni flour": "ragi flour",
  "ragi": "ragi flour",
  "rava": "rava", "sooji": "rava", "suji": "rava", "semolina": "rava", "upma rava": "rava",
  "curry leaves": "curry leaves", "karivepaku": "curry leaves", "kadi patta": "curry leaves",
  "coriander leaves": "coriander leaves", "cilantro": "coriander leaves", "kothimeera": "coriander leaves",
  "ghee": "ghee", "neyyi": "ghee",
  "tomato": "tomato", "tomatoes": "tomato",
  "potato": "potato", "potatoes": "potato", "aloo": "potato",
  "onion": "onion", "onions": "onion",
  "carrot": "carrot", "carrots": "carrot",
  "banana": "banana", "bananas": "banana",
  "apple": "apple", "apples": "apple",
  "egg": "egg", "eggs": "egg",
  "lemon": "lemon", "lemons": "lemon", "lime": "lemon",
  "sweet potato": "sweet potato", "sweet potatoes": "sweet potato",
  "idli batter": "idli/dosa batter", "dosa batter": "idli/dosa batter", "idli dosa batter": "idli/dosa batter",
  "vermicelli": "vermicelli", "semiya": "vermicelli", "semia": "vermicelli",
  "sona masoori rice": "rice", "ponni rice": "rice", "biyyam": "rice", "arisi": "rice", "akki": "rice",
  "turmeric powder": "turmeric", "haldi": "turmeric", "pasupu": "turmeric", "manjal": "turmeric",
  "cumin": "jeera", "cumin seeds": "jeera", "jeelakarra": "jeera", "seeragam": "jeera",
  "asafoetida": "hing", "inguva": "hing", "perungayam": "hing",
  "green peas": "peas", "french beans": "beans", "whole wheat flour": "atta", "wheat flour": "atta",
  "plain yogurt": "curd", "pumpkin": "pumpkin", "tomato puree": "tomato puree",
  // Names used in the recipe book (recipes/*.md) and how people write them on a list.
  "whole wheat bread": "bread", "brown bread": "bread", "sandwich bread": "bread", "greek yogurt": "curd", "hung curd": "curd",
  "flour tortilla": "flour tortilla", "corn tortilla": "corn tortilla", "tortilla": "flour tortilla",
  "black bean": "black beans", "black beans": "black beans", "pinto bean": "pinto beans", "pinto beans": "pinto beans",
  "oats": "rolled oats", "rolled oats": "rolled oats", "cheddar": "cheddar cheese", "cheddar cheese": "cheddar cheese",
  "badam powder": "almond powder", "almond powder": "almond powder", "almond flour": "almond powder",
  // Telugu vegetable names (kuragayalu and aakukuralu). The kitchen's quick-add chips and
  // recipes/telugu-curries.md use them as "vankaya (brinjal)", so either name matches.
  "vankaya": "brinjal", "eggplant": "brinjal", "bendakaya": "okra", "sorakaya": "bottle gourd", "anapakaya": "bottle gourd",
  "beerakaya": "ridge gourd", "kakarakaya": "bitter gourd", "dondakaya": "ivy gourd", "tindora": "ivy gourd",
  "potlakaya": "snake gourd", "munagakaya": "drumstick", "aratikaya": "raw banana", "chamadumpa": "taro root", "arbi": "taro root",
  "gummadikaya": "pumpkin", "bangaladumpa": "potato", "chilagada dumpa": "sweet potato", "chikkudukaya": "broad beans",
  "goruchikkudu": "cluster beans", "gorikayalu": "cluster beans", "palakura": "spinach", "thotakura": "amaranth leaves",
  "gongura": "gongura", "sorrel leaves": "gongura", "menthikura": "methi leaves", "fenugreek leaves": "methi leaves", "methi": "methi leaves",
  "mullangi": "radish", "kanda": "yam", "kandagadda": "yam", "mamidikaya": "raw mango", "tamata": "tomato", "ullipaya": "onion",
  "pachi mirapakaya": "green chilli", "green chillies": "green chilli", "allam": "ginger", "vellulli": "garlic",
  "kothimeera": "coriander leaves", "pudina": "mint leaves", "pachi batani": "peas", "mokkajonna": "sweet corn", "kobbari": "coconut",
  "dosakaya": "cucumber", "cabbage": "cabbage", "cauliflower": "cauliflower", "capsicum": "capsicum",
  // Telugu fruit names (pandlu).
  "arati pandu": "banana", "mamidi pandu": "mango", "boppayi": "papaya", "boppayi pandu": "papaya", "sapota": "chikoo", "chiku": "chikoo",
  "jama pandu": "guava", "jama kaya": "guava", "danimma": "pomegranate", "danimma pandu": "pomegranate", "kamala pandu": "orange",
  "draksha": "grapes", "drakshalu": "grapes", "puchakaya": "watermelon", "seethaphalam": "custard apple", "sitaphal": "custard apple", "anasa pandu": "pineapple",
  "ladies finger": "okra", "lady's finger": "okra", "ladys finger": "okra", "lady finger": "okra", "ladyfinger": "okra", "ladies fingers": "okra",
};

// Regional names from the grocery dataset (Hindi, Tamil, Telugu, Kannada, Malayalam) map to the English name.
for (const item of DATASET_ITEMS) {
  const english = item.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim();
  for (const alias of Object.values(item.names || {})) {
    const a = String(alias).toLowerCase().trim();
    if (a && !SYNONYMS[a]) SYNONYMS[a] = SYNONYMS[english] || english;
  }
}
// Every English name is its own key too, so plurals like "brinjals" or "ridge gourds" find it.
for (const en of Object.values(SYNONYMS)) if (!SYNONYMS[en]) SYNONYMS[en] = en;

export function normName(name) {
  // "ragi flour (finger millet)" -> "ragi flour"
  const k = String(name || "").toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim().replace(/\s+/g, " ");
  if (SYNONYMS[k]) return SYNONYMS[k];
  if (/chill?ies$/.test(k)) return normName(k.replace(/ies$/, "i"));
  if (k.endsWith("ies") && k.length > 4) return normName(k.slice(0, -3) + "y");
  // simple plural -> singular
  if (k.endsWith("es") && SYNONYMS[k.slice(0, -2)]) return SYNONYMS[k.slice(0, -2)];
  if (k.endsWith("s") && SYNONYMS[k.slice(0, -1)]) return SYNONYMS[k.slice(0, -1)];
  return k;
}

// Word lists per aisle. Plurals ("small onions", "cherry tomatoes") match too. Order matters: first match wins.
const words = (list) => new RegExp(`\\b(?:${list.join("|")})(?:s|es)?\\b`);
const AISLES = [
  ["Spices & tempering", /\b(powder|masala)\b/],
  ["Vegetables", words(["tomato", "onion", "shallot", "potato", "carrot", "beans?", "brinjal", "eggplant", "okra", "lady ?finger", "ladies finger", "bhindi", "drumstick", "spinach", "palak", "gourd", "cabbage", "cauliflower", "peas", "capsicum", "bell pepper", "chill?i", "chillie", "ginger", "garlic", "curry leaves", "coriander leaves", "mint", "methi leaves", "pumpkin", "sweet potato", "beetroot", "beet", "cucumber", "lemon", "lime", "plantain", "raw banana", "yam", "colocasia", "baby corn", "corn", "sweet corn", "radish", "taro", "arbi", "raw mango", "mushroom", "zucchini", "broccoli", "gongura", "leaves"])],
  ["Fruits", words(["banana", "apple", "pear", "papaya", "mango", "chikoo", "sapota", "grape", "pomegranate", "orange", "avocado", "guava", "watermelon", "melon", "berry", "berries", "strawberry", "plum", "kiwi", "pineapple"])],
  ["Rice, dals & flours", /\b(baby cereal|rice|dal|ragi|rava|flour|atta|poha|aval|vermicelli|millet|bajra|jowar|oats|besan|maida|sabudana|batter|bread|tortilla|chana|rajma|lentils?)\b/],
  ["Dairy & eggs", /\b(milk|curd|ghee|butter|paneer|cheese|eggs?|cream|yogurt)\b/],
  ["Spices & tempering", /\b(salt|turmeric|cumin|jeera|mustard|hing|asafoetida|pepper|cardamom|elaichi|cinnamon|cloves?|tamarind|jaggery|sugar|seeds|methi|fenugreek|podi|baking)\b/],
  ["Oil, nuts & dry fruits", words(["oil", "cashew", "almond", "peanut", "groundnut", "walnut", "pistachio", "raisin", "dates", "coconut", "nut", "mixed nuts", "jam"])],
  ["Baby care", /\b(diapers?|wipes|formula|cerelac|sipper|bib|baby (lotion|soap|oil|shampoo|food))\b/],
  ["School & household", /\b(tissues?|napkins?|foil|lunch ?box|bottle|soap|detergent|bags?)\b/],
];

export function aisleFor(name) {
  const n = normName(name);
  for (const [aisle, re] of AISLES) if (re.test(n)) return aisle;
  return "Other";
}

export const AISLE_ORDER = [...new Set(AISLES.map((a) => a[0]))].concat("Other");

function toBase(qty, unit) {
  const b = BASE[unit];
  if (!b || typeof qty !== "number" || !isFinite(qty)) return null;
  return { unit: b[0], qty: qty * b[1] };
}

function fromBase(qty, baseUnit) {
  if (baseUnit === "g" && qty >= 1000) return { quantity: round(qty / 1000), unit: "kg" };
  if (baseUnit === "ml" && qty >= 1000) return { quantity: round(qty / 1000), unit: "l" };
  if (baseUnit === "tsp" && qty >= 3 && Math.abs(qty / 3 - Math.round(qty / 3)) < 1e-9) return { quantity: round(qty / 3), unit: "tbsp" };
  return { quantity: round(qty), unit: baseUnit };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Merge a list of {name, quantity, unit, ...} into one entry per (name, compatible unit).
// Quantities that cannot be added (missing, or incompatible units) are kept as separate lines.
export function mergeItems(items) {
  const out = new Map();
  for (const raw of items || []) {
    if (!raw || !String(raw.name || "").trim()) continue;
    const name = normName(raw.name);
    const unit = normUnit(raw.unit);
    const qty = raw.quantity === "" || raw.quantity == null ? null : Number(raw.quantity);
    const base = qty != null && !isNaN(qty) ? toBase(qty, unit) : null;
    const key = base ? `${name}|${base.unit}` : `${name}|${unit}`;
    const existing = out.get(key);
    const sources = [...(raw.sources || []), ...(raw.source ? [raw.source] : [])];
    const keys = [...(raw.keys || [])];
    if (!existing) {
      out.set(key, {
        ...raw,
        name,
        quantity: base ? base.qty : qty != null && !isNaN(qty) ? qty : null,
        unit: base ? base.unit : unit,
        aisle: raw.aisle || aisleFor(name),
        sources: [...new Set(sources)],
        keys,
        bought: !!raw.bought,
        _base: !!base,
      });
    } else {
      if (existing.quantity != null && qty != null && !isNaN(qty)) {
        existing.quantity = round(existing.quantity + (base ? base.qty : qty));
      } else if (existing.quantity == null && qty != null && !isNaN(qty)) {
        existing.quantity = base ? base.qty : qty;
      }
      for (const s of sources) if (!existing.sources.includes(s)) existing.sources.push(s);
      for (const k of keys) if (!existing.keys.includes(k)) existing.keys.push(k);
      existing.bought = existing.bought && !!raw.bought;
      if (!existing.store && raw.store) existing.store = raw.store;
    }
  }
  return [...out.values()].map((e) => {
    const { _base, ...rest } = e;
    if ((_base || rest.unit === "g" || rest.unit === "ml" || rest.unit === "tsp") && rest.quantity != null) Object.assign(rest, fromBase(rest.quantity, rest.unit));
    return rest;
  });
}

export function groupByAisle(items) {
  const groups = new Map(AISLE_ORDER.map((a) => [a, []]));
  for (const it of items) {
    const a = it.aisle && groups.has(it.aisle) ? it.aisle : aisleFor(it.name);
    groups.get(a).push(it);
  }
  for (const list of groups.values()) list.sort((x, y) => x.name.localeCompare(y.name));
  return [...groups.entries()].filter(([, list]) => list.length);
}

export function formatQty(item) {
  if (item.quantity == null || item.quantity === "") return item.unit && item.unit !== "pcs" ? item.unit : "";
  return `${item.quantity} ${item.unit || ""}`.trim();
}

// Items needed by a recipe that are not in the pantry.
export function missingFromPantry(recipe, pantry) {
  const have = new Set((pantry || []).map((p) => normName(typeof p === "string" ? p : p.name)));
  const BASICS = new Set(["water", "salt", "oil"]);
  return (recipe?.ingredients || []).filter((i) => {
    const n = normName(i.name);
    return n && !have.has(n) && !BASICS.has(n) && !/^leftover\b/.test(n);
  });
}
