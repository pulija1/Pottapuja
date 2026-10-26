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

// Reads a streamed Messages API answer (server-sent events) back into one message. Phone browsers
// drop a request that sends nothing for about a minute (Safari on iPhone does), and a week plan
// can take longer than that, so the answer streams in as Claude writes it.
async function readStream(res) {
  const msg = { content: [] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (ev) => {
    if (ev.type === "message_start") Object.assign(msg, ev.message, { content: [] });
    else if (ev.type === "content_block_start") msg.content[ev.index] = { ...ev.content_block };
    else if (ev.type === "content_block_delta") {
      const b = msg.content[ev.index], d = ev.delta;
      if (d.type === "text_delta") b.text = (b.text || "") + d.text;
      else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = d.signature;
    } else if (ev.type === "message_delta") Object.assign(msg, ev.delta);
    else if (ev.type === "error") throw new BrowserAiError(ev.error?.type === "overloaded_error" ? "The recipe AI is busy right now." : "The recipe AI stopped part way. Try again.", "busy");
  };
  for (;;) {
    const { done, value } = await reader.read();
    buf += decoder.decode(value || new Uint8Array(), { stream: !done });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      buf = buf.slice(i + 2);
      if (data) handle(JSON.parse(data));
    }
    if (done) break;
  }
  msg.content = msg.content.filter(Boolean);
  return msg;
}

// One Messages API request with the family's key. Returns the whole answer, or throws a
// BrowserAiError with a message the parent can act on.
async function callClaude(payload, { signal, key = getAiKey(), headers = {} } = {}) {
  if (!key) throw new BrowserAiError("Add a Claude API key in 👤 Profile to get AI recipes.", "nokey");
  let res, data;
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
      body: JSON.stringify({ ...payload, stream: true }),
    });
    const streamed = res.ok && /event-stream/.test(res.headers.get("content-type") || "");
    data = streamed ? await readStream(res) : await res.json().catch(() => ({}));
  } catch (err) {
    if (signal?.aborted || err instanceof BrowserAiError) throw err;
    throw new BrowserAiError("Couldn't reach the recipe AI. Check the internet connection, keep the app open while it thinks, and try again.", "network");
  }
  if (res.status === 401) throw new BrowserAiError("The Claude API key was not accepted. Check it in 👤 Profile.", "auth");
  if (res.status === 403) throw new BrowserAiError("The Claude API key isn't allowed to do this. Check the key's workspace in the Claude Console.", "auth");
  if (res.status === 400 && /credit|billing/i.test(data?.error?.message || "")) throw new BrowserAiError("The Claude account is out of credit. Add credit in the Claude Console.", "billing");
  if (res.status === 429 || res.status === 529) throw new BrowserAiError("The recipe AI is busy right now.", "busy");
  if (!res.ok) throw new BrowserAiError(`The recipe AI answered ${res.status}${data?.error?.message ? `: ${data.error.message}` : ""}.`);
  if (data.stop_reason === "refusal") throw new BrowserAiError("The AI declined this request.");
  if (data.stop_reason === "max_tokens") throw new BrowserAiError("The AI answer was cut off.");
  return data;
}

// After a fallback part way through an answer, the thinking from the model that declined can't go
// back into the conversation; text and everything after the last switch can.
function echoContent(content) {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  return content.filter((b, i) => i > last || !["thinking", "redacted_thinking", "tool_use"].includes(b.type));
}

// The answer is the text; after a fallback part way through, it is the declined part plus the rest.
const answerJson = (data) => {
  const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "");
  for (const t of [texts.join(""), texts.at(-1)]) {
    try { return JSON.parse(t || ""); } catch {}
  }
  return null;
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
  return { reply: parsed.reply, changes: parsed.changes, content: echoContent(data.content) };
}
