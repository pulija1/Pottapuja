// Family sync between two phones (SYNC-E2E), with Playwright against the Firebase emulator:
// npm run test:firebase. Each browser context is one phone. The Firebase SDK is served from
// node_modules instead of gstatic, and sign-in uses the emulator's test accounts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROJECT = process.env.GCLOUD_PROJECT || "demo-meal-planner";
const TODAY = "2026-10-22";
const tag = Date.now().toString(36);
const RAM = `ram-${tag}@example.com`;
const SITA = `sita-${tag}@example.com`;

const CONFIG = `export const firebaseConfig = ${JSON.stringify({
  apiKey: "demo-key", authDomain: "localhost", projectId: PROJECT, appId: "demo-app",
  emulator: { auth: "http://127.0.0.1:9099", host: "127.0.0.1", port: 8080 },
})};`;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

let browser, server, url;
before(async () => {
  const port = await freePort();
  server = spawn(process.execPath, [ROOT + "server.js"], { env: { ...process.env, AI_MODE: "mock", ANTHROPIC_API_KEY: "", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => { if (String(d).includes("running")) resolve(); });
    setTimeout(() => reject(new Error("server did not start")), 5000);
  });
  url = `http://127.0.0.1:${port}/?today=${TODAY}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  server?.kill();
  // Clean up: wipe the emulator's test data.
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }).catch(() => {});
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" }).catch(() => {});
});

async function phone() {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 } });
  await ctx.route("**/firebase-config.js*", (r) => r.fulfill({ contentType: "text/javascript", body: CONFIG }));
  await ctx.route("https://www.gstatic.com/firebasejs/**", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").pop();
    r.fulfill({ contentType: "text/javascript", body: readFileSync(ROOT + "node_modules/firebase/" + name, "utf8") });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByTestId("cal-grid").waitFor();
  return { ctx, page, errors };
}

const tid = (page, id) => page.getByTestId(id);
const signIn = (page, email) => page.evaluate((e) => window.__mealPlanner.cloud.signInForTest(e), email);
const cloudStatus = (page) => page.evaluate(() => window.__mealPlanner.cloud.getCloud().status);
const shopNames = (page) => page.evaluate(() => window.__mealPlanner.state.shopping.map((i) => i.name).sort());
const bought = (page, name) => page.evaluate((n) => window.__mealPlanner.state.shopping.find((i) => i.name === n)?.bought, name);

async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function addShop(page, names) {
  await tid(page, "tab-shopping").click();
  await tid(page, "shop-fab").click();
  for (const n of names) { await tid(page, "shop-name").fill(n); await tid(page, "shop-add").click(); }
  await page.keyboard.press("Escape");
}
const tick = (page, name) => page.locator(`[data-testid=shop-item][data-name="${name}"] input[type=checkbox]`).check();

let A, B;

test("SYNC-E2E-01 first launch offers Google sign-in; this phone's data goes up when Ram starts the family space", async () => {
  A = await phone();
  await tid(A.page, "cloud-login").waitFor();
  await tid(A.page, "login-skip").click();
  await addShop(A.page, ["ghee", "rava"]);
  await signIn(A.page, RAM);
  await tid(A.page, "family-start").click();
  await waitFor(async () => (await cloudStatus(A.page)) === "synced", "phone A synced");
  assert.equal(await tid(A.page, "cloud-status").innerText(), "☁ Synced");
  assert.ok(await tid(A.page, "checkin").isHidden(), "the GitHub check-in button is replaced");
  // Add Sita to the family from the profile.
  await tid(A.page, "profile").click();
  await tid(A.page, "member-email").fill(SITA.toUpperCase());
  await tid(A.page, "member-add").click();
  await waitFor(async () => (await tid(A.page, "family-member").count()) === 2, "two family members");
  await A.page.keyboard.press("Escape");
});

test("SYNC-E2E-02 a new phone signing in as Sita gets the family's data", async () => {
  B = await phone();
  await signIn(B.page, SITA);
  await waitFor(async () => (await cloudStatus(B.page)) === "synced", "phone B synced");
  assert.ok(await tid(B.page, "login").isHidden());
  assert.deepEqual(await shopNames(B.page), ["ghee", "rava"]);
});

test("SYNC-E2E-03 a tick or a new item on one phone shows up on the other without a refresh", async () => {
  await tick(A.page, "ghee");
  await waitFor(() => bought(B.page, "ghee"), "ghee ticked on B");
  await addShop(B.page, ["curd"]);
  await waitFor(async () => (await shopNames(A.page)).includes("curd"), "curd on A");
  await tid(A.page, "tab-shopping").click();
  await A.page.locator('[data-testid=shop-item][data-name="curd"]').waitFor();
});

test("SYNC-E2E-04 both phones tick different items at the same moment: both ticks stay", async () => {
  await tid(B.page, "tab-shopping").click();
  await Promise.all([tick(A.page, "rava"), tick(B.page, "curd")]);
  for (const p of [A.page, B.page]) {
    await waitFor(async () => (await bought(p, "rava")) && (await bought(p, "curd")), "both ticks");
  }
});

test("SYNC-E2E-05 a phone with no signal keeps working and catches up when it's back online", async () => {
  await B.ctx.setOffline(true);
  await B.page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await addShop(B.page, ["jaggery"]);
  await addShop(A.page, ["toor dal"]);
  await waitFor(async () => (await cloudStatus(B.page)) === "offline" || (await cloudStatus(B.page)) === "saving", "B shows offline");
  assert.ok(!(await shopNames(A.page)).includes("jaggery"));
  await B.ctx.setOffline(false);
  await B.page.evaluate(() => window.dispatchEvent(new Event("online")));
  for (const p of [A.page, B.page]) {
    await waitFor(async () => { const n = await shopNames(p); return n.includes("jaggery") && n.includes("toor dal"); }, "both items on both phones", 20000);
  }
});

test("SYNC-E2E-06 other tabs of data sync too: to-dos, days, kitchen and children's names", async () => {
  await A.page.evaluate(() => {
    const m = window.__mealPlanner;
    m.state.todos.push({ id: "td1", text: "Pack the school bag", who: "kid", date: "2026-10-23", time: "", done: false });
    m.state.days["2026-10-23"] = { meals: { baby_breakfast: { title: "Ragi porridge" } }, schedule: [] };
    m.state.pantry.push("jowar flour");
    m.state.settings.kidName = "Kid";
    m.cloud.syncNow();
  });
  await waitFor(() => B.page.evaluate(() => {
    const s = window.__mealPlanner.state;
    return s.todos.some((t) => t.id === "td1") && s.days["2026-10-23"]?.meals?.baby_breakfast?.title === "Ragi porridge" && s.pantry.includes("jowar flour") && s.settings.kidName === "Kid";
  }), "to-do, day, kitchen and names on B");
  // The calendar on B shows the synced to-do on that date without a reload.
  await tid(B.page, "tab-calendar").click();
  await B.page.locator('[data-testid="cal-day-2026-10-23"]').click();
  await B.page.getByText("Pack the school bag").first().waitFor();
});

test("SYNC-E2E-07 after a reload the phone is still signed in and synced, with nothing duplicated", async () => {
  await B.page.reload();
  await B.page.getByTestId("cal-grid").waitFor();
  await waitFor(async () => (await cloudStatus(B.page)) === "synced", "B synced after reload");
  const names = await shopNames(B.page);
  assert.deepEqual(names, ["curd", "ghee", "jaggery", "rava", "toor dal"]);
  await tick(A.page, "toor dal");
  await waitFor(() => bought(B.page, "toor dal"), "tick after reload");
});

test("SYNC-E2E-08 removing Sita from the family stops her phone syncing, and keeps her data", async () => {
  await tid(A.page, "profile").click();
  const rm = tid(A.page, "member-remove");
  await rm.click();
  await rm.click();
  await waitFor(async () => (await tid(A.page, "family-member").count()) === 1, "one member left");
  await A.page.keyboard.press("Escape");
  await tid(B.page, "no-family").waitFor();
  assert.match(await tid(B.page, "no-family").innerText(), /no longer in the family/);
  assert.equal((await shopNames(B.page)).length, 5);
  // A's later changes don't reach B.
  await addShop(A.page, ["salt"]);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!(await shopNames(B.page)).includes("salt"));
});

test("SYNC-E2E-09 signing out keeps this phone's data; Export backup is still there", async () => {
  await tid(A.page, "profile").click();
  await tid(A.page, "profile-export").waitFor();
  await tid(A.page, "cloud-signout").click();
  await waitFor(async () => (await cloudStatus(A.page)) === "signed-out", "A signed out");
  assert.ok((await shopNames(A.page)).includes("salt"));
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close();
  await B.ctx.close();
});
