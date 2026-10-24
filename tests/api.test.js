// HTTP API against a real server process (REC, OFF, DATA). The AI is mocked or switched off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { rateLimiter } from "../server.js";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ANTHROPIC_API_KEY: "", ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => { if (String(d).includes("running")) resolve(); });
    proc.on("exit", (c) => reject(new Error("server exited " + c)));
    setTimeout(() => reject(new Error("server did not start")), 5000);
  });
  return { url: `http://127.0.0.1:${port}`, proc };
}

let mock, off;
before(async () => { [mock, off] = await Promise.all([startServer({ AI_MODE: "mock" }), startServer({ AI_MODE: "off" })]); });
after(() => { mock?.proc.kill(); off?.proc.kill(); });

const post = (base, body, raw = false) => fetch(base + "/api/recipes", {
  method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body),
});

test("API-01 health reports the AI mode", async () => {
  assert.deepEqual(await (await fetch(mock.url + "/api/health")).json(), { ok: true, ai: "mock", model: null });
  assert.equal((await (await fetch(off.url + "/api/health")).json()).ai, "off");
});

test("REC-01 baby recipes from a South Indian pantry are all safe and soft", async () => {
  const res = await post(mock.url, { ingredients: ["rice", "moong dal", "carrot", "ragi flour", "banana", "ghee"], forWhom: "baby", count: 4 });
  assert.equal(res.status, 200);
  const { recipes } = await res.json();
  assert.ok(recipes.length > 0);
  for (const r of recipes) {
    assert.equal(r.forWhom, "baby", r.title);
    assert.equal(r.safety.safe, true, r.title);
    assert.match(r.texture, /puree|mash|porridge|soft/i, r.title);
  }
});

test("REC-02 lunchbox recipes for the 4-year-old are nut-free", async () => {
  const { recipes } = await (await post(mock.url, { ingredients: ["rice", "lemon", "rava", "idli/dosa batter"], forWhom: "kid", mealType: "lunchbox", schoolNutFree: true })).json();
  assert.ok(recipes.length > 0);
  for (const r of recipes) assert.ok(!r.ingredients.some((i) => /nut|cashew|almond|badam|kaju/i.test(i.name) && !/coconut/i.test(i.name)), r.title);
});

test("REC-04 empty pantry still answers", async () => {
  const res = await post(mock.url, { ingredients: [] });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).recipes));
});

test("REC-05/06 junk, huge and odd input is bounded, never a 500", async () => {
  const bodies = [
    { ingredients: "rice" }, { ingredients: [null, 5, {}, "tamrind", "kariveppilai"] },
    { ingredients: Array.from({ length: 200 }, (_, i) => "item" + i), count: 999 },
    { ingredients: ["x".repeat(1000)], forWhom: "dog", mealType: "brunch", count: -3 },
    { ingredients: ["<script>alert(1)</script>", "కరివేపాకు", "கறிவேப்பிலை", "🍌"] },
    [], null, "string",
  ];
  for (const b of bodies) {
    const res = await post(mock.url, b);
    assert.equal(res.status, 200, JSON.stringify(b).slice(0, 80));
    const out = await res.json();
    assert.ok(out.recipes.length <= 6);
  }
});

test("DATA-03 bad JSON is a 400 with a message", async () => {
  const res = await post(mock.url, "{not json", true);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test("DATA-03b a body over 32 KB gets a 413 answer, not a dropped connection", async () => {
  let res;
  try { res = await post(mock.url, { ingredients: ["x".repeat(40000)] }); }
  catch (e) { assert.fail("connection dropped instead of a 413: " + (e.cause?.code || e.message)); }
  assert.equal(res.status, 413);
});

test("DATA-03c wrong method and unknown routes", async () => {
  assert.equal((await fetch(mock.url + "/api/recipes")).status, 405);
  assert.equal((await fetch(mock.url + "/api/nope")).status, 404);
  assert.equal((await fetch(mock.url + "/index.html", { method: "DELETE" })).status, 405);
});

test("DATA-03d a malformed URL gets a 4xx and does not crash the server", async () => {
  const own = await startServer({ AI_MODE: "mock" });
  try {
    let status = 0;
    try { status = (await fetch(own.url + "/%E0%A4%A")).status; } catch { /* connection dropped */ }
    assert.ok(status >= 400 && status < 500, "got " + (status || "no response"));
    const health = await fetch(own.url + "/api/health").catch(() => null);
    assert.ok(health?.ok, "server died after one bad URL");
  } finally { own.proc.kill(); }
});

test("DATA-04 path traversal is blocked", async () => {
  for (const p of ["/..%2fserver.js", "/%2e%2e/server.js", "/..%2f..%2fetc/passwd"]) {
    const res = await fetch(mock.url + p);
    assert.ok([403, 404].includes(res.status), p + " -> " + res.status);
    assert.ok(!(await res.text()).includes("createServer"), p);
  }
});

test("DATA-05 no API key or secret in responses or client files", async () => {
  // The app mentions the "sk-ant-" prefix to help people paste their own key; an actual key never ships.
  const files = ["/", "/app.js", "/store.js", "/ai-browser.js", "/shared/ai-prompt.js", "/shared/safety.js", "/shared/recipes.js"];
  for (const f of files) {
    const text = await (await fetch(mock.url + f)).text();
    assert.ok(!/sk-ant-[\w-]{20,}|ANTHROPIC_API_KEY/.test(text), f);
  }
});

test("OFF-01 with the AI off the endpoint answers 503 with a reason, and the app still loads", async () => {
  const res = await post(off.url, { ingredients: ["rice"] });
  assert.equal(res.status, 503);
  assert.ok((await res.json()).error);
  assert.equal((await fetch(off.url + "/")).status, 200);
});

test("OFF-01b live mode with no key fails fast with 503, not a hang", async () => {
  const live = await startServer({ AI_MODE: "live", ANTHROPIC_API_KEY: "", AI_TIMEOUT_MS: "5000" });
  try {
    const t = Date.now();
    const res = await post(live.url, { ingredients: ["rice"] });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - t < 8000);
  } finally { live.proc.kill(); }
});

test("BOOK-10 the server serves the Markdown recipe book at /recipes/, and nothing outside it", async () => {
  const res = await fetch(mock.url + "/recipes/kid-4-years.md");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/markdown/);
  assert.match(await res.text(), /^### /m);
  for (const p of ["/recipes/..%2fserver.js", "/recipes/%2e%2e/package.json"]) {
    const bad = await fetch(mock.url + p);
    assert.ok([403, 404].includes(bad.status), p + " -> " + bad.status);
  }
});

test("DATA-06 every answer carries nosniff, no-referrer and no-framing headers", async () => {
  for (const p of ["/", "/app.js", "/api/health", "/nope"]) {
    const res = await fetch(mock.url + p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", p);
    assert.equal(res.headers.get("x-frame-options"), "DENY", p);
  }
});

test("DATA-07 the live-AI rate limit allows the limit per minute, then refuses until the window resets", () => {
  const allow = rateLimiter(3, 60000);
  assert.deepEqual([1, 2, 3, 4].map(() => allow("1.2.3.4", 1000)), [true, true, true, false]);
  assert.equal(allow("5.6.7.8", 1000), true, "other visitors are counted separately");
  assert.equal(allow("1.2.3.4", 61000), true, "a new minute starts fresh");
});
