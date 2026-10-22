// AI recipes straight from the browser with the family's own Claude API key, for sites with no
// server (GitHub Pages). The key lives only in this browser under its own storage key, so it
// never goes into backups or check-ins. This is a static site with no build step, so it calls the
// Messages API with fetch rather than the Node SDK the server uses.

import { SYSTEM, MODEL, RECIPE_LIST_SCHEMA, buildPrompt, parseRequest, screen } from "./shared/ai-prompt.js";

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

// Same answer shape as the server's POST /api/recipes: { recipes, rejected }.
export async function browserRecipes(body, { signal, key = getAiKey() } = {}) {
  if (!key) throw new BrowserAiError("Add a Claude API key in 👤 Profile to get AI recipes.", "nokey");
  const req = parseRequest(body);
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
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: "low", format: { type: "json_schema", schema: RECIPE_LIST_SCHEMA } },
        messages: [{ role: "user", content: buildPrompt(req) }],
      }),
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
  let parsed;
  try { parsed = JSON.parse((data.content || []).find((b) => b.type === "text")?.text || ""); } catch {}
  if (!Array.isArray(parsed?.recipes)) throw new BrowserAiError("The AI returned an unreadable answer.");
  const { kept, rejected } = screen(parsed.recipes, { schoolNutFree: req.schoolNutFree });
  const stamp = Date.now().toString(36);
  return { recipes: kept.map((r, i) => ({ ...r, id: `ai-${stamp}-${i}`, source: "ai" })), rejected };
}
