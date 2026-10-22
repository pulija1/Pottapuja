// Recipe generation with Claude, plus the mock and offline modes.
//
// AI_MODE=live  call the Claude API (needs ANTHROPIC_API_KEY or another configured credential)
// AI_MODE=mock  return built-in recipes as if they came from the AI (no network, for tests)
// AI_MODE=off   behave as if the AI is down (the endpoint answers 503)
// Default: live when ANTHROPIC_API_KEY is set, otherwise off.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkForAudience } from "../public/shared/safety.js";
import { suggestFromLibrary } from "../public/shared/recipes.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
export const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 60000);

export function aiMode() {
  const m = String(process.env.AI_MODE || "").toLowerCase();
  if (["live", "mock", "off"].includes(m)) return m;
  return process.env.ANTHROPIC_API_KEY ? "live" : "off";
}

const Ingredient = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
});

const Recipe = z.object({
  title: z.string(),
  forWhom: z.enum(["baby", "kid", "family"]),
  mealType: z.enum(["breakfast", "lunch", "lunchbox", "snack", "dinner"]),
  texture: z.string(),
  prepMinutes: z.number(),
  ingredients: z.array(Ingredient),
  steps: z.array(z.string()),
  notes: z.string(),
});

const RecipeList = z.object({ recipes: z.array(Recipe) });

const SYSTEM = `You plan meals for a South Indian family (Telugu, Tamil, Kannada and Kerala home cooking) with an 8-month-old baby and a 4-year-old who goes to school.

Write practical home recipes that use the ingredients the family already has, adding as few extra ingredients as possible.

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

Use quantities as numbers and short units (g, kg, ml, cup, tbsp, tsp, pcs, pinch). Keep steps short and clear.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return client;
}

export class AiUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AiUnavailable";
    this.cause = cause;
  }
}

function buildPrompt({ ingredients, forWhom, mealType, notes, count, schoolNutFree }) {
  const who = forWhom === "both" ? "the baby and the 4-year-old (mix of both)" : forWhom === "baby" ? "the 8-month-old baby" : forWhom === "kid" ? "the 4-year-old" : "the whole family";
  return [
    `Ingredients we have: ${ingredients.join(", ") || "(nothing listed, suggest staples)"}.`,
    `Suggest ${count} recipes for ${who}.`,
    mealType ? `Meal: ${mealType}.` : "",
    schoolNutFree ? "The school is nut-free." : "",
    notes ? `Extra notes from the parent: ${notes}` : "",
  ].filter(Boolean).join("\n");
}

// Clean and bound the request body. Throws a 400-style error for bad input.
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
  const count = Math.min(6, Math.max(1, Number.parseInt(b.count, 10) || 4));
  const schoolNutFree = b.schoolNutFree === true;
  return { ingredients, forWhom, mealType, notes, count, schoolNutFree };
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

async function callClaude(req, signal) {
  let response;
  try {
    response = await getClient().messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: "low", format: zodOutputFormat(RecipeList) },
        messages: [{ role: "user", content: buildPrompt(req) }],
      },
      { signal },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AiUnavailable("AI is not set up (bad or missing API key).", err);
    if (err instanceof Anthropic.RateLimitError) throw new AiUnavailable("AI is busy right now (rate limited).", err);
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiUnavailable("AI took too long to answer.", err);
    if (err instanceof Anthropic.APIConnectionError) throw new AiUnavailable("Cannot reach the AI service.", err);
    if (err instanceof Anthropic.InternalServerError) throw new AiUnavailable("AI service had an error.", err);
    if (err instanceof Anthropic.APIError) throw new AiUnavailable(`AI request failed (${err.status ?? "error"}).`, err);
    throw new AiUnavailable("Cannot reach the AI service.", err);
  }
  if (response.stop_reason === "refusal") throw new AiUnavailable("AI declined this request.");
  if (response.stop_reason === "max_tokens") throw new AiUnavailable("AI answer was cut off.");
  const parsed = response.parsed_output;
  if (!parsed || !Array.isArray(parsed.recipes)) throw new AiUnavailable("AI returned an unreadable answer.");
  return parsed.recipes;
}

function mockRecipes(req) {
  const fromLib = suggestFromLibrary(req.ingredients, { forWhom: req.forWhom, mealType: req.mealType, limit: req.count, schoolNutFree: req.schoolNutFree });
  return fromLib.map(({ id, source, ...rest }) => ({ ...rest }));
}

export async function generateRecipes(body, { signal } = {}) {
  const req = parseRequest(body);
  const mode = aiMode();
  if (mode === "off") throw new AiUnavailable("AI is turned off on this server.");
  const started = Date.now();
  const raw = mode === "mock" ? mockRecipes(req) : await callClaude(req, signal);
  const { kept, rejected } = screen(raw, { schoolNutFree: req.schoolNutFree });
  return {
    mode,
    model: mode === "live" ? MODEL : null,
    ms: Date.now() - started,
    recipes: kept.map((r, i) => ({ ...r, id: `ai-${Date.now().toString(36)}-${i}`, source: mode === "live" ? "ai" : "mock" })),
    rejected,
  };
}
