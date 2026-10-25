// AI recipes straight from the browser with the family's own Claude API key, for sites with no
// server (GitHub Pages). The key lives only in this browser under its own storage key, so it
// never goes into backups or family sync. This is a static site with no build step, so it calls the
// Messages API with fetch rather than the Node SDK the server uses.

import { SYSTEM, MODEL, RECIPE_LIST_SCHEMA, buildPrompt, parseRequest, screen } from "./shared/ai-prompt.js";
import { PLAN_RULES, PLAN_CHAT_SCHEMA } from "./shared/plan-chat.js";

const KEY = "familyMealPlanner.aiKey";
export const API_URL = "https://api.anthropic.com/v1/messages";

export function getAiKey() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}

export function setAiKey(key) {
  const k = String(key || "").trim();
  try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch {}
  return k;
}

export const looksLikeKey = (k) => /^sk-ant-[\w-]{20,}$/.test(String(k || "").trim());

export class BrowserAiError extends Error {
  constructor(msg, kind = "") { super(msg); this.kind = kind; }
}

// One Messages API request with the family's key. Returns the response body, or throws a
// BrowserAiError with a message the parent can act on.
async function callClaude(payload, { signal, key = getAiKey(), headers = {} } = {}) {
  if (!key) throw new BrowserAiError("Add a Claude API key in 👤 Profile to get AI recipes.", "nokey");
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2026-10-21",
        "anthropic-dangerous-direct-browser-access": "true",
        ...headers,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new BrowserAiError("Couldn't reach the recipe AI.", "network");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new BrowserAiError("The Claude API key was not accepted. Check it in 👤 Profile.", "auth");
  if (res.status === 403) throw new BrowserAiError("The Claude API key isn't allowed to do this. Check the key's workspace in the Claude Console.", "auth");
  if (res.status === 400 && /credit|billing/i.test(data?.error?.message || "")) throw new BrowserAiError("The Claude account is out of credit. Add credit in the Claude Console.", "billing");
  if (res.status === 429 || res.status === 529) throw new BrowserAiError("The recipe AI is busy right now.", "busy");
  if (!res.ok) throw new BrowserAiError(`The recipe AI answered ${res.status}.`);
  if (data.stop_reason === "refusal") throw new BrowserAiError("The AI declined this request.");
  if (data.stop_reason === "max_tokens") throw new BrowserAiError("The AI answer was cut off.");
  return data;
}

const answerJson = (data) => {
  try { return JSON.parse((data.content || []).find((b) => b.type === "text")?.text || ""); } catch { return null; }
};

// Same answer shape as the server's POST /api/recipes: { recipes, rejected }.
export async function browserRecipes(body, { signal, key = getAiKey() } = {}) {
  const req = parseRequest(body);
  const data = await callClaude({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: RECIPE_LIST_SCHEMA } },
    messages: [{ role: "user", content: buildPrompt(req) }],
  }, { signal, key });
  const parsed = answerJson(data);
  if (!Array.isArray(parsed?.recipes)) throw new BrowserAiError("The AI returned an unreadable answer.");
  const { kept, rejected } = screen(parsed.recipes, { schoolNutFree: req.schoolNutFree });
  const stamp = Date.now().toString(36);
  return { recipes: kept.map((r, i) => ({ ...r, id: `ai-${stamp}-${i}`, source: "ai" })), rejected };
}

// One turn of the week-planning chat. `messages` is the whole conversation so far, ending with the
// parent's new message; the answer's full content goes back into the conversation as Claude's turn.
// The rules and the recipe book come first and are cached, so later turns cost much less.
// If Claude Opus declines, the API retries on a fallback model (server-side fallback).
export async function browserPlanChat(messages, { catalog, signal, key = getAiKey() }) {
  const data = await callClaude({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: PLAN_RULES }, { type: "text", text: catalog, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_CHAT_SCHEMA } },
    fallbacks: "default",
    messages,
  }, { signal, key, headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } });
  const parsed = answerJson(data);
  if (typeof parsed?.reply !== "string" || !Array.isArray(parsed?.changes)) throw new BrowserAiError("The AI returned an unreadable answer.");
  return { reply: parsed.reply, changes: parsed.changes, content: data.content };
}
