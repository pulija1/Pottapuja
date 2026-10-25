// Reads the family recipe book: plain Markdown files in the repository's recipes/ folder.
// The files are meant to be read and edited by hand (on GitHub or in any text editor), so the
// format is forgiving. See recipes/README.md for the format. Pure functions, no I/O here.

import { isNutIngredient } from "./safety.js";

// The files the app loads, in this order. A new file must be added here to be loaded.
export const RECIPE_FILES = ["kid-4-years.md", "baby-8-months.md", "family-dinners.md", "telugu-curries.md"];

const WHO = {
  baby: "baby", "8-month-old": "baby", "8 month old": "baby", "8 months": "baby", infant: "baby",
  kid: "kid", "4-year-old": "kid", "4 year old": "kid", "4 years": "kid", child: "kid",
  family: "family", "whole family": "family", everyone: "family",
};
const MEALS = ["breakfast", "lunchbox", "lunch", "snack", "dinner"];

const UNITS = {
  g: "g", kg: "kg", ml: "ml", l: "l",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup", pinch: "pinch", pinches: "pinch", slice: "slice", slices: "slice",
  clove: "clove", cloves: "clove", sprig: "sprig", sprigs: "sprig", handful: "handful", handfuls: "handful",
  inch: "inch", bunch: "bunch", can: "can", cans: "can", packet: "packet", packets: "packet", dozen: "dozen",
  pc: "pcs", pcs: "pcs", piece: "pcs", pieces: "pcs",
};
const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const QTY = /^(\d+(?:\.\d+)?\s*[½¼¾⅓⅔⅛]|\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛])(?:\s*(?:-|–|to)\s*(?:\d+(?:\.\d+)?|[½¼¾⅓⅔⅛]))?\s+/;

function parseQty(s) {
  s = s.trim();
  const uni = s.match(/^(\d*)\s*([½¼¾⅓⅔⅛])$/);
  if (uni) return Number(uni[1] || 0) + FRACTIONS[uni[2]];
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(s);
}

