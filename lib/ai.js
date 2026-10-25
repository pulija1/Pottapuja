// Recipe generation with Claude, plus the mock and offline modes.
//
// AI_MODE=live  call the Claude API (needs ANTHROPIC_API_KEY or another configured credential)
// AI_MODE=mock  return built-in recipes as if they came from the AI (no network, for tests)
// AI_MODE=off   behave as if the AI is down (the endpoint answers 503)
// Default: live when ANTHROPIC_API_KEY is set, otherwise off.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { SYSTEM, MODEL as DEFAULT_MODEL, FOR_WHOM, MEAL_TYPES, buildPrompt, parseRequest, screen, QUICK_MINUTES } from "../public/shared/ai-prompt.js";
import { suggestFromLibrary } from "../public/shared/recipes.js";

export { parseRequest, screen };

export const MODEL = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
// Kept under the browser's 50 s limit, with no retries, so the server never works on an abandoned request.
export const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 40000);

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
  forWhom: z.enum(FOR_WHOM),
  mealType: z.enum(MEAL_TYPES),
  texture: z.string(),
  prepMinutes: z.number(),
  ingredients: z.array(Ingredient),
  steps: z.array(z.string()),
  notes: z.string(),
});

export const RecipeList = z.object({ recipes: z.array(Recipe) });

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });
  return client;
}

export class AiUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AiUnavailable";
    this.cause = cause;
  }
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
  const fromLib = suggestFromLibrary(req.ingredients, { forWhom: req.forWhom, mealType: req.mealType, limit: req.count, schoolNutFree: req.schoolNutFree, maxMinutes: req.quick ? QUICK_MINUTES : 0, appliances: req.appliances.map((a) => (a === "airFryerDual" ? "airFryer" : a)) });
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
