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
// Waits for the Firebase SDK to load before signing in with an emulator test account.
async function signIn(page, email) {
  await page.waitForFunction(() => !["off", "loading"].includes(window.__mealPlanner.cloud.getCloud().status));
  await page.evaluate((e) => window.__mealPlanner.cloud.signInForTest(e), email);
}
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
  // Joining needs a yes, after seeing who started the space.
  await tid(B.page, "choose-family").waitFor();
  assert.match(await tid(B.page, "family-choice").innerText(), new RegExp(`Started by ${RAM}`));
  await tid(B.page, "family-join").click();
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

test("SYNC-E2E-06 other tabs of data sync too: to-dos, days, freezer, kitchen and children's names", async () => {
  await A.page.evaluate(() => {
    const m = window.__mealPlanner;
    m.state.todos.push({ id: "td1", text: "Pack the school bag", who: "kid", date: "2026-10-23", time: "", done: false });
    m.state.days["2026-10-23"] = { meals: { baby_breakfast: { title: "Ragi porridge" } }, schedule: [] };
    m.state.pantry.push("jowar flour");
    m.state.frozen.push({ id: "fz1", name: "Parathas", qty: 4, unit: "packs", date: "2026-10-20", note: "" });
    m.state.settings.kidName = "Kid";
    m.cloud.syncNow();
  });
  await waitFor(() => B.page.evaluate(() => {
    const s = window.__mealPlanner.state;
    return s.todos.some((t) => t.id === "td1") && s.days["2026-10-23"]?.meals?.baby_breakfast?.title === "Ragi porridge" && s.pantry.includes("jowar flour") && s.frozen.some((i) => i.id === "fz1") && s.settings.kidName === "Kid";
  }), "to-do, day, freezer, kitchen and names on B");
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

// Scenarios from the two-phone and single-phone test rounds.
async function freshFamily(owner, seed) {
  const p = await phone(seed);
  await signIn(p.page, owner);
  await tid(p.page, "family-start").click();
  await waitFor(async () => (await cloudStatus(p.page)) === "synced", "owner synced");
  return p;
}
const seedWith = (shopping, extra = {}) => ({ version: 1, pantry: ["rice"], savedRecipes: [], days: {}, shopping, stores: ["Indian grocery"], todos: [], reminders: [], notified: {}, settings: { schoolNutFree: false, kidName: "", babyName: "" }, updatedAt: "2026-10-20T10:00:00.000Z", ...extra });

async function phoneWithSeed(seed) {
  const p = await phone();
  await p.page.evaluate((s) => { localStorage.setItem("familyMealPlanner.v1", s); }, JSON.stringify(seed));
  await p.page.reload();
  await p.page.getByTestId("cal-grid").waitFor();
  return p;
}

test("SYNC-E2E-10 a stranger who lists your email can't pull your phone in: you see who started it and can say no", async () => {
  const stranger = `stranger-${tag}@example.com`, victim = `victim-${tag}@example.com`;
  const S = await freshFamily(stranger);
  await S.page.evaluate((e) => window.__mealPlanner.cloud.addMember(e), victim);
  const V = await phoneWithSeed(seedWith([{ id: "p1", name: "private item", bought: false }]));
  await signIn(V.page, victim);
  await tid(V.page, "choose-family").waitFor();
  assert.match(await tid(V.page, "choose-family").innerText(), new RegExp(`Started by ${stranger}`));
  await tid(V.page, "family-decline").click();
  await tid(V.page, "no-family").waitFor();
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!(await shopNames(S.page)).includes("private item"), "nothing was uploaded to the stranger");
  await S.ctx.close(); await V.ctx.close();
});

test("SYNC-E2E-11 a removed member who is added back doesn't bring back what the family deleted", async () => {
  const owner = `own11-${tag}@example.com`, mem = `mem11-${tag}@example.com`;
  const O = await freshFamily(owner);
  await addShop(O.page, ["old item"]);
  await O.page.evaluate((e) => window.__mealPlanner.cloud.addMember(e), mem);
  const M = await phone();
  await signIn(M.page, mem);
  await tid(M.page, "family-join").click();
  await waitFor(async () => (await shopNames(M.page)).includes("old item"), "member has the item");
  await addShop(M.page, ["own edit"]);   // makes the member's phone "used"
  await waitFor(async () => (await shopNames(O.page)).includes("own edit"), "owner has the member's item");
  await O.page.evaluate((e) => window.__mealPlanner.cloud.removeMember(e), mem);
  await tid(M.page, "no-family").waitFor();
  await O.page.evaluate(() => { const m = window.__mealPlanner; m.state.shopping = []; m.cloud.syncNow(); });
  await O.page.evaluate((e) => window.__mealPlanner.cloud.addMember(e), mem);
  await tid(M.page, "family-check").click();
  await waitFor(async () => (await cloudStatus(M.page)) === "synced", "member back in sync");
  await waitFor(async () => (await shopNames(M.page)).length === 0, "member's list follows the family's deletes");
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(await shopNames(O.page), []);
  await O.ctx.close(); await M.ctx.close();
});

test("SYNC-E2E-12 on a shared phone, a different account starting a space starts it fresh", async () => {
  const first = `first12-${tag}@example.com`, second = `second12-${tag}@example.com`;
  const P = await phone();
  await signIn(P.page, first);
  await tid(P.page, "family-start").click();
  await waitFor(async () => (await cloudStatus(P.page)) === "synced", "first synced");
  await addShop(P.page, ["family one item"]);
  await P.page.evaluate(() => window.__mealPlanner.cloud.signOutCloud());
  await signIn(P.page, second);
  await tid(P.page, "family-start-fresh").click();
  await waitFor(async () => (await cloudStatus(P.page)) === "synced", "second synced");
  assert.deepEqual(await shopNames(P.page), []);
  await P.ctx.close();
});

test("SYNC-E2E-13 Undo after Clear the cart keeps what the other phone added meanwhile; Offline shows while offline", async () => {
  const owner = `own13-${tag}@example.com`, mem = `mem13-${tag}@example.com`;
  const O = await freshFamily(owner);
  await addShop(O.page, ["milk"]);
  await tick(O.page, "milk");
  await O.page.evaluate((e) => window.__mealPlanner.cloud.addMember(e), mem);
  const M = await phone();
  await signIn(M.page, mem);
  await tid(M.page, "family-join").click();
  await waitFor(async () => (await shopNames(M.page)).includes("milk"), "member synced");
  await tid(O.page, "shop-cart").locator("summary").click();
  await tid(O.page, "clear-bought").click();
  await addShop(M.page, ["jaggery"]);
  await waitFor(async () => (await shopNames(O.page)).includes("jaggery"), "jaggery on owner");
  await tid(O.page, "toast-undo").click();
  await waitFor(async () => (await shopNames(M.page)).includes("milk"), "milk back on member");
  assert.deepEqual(await shopNames(O.page), ["jaggery", "milk"]);
  await M.ctx.setOffline(true);
  await M.page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await addShop(M.page, ["salt"]);
  await waitFor(async () => (await tid(M.page, "cloud-status").innerText()) === "☁ Offline", "Offline label");
  await M.ctx.setOffline(false);
  await M.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(async () => (await shopNames(O.page)).includes("salt"), "salt after reconnecting", 20000);
  await O.ctx.close(); await M.ctx.close();
});

test("SYNC-E2E-14 the same list, names, day or item changed on both phones at once (one of them offline): nothing is lost", async () => {
  const owner = `own14-${tag}@example.com`, mem = `mem14-${tag}@example.com`;
  const O = await freshFamily(owner);
  await O.page.evaluate((e) => window.__mealPlanner.cloud.addMember(e), mem);
  await O.page.evaluate(() => { const m = window.__mealPlanner; m.state.shopping.push({ id: "m1", name: "milk", quantity: 1, unit: "l", bought: false }); m.state.days["2026-10-25"] = { meals: {}, schedule: [] }; m.cloud.syncNow(); });
  const M = await phone();
  await signIn(M.page, mem);
  await tid(M.page, "family-join").click();
  await waitFor(() => M.page.evaluate(() => window.__mealPlanner.state.shopping.some((i) => i.id === "m1")), "member synced");
  const both = (a, b) => Promise.all([O.page.evaluate(a), M.page.evaluate(b)]);
  await both(
    () => { const s = window.__mealPlanner.state; s.pantry.push("methi"); s.settings.kidName = "Kiran"; s.days["2026-10-25"].meals.baby_breakfast = { title: "Ragi porridge" }; s.shopping[0].quantity = 3; window.__mealPlanner.cloud.syncNow(); },
    () => { const s = window.__mealPlanner.state; s.pantry.push("jeera"); s.settings.babyName = "Tara"; s.days["2026-10-25"].meals.family_dinner = { title: "Rasam rice" }; s.shopping[0].bought = true; window.__mealPlanner.cloud.syncNow(); },
  );
  // Offline kitchen edit on the member's phone while the owner adds one online.
  await M.ctx.setOffline(true);
  await M.page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await M.page.evaluate(() => { window.__mealPlanner.state.pantry.push("offline-item"); window.__mealPlanner.cloud.syncNow(); });
  await O.page.evaluate(() => { window.__mealPlanner.state.pantry.push("online-item"); window.__mealPlanner.cloud.syncNow(); });
  await new Promise((r) => setTimeout(r, 1000));
  await M.ctx.setOffline(false);
  await M.page.evaluate(() => window.dispatchEvent(new Event("online")));
  const view = (p) => p.evaluate(() => { const s = window.__mealPlanner.state; return JSON.stringify({ pantry: ["methi", "jeera", "offline-item", "online-item"].filter((x) => s.pantry.includes(x)), kid: s.settings.kidName, baby: s.settings.babyName, meals: Object.keys(s.days["2026-10-25"]?.meals || {}).sort(), milk: [s.shopping[0]?.quantity, s.shopping[0]?.bought] }); });
  const want = JSON.stringify({ pantry: ["methi", "jeera", "offline-item", "online-item"], kid: "Kiran", baby: "Tara", meals: ["baby_breakfast", "family_dinner"], milk: [3, true] });
  for (const p of [O.page, M.page]) await waitFor(async () => (await view(p)) === want, "both phones have every change", 20000);
  await O.ctx.close(); await M.ctx.close();
});