// "1½ cups rice, washed" -> { name: "rice", quantity: 1.5, unit: "cup", note: "washed" }
// "Salt, to taste"       -> { name: "salt", quantity: null, unit: "", note: "to taste" }
export function parseIngredient(line) {
  let rest = String(line || "").replace(/^\s*[-*+]\s+/, "").trim();
  let quantity = null;
  let unit = "";
  const q = rest.match(QTY);
  if (q) {
    quantity = Math.round(parseQty(q[1]) * 1000) / 1000;
    rest = rest.slice(q[0].length);
    const u = rest.match(/^([a-zA-Z]+)\.?\s+/);
    if (u && UNITS[u[1].toLowerCase()]) {
      unit = UNITS[u[1].toLowerCase()];
      rest = rest.slice(u[0].length).replace(/^of\s+/i, "");
    } else {
      unit = "pcs";
    }
  }
  let depth = 0;
  let comma = -1;
  for (let i = 0; i < rest.length && comma < 0; i++) {
    if (rest[i] === "(") depth++;
    else if (rest[i] === ")") depth = Math.max(0, depth - 1);
    else if (rest[i] === "," && !depth) comma = i;
  }
  const name = (comma < 0 ? rest : rest.slice(0, comma)).trim();
  const note = comma < 0 ? "" : rest.slice(comma + 1).trim();
  // "Salt" -> "salt", but keep names that start with an acronym ("PB" stays).
  const out = { name: /^[A-Z][^A-Z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name, quantity, unit };
  if (note) out.note = note;
  return out;
}

const EGG = /\beggs?\b/i;
const DAIRY = /\b(milk|curd|yogh?urt|dahi|paneer|cheese|cheddar|mozzarella|queso|cotija|buttermilk|cream|khoa|ricotta|labneh|kefir|raita|lassi)\b/i;
const NOT_DAIRY = /\b(coconut|almond|oat|soy|rice|cashew|peanut)\s+(milk|cream)\b|\bcream of\b/i;

// What a recipe gives a child that the family tracks every day: egg, milk/dairy, nuts.
export function nutritionTags(recipe) {
  const names = (recipe?.ingredients || []).map((i) => String(typeof i === "string" ? i : i?.name || ""));
  const tags = new Set();
  if (names.some((n) => EGG.test(n))) tags.add("egg");
  if (names.some((n) => DAIRY.test(n) && !NOT_DAIRY.test(n))) tags.add("dairy");
  if (names.some((n) => isNutIngredient(n))) tags.add("nuts");
  return [...tags];
}

export const TAG_LABELS = { egg: "🥚 Egg", dairy: "🥛 Milk/dairy", nuts: "🥜 Nuts" };

const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Parse one Markdown file. Returns { recipes, problems }. A recipe with a problem that makes it
// unusable (no "For", no ingredients, no steps) is left out and listed in problems with its line.
export function parseRecipeMarkdown(md, file = "") {
  const lines = String(md || "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split("\n");
  const recipes = [];
  const problems = [];
  let section = "";
  let cur = null;
  let mode = "";

  const finish = () => {
    if (!cur) return;
    const r = cur;
    cur = null;
    const where = { file, line: r.line, title: r.title };
    const forWhom = WHO[String(r.fields.for || "").toLowerCase().replace(/\(.*?\)/g, "").trim()];
    if (!forWhom) return problems.push({ ...where, message: `"For" must be baby, kid or family (found "${r.fields.for || ""}").` });
    if (!r.ingredients.length) return problems.push({ ...where, message: "No ingredients listed under **Ingredients**." });
    if (!r.steps.length) return problems.push({ ...where, message: "No numbered steps under **Steps**." });
    const meal = String(r.fields.meal || "").toLowerCase().replace(/school\s+lunch\s*box|lunch\s+box/, "lunchbox").trim();
    const mealType = MEALS.find((m) => meal === m || meal.startsWith(m)) || (forWhom === "family" ? "dinner" : "");
    if (!mealType) problems.push({ ...where, message: `Unknown meal "${r.fields.meal || ""}", use breakfast, lunchbox, lunch, snack or dinner.` });
    const recipe = {
      id: r.fields.id || "lib-" + slug(r.title),
      title: r.title,
      forWhom,
      mealType: mealType || "snack",
      texture: (r.fields.texture || "").toLowerCase(),
      prepMinutes: parseInt(r.fields.time, 10) || null,
      cuisine: r.fields.cuisine || "",
      dish: (r.fields.dish || "").toLowerCase().trim(),
      ingredients: r.ingredients,
      steps: r.steps,
      notes: r.notes.join(" ").trim(),
      section,
      file,
      source: "library",
    };
    if (/^(yes|true|y|⭐)/i.test(r.fields["family favorite"] || r.fields["family favourite"] || "")) recipe.familyFavorite = true;
    const serves = String(r.fields.serves || r.fields.servings || r.fields.makes || "").match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    if (serves && Number(serves[1]) > 0) {
      recipe.servings = Number(serves[1]);
      const each = serves[2].replace(/^\((.*)\)$/, "$1").replace(/^servings?\b\s*/i, "").trim();
      if (each) recipe.servingNote = each;
    }
    if (r.fields["nut-free swap"]) recipe.nutFreeSwap = r.fields["nut-free swap"];
    const declared = String(r.fields["good for"] || "").toLowerCase();
    const tags = new Set(nutritionTags(recipe));
    if (/\begg/.test(declared)) tags.add("egg");
    if (/\b(dairy|milk)/.test(declared)) tags.add("dairy");
    if (/\bnut/.test(declared)) tags.add("nuts");
    recipe.tags = ["egg", "dairy", "nuts"].filter((t) => tags.has(t));
    if (tags.has("nuts")) recipe.nutFree = false;
    recipes.push(recipe);
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      finish();
      if (h[1].length === 3) {
        cur = { title: h[2].trim(), line: i + 1, fields: {}, ingredients: [], steps: [], notes: [] };
        mode = "fields";
      } else if (h[1].length === 2) {
        section = h[2].trim();
      }
      return;
    }
    if (!cur || !line.trim() || /^\s*(---+|\*\*\*+)\s*$/.test(line)) return;
    const label = line.match(/^\s*\*\*([^*]+?):?\*\*:?\s*(.*)$/);
    if (label) {
      const key = label[1].trim().toLowerCase();
      if (/^ingredients?/.test(key)) { mode = "ingredients"; return; }
      if (/^(steps|method|how to make)/.test(key)) { mode = "steps"; return; }
      if (/^(notes?|tips?)/.test(key)) { mode = "notes"; if (label[2]) cur.notes.push(label[2].trim()); return; }
    }
    if (mode === "fields") {
      const f = line.match(/^\s*[-*+]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/);
      if (f) cur.fields[f[1].trim().toLowerCase()] = f[2].trim();
      return;
    }
    if (mode === "ingredients") {
      if (/^\s*[-*+]\s+\S/.test(line)) {
        const ing = parseIngredient(line);
        if (ing.name) cur.ingredients.push(ing);
      }
      return;
    }
    if (mode === "steps") {
      const s = line.match(/^\s*(?:\d+[.)]|[-*+])\s+(.*)$/);
      if (s) cur.steps.push(s[1].trim());
      else if (cur.steps.length && /^\s{2,}\S/.test(raw)) cur.steps[cur.steps.length - 1] += " " + line.trim();
      return;
    }
    if (mode === "notes") cur.notes.push(line.replace(/^\s*(>|[-*+])\s*/, "").trim());
  });
  finish();
  return { recipes, problems };
}

// Combine parsed files into one list. A repeated id keeps the first recipe and reports the rest.
export function combineBooks(parsed) {
  const seen = new Map();
  const recipes = [];
  const problems = [];
  for (const p of parsed) {
    problems.push(...p.problems);
    for (const r of p.recipes) {
      if (seen.has(r.id)) {
        problems.push({ file: r.file, title: r.title, message: `Same id as "${seen.get(r.id).title}" in ${seen.get(r.id).file}; give one of them a different title or **ID**.` });
        continue;
      }
      seen.set(r.id, r);
      recipes.push(r);
    }
  }
  return { recipes, problems };
}

// Write a recipe back as Markdown in the book's format (used to migrate recipes into the book).
const FRAC_OUT = [[0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];
export function formatQuantity(q) {
  if (q == null || q === "") return "";
  const whole = Math.floor(q);
  const part = q - whole;
  if (part < 1e-6) return String(whole);
  const f = FRAC_OUT.find(([v]) => Math.abs(v - part) < 0.01);
  return f ? (whole ? String(whole) : "") + f[1] : String(q);
}

export function recipeToMarkdown(r) {
  const who = { baby: "baby", kid: "kid", family: "family" }[r.forWhom] || r.forWhom;
  const tags = r.tags || nutritionTags(r);
  const out = [`### ${r.title}`, ""];
  out.push(`- **For:** ${who}`, `- **Meal:** ${r.mealType}`);
  if (r.cuisine) out.push(`- **Cuisine:** ${r.cuisine}`);
  if (r.prepMinutes) out.push(`- **Time:** ${r.prepMinutes} min`);
  if (r.servings) out.push(`- **Serves:** ${r.servings}${r.servingNote ? ` (${r.servingNote})` : ""}`);
  if (r.texture) out.push(`- **Texture:** ${r.texture}`);
  if (r.dish) out.push(`- **Dish:** ${r.dish}`);
  if (tags.length) out.push(`- **Good for:** ${tags.map((t) => TAG_LABELS[t]).join(" · ")}`);
  if (r.nutFreeSwap) out.push(`- **Nut-free swap:** ${r.nutFreeSwap}`);
  if (r.familyFavorite) out.push(`- **Family favorite:** yes`);
  if (r.id && r.id !== "lib-" + slug(r.title)) out.push(`- **ID:** ${r.id}`);
  out.push("", "**Ingredients**", "");
  for (const i of r.ingredients) {
    const q = formatQuantity(i.quantity);
    const plural = i.quantity > 1 && ["cup", "slice", "clove", "sprig", "pinch"].includes(i.unit);
    const unit = i.unit && i.unit !== "pcs" ? i.unit + (plural ? (i.unit === "pinch" ? "es" : "s") : "") + " " : "";
    out.push(`- ${q ? q + " " : ""}${unit}${i.name}${i.note ? ", " + i.note : ""}`);
  }
  out.push("", "**Steps**", "");
  r.steps.forEach((s, n) => out.push(`${n + 1}. ${s}`));
  if (r.notes) out.push("", `**Notes:** ${r.notes}`);
  out.push("");
  return out.join("\n");
}
