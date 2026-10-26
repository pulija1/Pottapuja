// Browser tests with Playwright + Chromium. Run with: npm run test:e2e
// The server runs with AI_MODE=mock (and a second one with AI_MODE=off); "today" is pinned with ?today=.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

const SERVER = fileURLToPath(new URL("../../server.js", import.meta.url));
const TODAY = "2026-10-22"; // a Thursday (school day)
const TOMORROW = "2026-10-23";

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function startServer(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ANTHROPIC_API_KEY: "", ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => { if (String(d).includes("running")) resolve(); });
    setTimeout(() => reject(new Error("server did not start")), 5000);
  });
  return { url: `http://127.0.0.1:${port}/`, proc };
}

let browser, mock, off;
before(async () => {
  [mock, off] = await Promise.all([startServer({ AI_MODE: "mock" }), startServer({ AI_MODE: "off" })]);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); mock?.proc.kill(); off?.proc.kill(); });

// A browser context. Family sync isn't configured here, so there is no sign-in page
// (tests/firebase/ covers sync against the Firebase emulator).
// These tests cover the app on one device; family sync has its own tests against the Firebase
// emulator (npm run test:firebase), so the real project's settings are switched off here.
// The calendar opens on one week by default; most tests click dates across the month, so they use the month view.
async function newContext({ weekView = false, ...opts } = {}) {
  const ctx = await browser.newContext(opts);
  if (!weekView) await ctx.addInitScript(() => { try { localStorage.setItem("mealPlanner.calView", "month"); } catch {} });
  await ctx.route("**/firebase-config.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "export const firebaseConfig = null;" }));
  return ctx;
}

// Fresh browser context per test so localStorage starts empty. Collects console errors.
async function open(server = mock, { today = TODAY, viewport } = {}) {
  const ctx = await newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${server.url}?today=${today}`);
  await page.getByTestId("cal-grid").waitFor();
  await unfoldAll(page);
  return { page, ctx, errors };
}

// Sections start folded to save scrolling. The app remembers what the parent opens, so opening
// every section once on each tab lets the tests below reach the fields inside them.
// (UI-20 checks the folded defaults.) Call it again after a reload.
async function unfoldAll(page) {
  for (const t of ["recipes", "shopping", "frozen", "reminders", "calendar"]) {
    await page.getByTestId("tab-" + t).click();
    await page.evaluate(() => {
      for (const s of document.querySelectorAll(".view:not([hidden]) details.section:not([open]) > summary, .view:not([hidden]) details.suggest-list:not([open]) > summary")) s.click();
    });
  }
}
const tid = (page, id) => page.getByTestId(id);
const cell = (page, date) => tid(page, `cal-day-${date}`);
const pendingTypes = (page) => page.locator("[data-testid=day-pending] li").evaluateAll((els) => els.map((e) => e.dataset.type));

// The shopping list adds items in a bottom sheet: open it, add each item, close it.
async function addShopItems(page, names) {
  await tid(page, "shop-fab").click();
  for (const n of names) { await tid(page, "shop-name").fill(n); await tid(page, "shop-add").click(); }
  await page.keyboard.press("Escape");
}

async function addFrozen(page, name) {
  await tid(page, "tab-frozen").click();
  await tid(page, "frozen-fab").click();
  await tid(page, "frozen-name").fill(name);
  await tid(page, "frozen-add").click();
}

async function openGroup(page, slot) {
  const group = tid(page, `meal-group-${slot.split("_")[0]}`);
  if (!(await group.evaluate((d) => d.open))) await group.locator("summary").click();
}

async function planSlot(page, date, slot, title) {
  await cell(page, date).click();
  await openGroup(page, slot);
  const input = tid(page, `slot-${slot}`);
  await input.fill(title);
  await input.press("Tab");
  await page.waitForTimeout(50);
}

test("E2E CAL-01/11 calendar shows the pinned month and highlights today", async () => {
  const { page, ctx, errors } = await open();
  assert.match(await tid(page, "cal-month").innerText(), /October 2026/);
  assert.equal(await cell(page, TODAY).count(), 1);
  assert.equal(await cell(page, TODAY).getAttribute("data-status"), "empty");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CAL-02/03/04 plan a day, approve it, edit it, re-approve", async () => {
  const { page, ctx, errors } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Ragi porridge (ragi kanji)");
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "pending");
  assert.equal(await tid(page, "day-status").getAttribute("data-status"), "pending");
  assert.ok((await pendingTypes(page)).includes("approval"));

  await tid(page, "approve-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  assert.equal(await tid(page, "day-status").getAttribute("data-status"), "approved");
  assert.ok(!(await pendingTypes(page)).includes("approval"));

  await planSlot(page, TOMORROW, "family_dinner", "Sambar rice");
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "pending");
  assert.match(await tid(page, "day-pending").innerText(), /changed after approval/i);

  await tid(page, "approve-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  await tid(page, "unapprove-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "pending");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CAL-05/06 clicking a date lists what is pending: plan and to-dos", async () => {
  const { page, ctx } = await open();
  await cell(page, TODAY).click();
  await tid(page, "day-todo-input").fill("Check school schedule");
  await tid(page, "day-todo-add").click();
  const t = await pendingTypes(page);
  assert.ok(t.includes("plan"), "no 'No meal plan yet'");
  assert.ok(t.includes("todo"), "the new to-do is not pending");
  assert.ok(Number(await cell(page, TODAY).getAttribute("data-pending")) >= 2);
  await ctx.close();
});

test("E2E CAL-07 approving a day where the baby slot has honey warns or blocks", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Honey ragi porridge");
  let dialogSeen = false;
  page.on("dialog", async (d) => { dialogSeen = true; await d.dismiss(); });
  await tid(page, "approve-day").click();
  await page.waitForTimeout(200);
  const status = await cell(page, TOMORROW).getAttribute("data-status");
  const panel = await tid(page, "day-panel").innerText();
  assert.ok(dialogSeen || status !== "approved" || /honey|not safe|safety/i.test(panel),
    "a baby meal with honey was approved with no warning");
  await ctx.close();
});

test("E2E DATA-01 plan and approval survive a reload", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "kid_lunchbox", "Lemon rice (nimmakaya pulihora)");
  await tid(page, "approve-day").click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.getByTestId("cal-grid").waitFor();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  await ctx.close();
});

test("E2E REC-01 generate baby recipes (mock AI): all marked safe", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("baby");
  await tid(page, "generate-recipes").click();
  await tid(page, "recipe-card").first().waitFor({ timeout: 5000 });
  const safe = await tid(page, "recipe-card").evaluateAll((els) => els.map((e) => e.dataset.safe));
  assert.ok(safe.length > 0);
  assert.ok(safe.every((s) => s === "true"), JSON.stringify(safe));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E QUICK-03 the Quick option asks for one recipe and shows just one", async () => {
  const { page, ctx, errors } = await open();
  const bodies = [];
  await page.route("**/api/recipes", async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("kid");
  await tid(page, "gen-meal").selectOption("breakfast");
  await tid(page, "gen-quick").check();
  assert.match(await tid(page, "generate-recipes").innerText(), /quick recipe/);
  await tid(page, "generate-recipes").click();
  await tid(page, "recipe-card").first().waitFor({ timeout: 5000 });
  assert.equal(await tid(page, "recipe-card").count(), 1);
  assert.equal(bodies[0].quick, true);
  assert.equal(bodies[0].count, 1);
  assert.ok(await tid(page, "gen-quick").isChecked(), "stays ticked after the results come in");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E TEL-01 Telugu vegetables can be added to the kitchen by their Telugu names", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  const group = tid(page, "quick-telugu-veg");
  await group.locator("summary").click();
  await group.getByRole("button", { name: "+ Vankaya (brinjal)" }).click();
  assert.match(await tid(page, "pantry-list").innerText(), /Vankaya \(brinjal\)/);
  assert.equal(await group.getByRole("button", { name: "+ Vankaya (brinjal)" }).count(), 0, "chip goes once added");
  await group.getByRole("button", { name: "+ Bendakaya (okra)" }).click();   // the group stays open for the next tap
  assert.match(await tid(page, "pantry-list").innerText(), /Bendakaya \(okra\)/);
  assert.ok(await tid(page, "quick-telugu-leaves").count(), "leafy greens group is there too");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E COOK-01 a time-short cook taps bendakaya and gets a quick fry or curry, then adds potato", async () => {
  const { page, ctx, errors } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-recipes").click();
  const card = tid(page, "cook-by-veg");
  assert.ok(await tid(page, "cook-quick").isChecked(), "quick is on by default");
  await card.getByRole("button", { name: "Bendakaya (okra)" }).click();
  const fries = await tid(page, "cook-fry").locator("[data-testid=cook-recipe]").allInnerTexts();
  const curries = await tid(page, "cook-curry").locator("[data-testid=cook-recipe]").allInnerTexts();
  assert.ok(fries.length && fries.every((t) => /⚡ (1\d|20|\d) min/.test(t)), fries.join(" | "));
  assert.ok(fries.some((t) => /bendakaya vepudu/i.test(t)), fries.join(" | "));
  assert.ok(curries.some((t) => /Bendakaya tomato kura/.test(t)), curries.join(" | "));
  // Two vegetables: the recipe with both comes first.
  await card.getByRole("button", { name: "Bangaladumpa (potato)" }).click();
  assert.match(await tid(page, "cook-fry").locator("[data-testid=cook-recipe]").first().innerText(), /Aloo bendakaya vepudu/);
  await tid(page, "cook-fry").locator("[data-testid=cook-recipe]").first().click();
  assert.match(await page.locator("dialog[open]").innerText(), /Aloo bendakaya vepudu/);
  await page.keyboard.press("Escape");
  // Unticking quick shows the slower ones too.
  const quickCount = await tid(page, "cook-recipe").count();
  await tid(page, "cook-quick").uncheck();
  assert.ok(await tid(page, "cook-recipe").count() > quickCount, "slower recipes appear");
  // Gongura has no fry: the card says so instead of showing nothing.
  await card.getByRole("button", { name: "Clear" }).click();
  await tid(page, "cook-quick").check();
  await card.getByRole("button", { name: /Gongura/ }).click();
  assert.ok(await tid(page, "cook-fry-none").count(), "no fry message");
  assert.match(await tid(page, "cook-curry").innerText(), /Gongura pappu/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E COOK-02 ladies finger typed into the kitchen is the okra chip, and its recipes say what else to buy", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("ladies finger");
  await tid(page, "pantry-add").click();
  const chip = tid(page, "cook-by-veg").getByRole("button", { name: /Bendakaya \(okra\)/ });
  assert.match(await chip.innerText(), /🏠/, "marked as in the kitchen");
  await chip.click();
  assert.equal(await chip.getAttribute("aria-pressed"), "true");
  const rows = await tid(page, "cook-recipe").allInnerTexts();
  assert.ok(rows.length >= 2 && rows.every((t) => /okra|bendakaya/i.test(t)), rows.join(" | "));
  assert.ok(rows.some((t) => /need .*potato/.test(t)), "a missing item is named: " + rows.join(" | "));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E REC-10 double-clicking Get recipes sends one request", async () => {
  const { page, ctx } = await open();
  let calls = 0;
  await page.route("**/api/recipes", async (route) => { calls++; await new Promise((r) => setTimeout(r, 300)); await route.continue(); });
  await tid(page, "tab-recipes").click();
  await tid(page, "generate-recipes").dblclick();
  await tid(page, "recipe-card").first().waitFor({ timeout: 5000 });
  assert.equal(calls, 1);
  await ctx.close();
});

test("E2E REC-11 save a recipe and it is still there after reload", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "generate-recipes").click();
  await tid(page, "save-recipe").first().click();
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-recipes").click();
  assert.ok((await tid(page, "saved-recipes").locator("[data-testid=recipe-card]").count()) >= 1);
  await ctx.close();
});

test("E2E OFF-01 AI turned off: falls back to the recipe book with a notice", async () => {
  const { page, ctx, errors } = await open(off);
  await tid(page, "tab-recipes").click();
  await tid(page, "generate-recipes").click();
  await tid(page, "ai-notice").waitFor({ timeout: 5000 });
  assert.ok((await tid(page, "recipe-card").count()) > 0);
  assert.deepEqual(errors.filter((e) => !/503/.test(e)), []);
  await ctx.close();
});

test("E2E OFF-02 AI returns 500 or the network fails: fallback, app keeps working", async () => {
  for (const mode of ["500", "abort"]) {
    const { page, ctx } = await open();
    await page.route("**/api/recipes", (route) => mode === "500"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
      : route.abort("failed"));
    await tid(page, "tab-recipes").click();
    await tid(page, "generate-recipes").click();
    await tid(page, "ai-notice").waitFor({ timeout: 5000 });
    assert.ok((await tid(page, "recipe-card").count()) > 0, mode);
    await tid(page, "tab-calendar").click();
    await tid(page, "cal-grid").waitFor();
    await ctx.close();
  }
});

test("E2E OFF-03 browser goes offline: calendar and lists still editable", async () => {
  const { page, ctx } = await open();
  await ctx.setOffline(true);
  await planSlot(page, TOMORROW, "baby_lunch", "Mashed curd rice");
  await tid(page, "approve-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["Curry leaves"]);
  assert.equal(await tid(page, "shop-item").count(), 1);
  await ctx.setOffline(false);
  await ctx.close();
});

test("E2E SHOP-02/05 add items, merge duplicates, tick bought, survives reload", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-shopping").click();
  await tid(page, "shop-fab").click();
  for (const [n, q, u] of [["Toor dal", "500", "g"], ["tuvar dal", "1", "kg"], ["Curry leaves", "", ""]]) {
    await tid(page, "shop-name").fill(n);
    await tid(page, "shop-qty").fill(q);
    if (u) await tid(page, "shop-unit").getByText(u, { exact: true }).click();
    await tid(page, "shop-add").click();
  }
  await page.keyboard.press("Escape");
  assert.equal(await tid(page, "shop-item").count(), 2);
  assert.match(await page.locator('[data-testid=shop-item][data-name="toor dal"]').innerText(), /1\.5\s*kg/);
  await page.locator('[data-testid=shop-item][data-name="curry leaves"] input[type=checkbox]').check();
  // A ticked item slides into the "In the cart" section
  await tid(page, "shop-cart").waitFor({ state: "attached" });
  assert.equal(await tid(page, "shop-cart").getByTestId("shop-item").count(), 1);
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-shopping").click();
  assert.ok(await page.locator('[data-testid=shop-item][data-name="curry leaves"] input[type=checkbox]').isChecked());
  await ctx.close();
});

test("E2E SHOP-01 approved day's meals feed the shopping list (only missing items)", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "baby_dinner", "Toor dal and vegetable soup");
  await tid(page, "approve-day").click();
  await tid(page, "day-to-shopping").click();
  await tid(page, "tab-shopping").click();
  const names = await tid(page, "shop-item").evaluateAll((els) => els.map((e) => e.dataset.name));
  assert.ok(names.includes("pumpkin"), JSON.stringify(names));
  assert.ok(!names.includes("toor dal"), "toor dal is in the default pantry");
  await ctx.close();
});

test("E2E SHOP-08 store mode at phone width: no sideways scrolling", async () => {
  const { page, ctx } = await open(mock, { viewport: { width: 375, height: 740 } });
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["Drumstick"]);
  await tid(page, "store-mode").click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page is ${overflow}px wider than the phone`);
  await ctx.close();
});

async function swipeRow(page, row, dx) {
  const box = await row.locator(".swipe-fg").boundingBox();
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
}

test("E2E SHOP-14 swipe right puts an item in the cart, swipe left deletes it, both can be undone", async () => {
  const { page, ctx, errors } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["Milk", "Eggs"]);
  const item = (n) => page.locator(`[data-testid=shop-item][data-name="${n}"]`);
  assert.equal(await item("egg").locator(".name").innerText(), "Eggs", "names show as typed");
  await swipeRow(page, item("milk"), 160);
  await tid(page, "shop-cart").waitFor({ state: "attached" });
  assert.ok(await item("milk").locator("input[type=checkbox]").isChecked());
  await tid(page, "toast-undo").click();
  await page.waitForTimeout(100);
  assert.equal(await tid(page, "shop-cart").count(), 0);
  assert.ok(!(await item("milk").locator("input[type=checkbox]").isChecked()));
  await swipeRow(page, item("egg"), -160);
  assert.equal(await item("egg").count(), 0);
  await tid(page, "toast-undo").click();
  assert.equal(await item("egg").count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E SHOP-15 the details sheet edits an item; store mode is full screen with Done shopping", async () => {
  const { page, ctx } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["Paneer"]);
  await tid(page, "shop-more").click();
  await tid(page, "shop-edit-qty").fill("400");
  await tid(page, "shop-edit-unit").getByText("g", { exact: true }).click();
  await tid(page, "shop-edit-store").getByText("Costco").click();
  await tid(page, "shop-edit-save").click();
  assert.match(await tid(page, "shop-item").innerText(), /400 g · Costco/);
  await tid(page, "store-mode").click();
  assert.ok(!(await page.locator(".tabs").isVisible()), "tabs are hidden in store mode");
  assert.match(await tid(page, "store-mode").innerText(), /Done shopping/);
  await tid(page, "shop-item").locator("label").click();
  await page.waitForTimeout(350);
  assert.match(await tid(page, "shop-empty").innerText(), /Everything is in the cart/);
  await tid(page, "store-mode").click();
  assert.ok(await page.locator(".tabs").isVisible());
  await ctx.close();
});

test("E2E SHOP-16 Back closes the sheet, then leaves store mode, without leaving the app", async () => {
  const { page, ctx } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-shopping").click();
  await tid(page, "store-mode").click();
  await tid(page, "shop-fab").click();
  await tid(page, "shop-sheet").waitFor();
  await page.goBack();
  await tid(page, "shop-sheet").waitFor({ state: "detached" });
  assert.match(await tid(page, "store-mode").innerText(), /Done shopping/);
  await page.goBack();
  await page.waitForTimeout(100);
  assert.match(await tid(page, "store-mode").innerText(), /at the store/);
  assert.match(page.url(), /#shopping$/);
  // Done shopping after a sheet was closed by its own ✕ leaves no stray history step behind
  await tid(page, "store-mode").click();
  await tid(page, "shop-fab").click();
  await page.locator("[data-testid=shop-sheet] [data-sheet-close]").click();
  await tid(page, "store-mode").click();
  await page.waitForTimeout(100);
  assert.ok(await page.locator(".tabs").isVisible());
  assert.match(page.url(), /#shopping$/);
  await ctx.close();
});

test("E2E FRZ-01 the Frozen tab replaces To do: add, use one, edit, swipe to delete, survives reload", async () => {
  const { page, ctx, errors } = await open(mock, { viewport: { width: 390, height: 844 } });
  assert.equal(await tid(page, "tab-todo").count(), 0, "the To do tab is gone");
  await tid(page, "tab-frozen").click();
  assert.ok(await tid(page, "frozen-empty").isVisible());
  await tid(page, "frozen-fab").click();
  await tid(page, "frozen-idea").filter({ hasText: "Parathas" }).click();
  assert.equal(await tid(page, "frozen-name").inputValue(), "Parathas");
  await tid(page, "frozen-qty").fill("3");
  await tid(page, "frozen-add").click();
  await tid(page, "frozen-fab").click();
  await tid(page, "frozen-name").fill("Idli batter");
  await tid(page, "frozen-unit").getByText("boxes").click();
  await tid(page, "frozen-date").fill("2026-06-01");
  await tid(page, "frozen-add").click();
  assert.equal(await tid(page, "frozen-count").innerText(), "2 items");
  // Oldest first, and food frozen months ago is flagged.
  assert.deepEqual(await page.locator("[data-testid=frozen-item] .name").allInnerTexts().then((t) => t.map((x) => x.split("\n")[0].replace(/Use soon/, "").trim())), ["Idli batter", "Parathas"]);
  assert.equal(await tid(page, "frozen-item").filter({ hasText: "Idli batter" }).getByTestId("frozen-old").count(), 1);
  assert.match(await tid(page, "frozen-item").filter({ hasText: "Idli batter" }).innerText(), /1 box · frozen 5 months ago/);
  assert.match(await tid(page, "frozen-item").filter({ hasText: "Parathas" }).innerText(), /3 packs · frozen today/);
  // Tapping the row takes one out; the undo puts it back.
  await tid(page, "frozen-item").filter({ hasText: "Parathas" }).locator(".name").click();
  assert.match(await tid(page, "frozen-item").filter({ hasText: "Parathas" }).innerText(), /2 packs/);
  await tid(page, "toast-undo").click();
  assert.match(await tid(page, "frozen-item").filter({ hasText: "Parathas" }).innerText(), /3 packs/);
  // Edit in the sheet.
  await tid(page, "frozen-item").filter({ hasText: "Parathas" }).getByTestId("frozen-more").click();
  await tid(page, "frozen-name").fill("Aloo parathas");
  await tid(page, "frozen-note").fill("for the lunchbox");
  await tid(page, "frozen-save").click();
  assert.match(await tid(page, "frozen-list").innerText(), /Aloo parathas[\s\S]*for the lunchbox/);
  // The last one taken out removes the item; swipe left deletes.
  await swipeRow(page, tid(page, "frozen-item").filter({ hasText: "Idli batter" }), 160);
  assert.equal(await tid(page, "frozen-item").count(), 1);
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-frozen").click();
  assert.equal(await tid(page, "frozen-item").count(), 1);
  await swipeRow(page, tid(page, "frozen-item"), -160);
  assert.equal(await tid(page, "frozen-item").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E FRZ-02 to-dos saved before the change are kept and still show and work on the calendar", async () => {
  const todos = [{ id: "t1", text: "Buy shoes", who: "kid", date: TOMORROW, time: "", done: false }];
  const ctx = await newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { if (!localStorage.getItem("familyMealPlanner.v1")) localStorage.setItem("familyMealPlanner.v1", JSON.stringify({ version: 1, todos: t })); }, todos);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mock.url}?today=${TODAY}#todo`);
  await tid(page, "cal-grid").waitFor();
  await unfoldAll(page);
  await cell(page, TOMORROW).click();
  const row = tid(page, "day-todos").getByTestId("todo-item");
  assert.match(await row.innerText(), /Buy shoes/);
  await row.locator(".name").click();
  assert.match(await tid(page, "day-todos").getByTestId("todo-item").getAttribute("class"), /done/);
  await tid(page, "day-todos").getByTestId("todo-more").click();
  await tid(page, "todo-input").fill("Buy school shoes");
  await tid(page, "todo-save").click();
  assert.match(await tid(page, "day-todos").innerText(), /Buy school shoes/);
  await swipeRow(page, tid(page, "day-todos").getByTestId("todo-item"), -160);
  assert.equal(await tid(page, "day-todos").getByTestId("todo-item").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CAL-12 meal sections are collapsed until opened and stay open while editing", async () => {
  const { page, ctx } = await open();
  await cell(page, TOMORROW).click();
  for (const g of ["kid", "baby", "family"]) assert.equal(await tid(page, `meal-group-${g}`).evaluate((d) => d.open), false, g);
  await planSlot(page, TOMORROW, "kid_lunchbox", "Lemon rice (nimmakaya pulihora)");
  assert.equal(await tid(page, "meal-group-kid").evaluate((d) => d.open), true);
  assert.match(await tid(page, "meal-group-kid").locator("summary").innerText(), /1 of 3 planned/);
  await ctx.close();
});

test("E2E REM-01/06 add a reminder, see it on the calendar date, mark it done", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-reminders").click();
  await tid(page, "rem-title").fill("Soak urad dal for idli batter");
  await tid(page, "rem-date").fill(TOMORROW);
  await tid(page, "rem-time").fill("20:00");
  await tid(page, "rem-add").click();
  assert.equal(await tid(page, "reminder-item").count(), 1);
  await tid(page, "tab-calendar").click();
  await cell(page, TOMORROW).click();
  assert.ok((await pendingTypes(page)).includes("reminder"));
  await page.locator('[data-action=rem-done]').first().check();
  assert.ok(!(await pendingTypes(page)).includes("reminder"));
  await ctx.close();
});

test("E2E REM-05 a reminder dated in the past is rejected or shown overdue", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-reminders").click();
  await tid(page, "rem-title").fill("Old one");
  await tid(page, "rem-date").fill("2026-10-01");
  await tid(page, "rem-add").click();
  const added = await tid(page, "reminder-item").count();
  if (added) assert.ok((await tid(page, "overdue").count()) > 0, "past reminder added without an overdue marker");
  await ctx.close();
});

test("E2E DATA-02 corrupt saved data does not white-screen the app", async () => {
  // Seed storage before the app loads; writing it on a running page loses to the pagehide save.
  for (const raw of ["{broken", JSON.stringify({ version: 1, days: "oops", reminders: null, shopping: 5, pantry: null, todos: "x", settings: 7 })]) {
    const ctx = await newContext();
    await ctx.addInitScript((r) => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("familyMealPlanner.v1", r); } }, raw);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${mock.url}?today=${TODAY}`);
    await page.waitForTimeout(500);
    assert.ok(await tid(page, "cal-grid").isVisible(), `calendar did not render for ${raw.slice(0, 30)}: ${errors.join("; ")}`);
    await ctx.close();
  }
});

test("E2E DATA-04 HTML typed into fields is shown as text, never run", async () => {
  const { page, ctx } = await open();
  const xss = `<img src=x onerror="window.__xss=1">`;
  await planSlot(page, TOMORROW, "family_dinner", xss);
  await tid(page, "tab-shopping").click();
  await addShopItems(page, [xss]);
  await tid(page, "tab-reminders").click();
  await tid(page, "rem-title").fill(xss);
  await tid(page, "rem-date").fill(TOMORROW);
  await tid(page, "rem-add").click();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill(xss);
  await tid(page, "pantry-add").click();
  await tid(page, "tab-calendar").click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ctx.close();
});

test("E2E UI-01 keyboard only: approve a planned day", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Mashed banana");
  await tid(page, "approve-day").focus();
  await page.keyboard.press("Enter");
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  await ctx.close();
});

test("E2E UI-02 pending and approved are not shown by colour alone", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Mashed banana");
  const label = await cell(page, TOMORROW).getAttribute("aria-label");
  assert.match(label || "", /pending|waiting/i);
  await ctx.close();
});

test("E2E UI-03 every tab fits a phone screen without sideways scroll", async () => {
  const { page, ctx } = await open(mock, { viewport: { width: 375, height: 740 } });
  for (const tab of ["calendar", "recipes", "shopping", "frozen", "reminders"]) {
    await tid(page, `tab-${tab}`).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${tab} tab is ${overflow}px too wide`);
  }
  await ctx.close();
});

test("E2E CAL-07b unsafe baby slot: warning on the slot, approve holds, 'Approve anyway' works", async () => {
  const { page, ctx, errors } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Honey ragi porridge");
  assert.ok((await tid(page, "slot-warning").count()) >= 1);
  await tid(page, "approve-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "pending");
  await tid(page, "day-safety").waitFor();
  await tid(page, "approve-anyway").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CAL-07c a safe day approves in one click with no safety box", async () => {
  const { page, ctx } = await open();
  await planSlot(page, TOMORROW, "baby_breakfast", "Ragi porridge (ragi kanji)");
  assert.equal(await tid(page, "slot-warning").count(), 0);
  await tid(page, "approve-day").click();
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  await ctx.close();
});

test("E2E REM-07 'School days' repeat shows on weekdays only", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-reminders").click();
  await tid(page, "rem-title").fill("Pack lunchbox");
  await tid(page, "rem-date").fill(TODAY);
  await tid(page, "rem-repeat").selectOption("weekdays");
  await tid(page, "rem-add").click();
  await tid(page, "tab-calendar").click();
  await cell(page, TOMORROW).click();
  assert.ok((await pendingTypes(page)).includes("reminder"), "Friday has no reminder");
  await cell(page, "2026-10-24").click();
  assert.ok(!(await pendingTypes(page)).includes("reminder"), "Saturday has the school reminder");
  await ctx.close();
});

test("E2E AGE-11 school nut-free setting: sent to the API and persists", async () => {
  const { page, ctx } = await open();
  let body = null;
  await page.route("**/api/recipes", async (route) => { body = JSON.parse(route.request().postData()); await route.continue(); });
  await tid(page, "tab-recipes").click();
  await tid(page, "school-nut-free").check();
  await tid(page, "gen-for").selectOption("kid");
  await tid(page, "gen-meal").selectOption("lunchbox");
  await tid(page, "generate-recipes").click();
  await tid(page, "recipe-card").first().waitFor({ timeout: 5000 });
  assert.equal(body?.schoolNutFree, true);
  assert.equal(await tid(page, "contains-nuts").count(), 0);
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-recipes").click();
  assert.ok(await tid(page, "school-nut-free").isChecked());
  await ctx.close();
});

test("E2E REC-12 recipe form keeps For and Meal after a re-render", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("kid");
  await tid(page, "gen-meal").selectOption("lunchbox");
  await tid(page, "pantry-input").fill("drumstick");
  await tid(page, "pantry-add").click();
  assert.equal(await tid(page, "gen-for").inputValue(), "kid");
  assert.equal(await tid(page, "gen-meal").inputValue(), "lunchbox");
  await ctx.close();
});

test("E2E OFF-06 AI off still shows family favorites from the recipe book", async () => {
  const { page, ctx } = await open(off);
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("family");
  await tid(page, "generate-recipes").click();
  await tid(page, "ai-notice").waitFor({ timeout: 5000 });
  assert.ok((await tid(page, "recipe-card").count()) > 0);
  await ctx.close();
});

test("E2E SHOP-09 unticking a bought item takes back only what the tick added to the kitchen", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("rice");
  await page.locator("[data-form=pantry-add] button").click();
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["paneer", "rice"]);
  const box = (n) => tid(page, "shop-item").filter({ hasText: n }).locator("input[type=checkbox]");
  for (const n of ["paneer", "rice"]) { await box(n).check(); await page.waitForTimeout(350); }
  await tid(page, "shop-cart").locator("summary").click();
  for (const n of ["paneer", "rice"]) { await box(n).uncheck(); await page.waitForTimeout(350); }
  await tid(page, "tab-recipes").click();
  const pantry = await tid(page, "pantry-list").innerText();
  assert.ok(!pantry.includes("paneer"), pantry);
  assert.ok(pantry.includes("rice"), pantry);
  await ctx.close();
});

test("E2E CAL-13 day actions refresh the cell and panel without rebuilding the month", async () => {
  const { page, ctx } = await open();
  await cell(page, TOMORROW).click();
  await page.evaluate(() => { document.querySelector("[data-testid=cal-grid]").dataset.marker = "1"; });
  await tid(page, "suggest-approve").click();
  assert.equal(await tid(page, "day-status").getAttribute("data-status"), "approved");
  assert.equal(await cell(page, TOMORROW).getAttribute("data-status"), "approved");
  assert.equal(await page.evaluate(() => document.querySelector("[data-testid=cal-grid]").dataset.marker), "1");
  await cell(page, TODAY).click();
  assert.match(await cell(page, TODAY).getAttribute("class"), /sel/);
  assert.doesNotMatch(await cell(page, TOMORROW).getAttribute("class"), /sel/);
  assert.equal(await tid(page, "day-panel").getAttribute("data-date"), TODAY);
  await ctx.close();
});

test("E2E SUG-01 approving suggestions fills the empty slots, approves the day and hides the suggestions", async () => {
  const { page, ctx, errors } = await open();
  await cell(page, "2026-10-26").click();
  assert.ok((await tid(page, "suggestion").count()) > 0);
  await tid(page, "suggest-approve").click();
  assert.equal(await cell(page, "2026-10-26").getAttribute("data-status"), "approved");
  assert.equal(await tid(page, "suggestion").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E SUG-02 suggestions never overwrite a meal you already typed", async () => {
  const { page, ctx } = await open();
  await planSlot(page, "2026-10-26", "family_dinner", "Amma's sambar");
  await tid(page, "suggest-approve").click();
  await openGroup(page, "family_dinner");
  assert.equal(await tid(page, "slot-family_dinner").inputValue(), "Amma's sambar");
  await ctx.close();
});

test("E2E SUG-03 suggestions are not offered for past days", async () => {
  const { page, ctx } = await open();
  await cell(page, "2026-10-20").click();
  assert.equal(await tid(page, "day-suggestions").count(), 0);
  await ctx.close();
});

test("E2E SHOP-13 ticking food as bought adds it to the kitchen; diapers and napkins don't", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["Drumstick", "Diapers", "Napkins"]);
  // Taps right after a tick are ignored briefly (the next row slides under the thumb), so pause between ticks.
  for (const n of ["drumstick", "diapers", "napkins"]) { await page.locator(`[data-testid=shop-item][data-name="${n}"] input[type=checkbox]`).check(); await page.waitForTimeout(350); }
  await page.waitForTimeout(300);
  const pantry = await page.evaluate(() => JSON.parse(localStorage.getItem("familyMealPlanner.v1")).pantry.map((x) => x.toLowerCase()));
  assert.ok(pantry.includes("drumstick"));
  assert.ok(!pantry.some((x) => /diaper|napkin/.test(x)), JSON.stringify(pantry));
  await ctx.close();
});

test("E2E TODO-04 saved data from the old 'To bring' version loads and keeps extra items as to-dos", async () => {
  // Seed storage before the app's first load (writing it on a running page loses to the pagehide save).
  const ctx = await newContext();
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("familyMealPlanner.v1", JSON.stringify({ version: 1, pantry: ["rice"], reminders: [], shopping: [],
      bringTemplates: { kid: ["Lunchbox"], baby: [] },
      days: { "2026-10-23": { meals: {}, schedule: [], status: "pending", extraBring: [{ id: "e1", text: "Permission slip", who: "kid" }], bring: { "kid:Lunchbox": true }, useBabyBag: true } } }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mock.url}?today=${TODAY}`);
  await tid(page, "cal-grid").waitFor();
  await cell(page, TOMORROW).click();
  assert.match(await tid(page, "day-pending").innerText(), /Permission slip/);
  await page.reload();
  await tid(page, "cal-grid").waitFor();
  await page.waitForTimeout(300);
  const todos = await page.evaluate(() => JSON.parse(localStorage.getItem("familyMealPlanner.v1")).todos);
  assert.equal(todos.filter((t) => t.text === "Permission slip").length, 1, "migrated twice");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E KIDS-01 the kids' names come from the profile (not the public code) and are used across the app", async () => {
  const { page, ctx } = await open();
  await cell(page, TOMORROW).click();
  assert.match(await tid(page, "day-panel").innerText(), /4-year-old[\s\S]*8-month-old/);
  await tid(page, "profile").click();
  await tid(page, "kid-name").fill("Kiran");
  await tid(page, "baby-name").fill("Tara");
  await tid(page, "save-names").click();
  await page.keyboard.press("Escape");
  const text = await tid(page, "day-panel").innerText();
  assert.match(text, /Kiran/);
  assert.match(text, /Tara/);
  await ctx.close();
});

test("E2E BOOT-01 if the app's scripts fail to load, the page explains and offers Reload instead of staying blank", async () => {
  const ctx = await newContext();
  await ctx.route("**/shared/plan.js*", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "export const SLOTS = [];" }));
  const page = await ctx.newPage();
  await page.goto(`${mock.url}?today=${TODAY}`);
  await tid(page, "boot-error").waitFor({ timeout: 10000 });
  assert.match(await tid(page, "boot-error").innerText(), /Reload/);
  await ctx.close();
});

test("E2E GOAL-01 each day shows egg, milk and nuts for the 4-year-old; planned meals tick them and suggestions cover them", async () => {
  const { page, ctx, errors } = await open();
  await cell(page, "2026-10-26").click();
  const goal = (g) => page.locator(`[data-testid=kid-goal][data-goal=${g}]`);
  assert.equal(await tid(page, "kid-goal").count(), 3);
  assert.equal(await goal("egg").getAttribute("data-done"), "false");
  await planSlot(page, "2026-10-26", "kid_breakfast", "Egg rava upma");
  assert.equal(await goal("egg").getAttribute("data-done"), "true");
  assert.match(await goal("egg").innerText(), /Egg rava upma/);
  // The suggestions for the other empty slots fill in milk and nuts.
  await tid(page, "suggest-approve").click();
  for (const g of ["egg", "dairy", "nuts"]) assert.equal(await goal(g).getAttribute("data-done"), "true", g);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E BOOK-12 the Recipes tab lists recipe-book recipes that the kitchen can make now", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("eggs, whole wheat bread, milk, almond powder, banana, butter");
  await tid(page, "pantry-add").click();
  assert.ok((await tid(page, "ready-recipe").count()) > 0);
  await tid(page, "ready-to-cook").getByText("French toast sticks", { exact: false }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Indian American/);
  assert.match(await dialog.innerText(), /Egg/);
  assert.equal(await tid(page, "recipe-book-problems").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E NUTR-01 a recipe shows estimated protein, carbs, fiber and iron per serving, and the child's share of the day", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("eggs, whole wheat bread, milk, almond powder, banana, butter");
  await tid(page, "pantry-add").click();
  await tid(page, "ready-to-cook").getByText("French toast sticks", { exact: false }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  const panel = dialog.getByTestId("recipe-nutrition");
  assert.match(await panel.getByTestId("nutrition-headline").innerText(), /kcal · [\d.]+ g protein · [\d.]+ mg iron/);
  await panel.locator("summary").click();
  const text = await panel.innerText();
  for (const label of ["Protein", "Carbs", "Fiber", "Fat", "Iron", "Calcium"]) assert.match(text, new RegExp(label));
  assert.match(text, /4-year-old.*day/);
  assert.match(text, /\d+%/);
  assert.match(text, /Estimated from the ingredients/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E DATA-10 a change made in another tab shows up here instead of being overwritten later", async () => {
  const a = await open();
  const other = await a.ctx.newPage();
  await other.goto(`${mock.url}?today=${TODAY}`);
  await tid(other, "cal-grid").waitFor();
  await addFrozen(other, "Parathas");
  await a.page.waitForFunction(() => window.__mealPlanner.state.frozen.some((x) => x.name === "Parathas"));
  await a.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("another tab"));
  // An edit here now keeps the other tab's freezer item.
  await addFrozen(a.page, "Green peas");
  await other.waitForFunction(() => window.__mealPlanner.state.frozen.length === 2);
  assert.deepEqual(a.errors, []);
  await a.ctx.close();
});

test("E2E DATA-11 when saving fails (storage full), a warning stays on screen until saving works again", async () => {
  const a = await open();
  assert.equal(await tid(a.page, "save-warning").isVisible(), false);
  await a.page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    window.__restoreSave = () => { Storage.prototype.setItem = orig; };
    Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); };
  });
  await addFrozen(a.page, "Parathas");
  await tid(a.page, "save-warning").waitFor();
  assert.match(await tid(a.page, "save-warning").innerText(), /aren't being saved/);
  await a.page.evaluate(() => window.__restoreSave());
  await addFrozen(a.page, "Green peas");
  await tid(a.page, "save-warning").waitFor({ state: "hidden" });
  await a.ctx.close();
});

// ---------- AI recipes with the family's own Claude API key (sites with no server, like GitHub Pages) ----------
const FAKE_KEY = "sk-ant-api03-" + "x".repeat(40);
const claudeRecipe = (o) => ({ title: "Ragi banana porridge", forWhom: "baby", mealType: "breakfast", texture: "porridge", prepMinutes: 10,
  ingredients: [{ name: "ragi flour", quantity: 2, unit: "tbsp" }, { name: "water", quantity: 1, unit: "cup" }, { name: "banana", quantity: 0.5, unit: "pcs" }],
  steps: ["Whisk ragi into water.", "Cook on low, stirring, until thick.", "Mash in banana and cool."], notes: "", ...o });

// The browser asks Claude for a streamed answer; this sends `message` back as server-sent events,
// a few characters at a time, the way the Messages API streams it.
function sseBody({ content, ...message }) {
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  let out = ev("message_start", { message: { ...message, content: [], stop_reason: null } });
  content.forEach((b, index) => {
    const start = b.type === "text" ? { type: "text", text: "" } : b.type === "thinking" ? { type: "thinking", thinking: "" } : b;
    out += ev("content_block_start", { index, content_block: start });
    if (b.type === "text") for (let i = 0; i < b.text.length; i += 7) out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text.slice(i, i + 7) } });
    if (b.type === "thinking") out += ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } }) + ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    out += ev("content_block_stop", { index });
  });
  return out + ev("message_delta", { delta: { stop_reason: message.stop_reason } }) + ev("message_stop", {});
}
const streamed = (message) => ({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" }, body: sseBody(message) });

async function fakeClaude(page, { status = 200, recipes = [claudeRecipe()] } = {}) {
  const calls = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    calls.push({ headers: req.headers(), body: JSON.parse(req.postData() || "{}") });
    if (status !== 200) return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    await route.fulfill(streamed({ id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ recipes }) }] }));
  });
  return calls;
}

test("E2E AIKEY-04 no AI on the site: add a key in the profile, get AI recipes from Claude, unsafe ones removed", async () => {
  const { page, ctx, errors } = await open(off);
  const calls = await fakeClaude(page, { recipes: [claudeRecipe(), claudeRecipe({ title: "Honey oats", ingredients: [{ name: "oats", quantity: 2, unit: "tbsp" }, { name: "honey", quantity: 1, unit: "tsp" }] })] });
  const chip = page.locator("#ai-chip");
  await page.waitForFunction(() => /tap to add a key/.test(document.querySelector("#ai-chip").textContent));
  await chip.click();
  const dlg = tid(page, "profile-dialog");
  assert.ok(await tid(page, "ai-key-section").evaluate((d) => d.open));
  await tid(page, "ai-key").fill("ghp_notaclaudekey");
  await tid(page, "ai-key-save").click();
  assert.match(await tid(page, "ai-key-status").textContent(), /sk-ant-/);
  await tid(page, "ai-key").fill(FAKE_KEY);
  await tid(page, "ai-key-save").click();
  await dlg.waitFor({ state: "detached" });
  await page.waitForFunction(() => /your key/.test(document.querySelector("#ai-chip").textContent));

  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("baby");
  await tid(page, "generate-recipes").click();
  await page.locator("[data-testid=recipe-card]", { hasText: "Ragi banana porridge" }).waitFor({ timeout: 5000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], FAKE_KEY);
  assert.equal(calls[0].headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(calls[0].body.stream, true, "the answer streams so phones don't drop a long wait");
  assert.equal(calls[0].body.output_config.format.type, "json_schema");
  assert.match(calls[0].body.system, /never honey/);
  assert.match(await tid(page, "rejected-notice").textContent(), /Honey oats/);
  assert.equal(await page.locator("[data-testid=recipe-card]", { hasText: "Honey oats" }).count(), 0);

  // The key stays out of the app's data, so it never reaches backups or check-ins.
  const saved = await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); return localStorage.getItem("familyMealPlanner.v1") || ""; });
  assert.ok(!saved.includes("sk-ant-"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E AIKEY-05 a rejected key falls back to the recipe book and says to check the key; removing the key turns AI off", async () => {
  const ctx = await newContext();
  await ctx.addInitScript((k) => localStorage.setItem("familyMealPlanner.aiKey", k), FAKE_KEY);
  const page = await ctx.newPage();
  await fakeClaude(page, { status: 401 });
  await page.goto(`${off.url}?today=${TODAY}`);
  await page.waitForFunction(() => /your key/.test(document.querySelector("#ai-chip").textContent));
  await unfoldAll(page);
  await tid(page, "tab-recipes").click();
  await tid(page, "generate-recipes").click();
  await tid(page, "ai-notice").waitFor({ timeout: 5000 });
  assert.match(await tid(page, "ai-notice").textContent(), /key was not accepted/);
  assert.ok((await tid(page, "recipe-card").count()) > 0);

  await page.locator("#profile").click();
  await tid(page, "ai-key-section").locator("summary").click();
  await tid(page, "ai-key-remove").click();
  await page.waitForFunction(() => /tap to add a key/.test(document.querySelector("#ai-chip").textContent));
  assert.equal(await page.evaluate(() => localStorage.getItem("familyMealPlanner.aiKey")), null);
  await ctx.close();
});

test("E2E APPL-01 appliances in the profile: recipes show the air fryer and oven methods, and two dishes share the baskets", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "profile").click();
  const section = tid(page, "appliances-section");
  await section.getByText("Two baskets (Ninja dual zone)").click();
  await tid(page, "has-oven").check();
  await tid(page, "save-appliances").click();
  assert.match(await tid(page, "appliances-section").locator("summary").innerText(), /Air fryer, Oven/);
  await page.keyboard.press("Escape");

  await tid(page, "tab-recipes").click();
  assert.match(await tid(page, "gen-quick").locator("..").innerText(), /air fryer and oven count/);
  await tid(page, "pantry-input").fill("eggs, whole wheat bread, milk, almond powder, banana, butter");
  await tid(page, "pantry-add").click();
  await tid(page, "ready-to-cook").getByText("French toast sticks", { exact: false }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  assert.match(await dialog.getByTestId("appliance-methods").innerText(), /Air fryer \(two baskets\): 8 min at 180°C/);
  await page.keyboard.press("Escape");

  await tid(page, "tab-calendar").click();
  await cell(page, TOMORROW).click();
  await planSlot(page, TOMORROW, "kid_breakfast", "French toast sticks with cardamom and almond powder");
  await planSlot(page, TOMORROW, "kid_lunchbox", "Spinach and cheddar egg muffins");
  const morning = tid(page, "basket-pair").filter({ hasText: "Morning" });
  const text = await morning.innerText();
  assert.match(text, /Basket 1: Spinach and cheddar egg muffins · 12 min at 160°C/);
  assert.match(text, /Basket 2: French toast sticks/);
  assert.match(text, /Sync/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CUI-01 cuisines picked in the profile steer suggestions and top picks; yesterday's curry becomes a roti quesadilla", async () => {
  const ctx = await newContext();
  const seed = { version: 1, pantry: ["Bendakaya (okra)", "onion", "tomato", "rice", "roti", "cheese", "curry leaves", "mustard seeds"], frozen: [{ id: "f1", name: "Frozen peas", qty: 2, unit: "packs", date: "2026-10-01" }],
    days: { [TODAY]: { meals: { family_dinner: { recipeId: "lib-kodi-kura", title: "Kodi kura (Andhra chicken curry, mild)", forWhom: "family" } }, schedule: [], status: "pending" } } };
  await ctx.addInitScript((s) => { if (!localStorage.getItem("familyMealPlanner.v1")) localStorage.setItem("familyMealPlanner.v1", s); }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mock.url}?today=${TODAY}`);
  await tid(page, "cal-grid").waitFor();
  await unfoldAll(page);

  await tid(page, "profile").click();
  await tid(page, "cuisine-telugu").check();
  await tid(page, "cuisine-tamil").check();
  await tid(page, "save-cuisines").click();
  assert.deepEqual(await page.evaluate(() => window.__mealPlanner.state.settings.cuisines), ["telugu", "tamil"]);

  // The day after the Kodi kura, the school lunchbox suggestion is a leftover makeover.
  await cell(page, TOMORROW).click();
  const lunch = page.locator("[data-testid=suggestion][data-slot=kid_lunchbox]");
  assert.match(await lunch.innerText(), /Uses yesterday's Kodi kura[\s\S]*Roti chicken curry quesadilla/);
  assert.doesNotMatch(await lunch.innerText(), /leftover chicken curry/, "the leftover is never something to buy");

  await tid(page, "tab-recipes").click();
  const top = tid(page, "top-picks");
  await top.waitFor();
  assert.ok((await tid(page, "top-pick").count()) <= 5);
  assert.match(await top.innerText(), /Telugu, Tamil/);
  assert.match(await tid(page, "leftover-ideas").innerText(), /Kodi kura[\s\S]*can become/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E BRK-01 Whole family + Breakfast with the AI off shows family breakfasts, the night-before and no-cook ones first", async () => {
  const { page, ctx, errors } = await open(off);
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("family");
  await tid(page, "gen-meal").selectOption("breakfast");
  assert.ok(await tid(page, "gen-busy").isChecked(), "a Thursday is a busy morning");
  await tid(page, "generate-recipes").click();
  await tid(page, "ai-notice").waitFor({ timeout: 5000 });
  const cards = tid(page, "recipe-card");
  assert.ok((await cards.count()) >= 4, "recipes, not an empty result");
  const titles = await cards.locator("h3").allInnerTexts();
  assert.ok(titles.some((t) => /overnight oats|peanut butter banana toast|avocado toast|idli/i.test(t)), titles.join(" | "));
  // The weekend: untick it and a cooked breakfast can show up again.
  await tid(page, "gen-busy").uncheck();
  await tid(page, "generate-recipes").click();
  assert.ok((await cards.count()) > 0);
  assert.deepEqual(errors.filter((e) => !/503/.test(e)), []);
  await ctx.close();
});

test("E2E BRK-02 fruits can be added to the kitchen, and the kitchen shows collapsed groups", async () => {
  const { page, ctx, errors } = await open();
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("okra, peanut butter, bread, biscuits");
  await tid(page, "pantry-add").click();
  const fruits = tid(page, "quick-fruits");
  await fruits.locator("summary").click();
  assert.equal(await fruits.getByRole("button", { name: "+ Arati pandu (banana)" }).count(), 0, "banana is in the kitchen already");
  await fruits.getByRole("button", { name: "+ Mamidi pandu (mango)" }).click();
  await fruits.getByRole("button", { name: "+ Apple" }).click();
  const groups = tid(page, "kitchen-group");
  assert.deepEqual((await groups.evaluateAll((els) => els.map((e) => e.dataset.kitchen))).slice(0, 5), ["vegetables", "fruits", "dips", "bread", "snacks"]);
  const fruit = page.locator("[data-kitchen=fruits]");
  assert.equal(await fruit.evaluate((d) => d.open), false, "collapsed");
  assert.match(await fruit.locator("summary").innerText(), /Fruits\s*3[\s\S]*banana[\s\S]*mango[\s\S]*Apple/);
  await fruit.locator("summary").click();
  await fruit.getByRole("button", { name: "Remove Apple" }).click();
  assert.equal(await page.locator("[data-kitchen=fruits]").evaluate((d) => d.open), true, "stays open after a change");
  assert.match(await page.locator("[data-kitchen=fruits] summary").innerText(), /Fruits\s*2/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E BRK-03 weekday suggestions: breakfast made the night before or no-cook, and a fruit for the baby", async () => {
  const { page, ctx, errors } = await open();
  await cell(page, "2026-10-26").click();   // a Monday
  const kid = page.locator("[data-testid=suggestion][data-slot=kid_breakfast]");
  assert.match(await kid.innerText(), /Made the night before \(\d+ min\), reheat in the microwave|Make the night before|Weekend batch|No cooking/);
  const baby = page.locator("[data-testid=suggestion][data-slot=baby_breakfast]");
  const text = await baby.innerText();
  assert.ok(/banana|avocado|papaya|mango|chikoo|apple|pear/i.test(text), text);
  assert.match(await baby.innerText(), /Make the night before|No cooking/);
  await cell(page, "2026-10-24").click();   // a Saturday: no rush
  assert.equal(await tid(page, "busy-morning").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E SNK-01 school-day snack box is cheese or a ragi cookie, never nuts at a nut-free school, and no ragi cookie after a ragi breakfast", async () => {
  const { page, ctx, errors } = await open();
  const BOX = /Cheese cubes and cucumber sticks|Ragi cookies|Cheese and chopped nuts snack box/;
  const snack = page.locator("[data-testid=suggestion][data-slot=kid_snack]");
  const seen = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await snack.innerText());
      await snack.getByRole("button").click();
    }
    return out;
  };
  await cell(page, "2026-10-26").click();   // a Monday
  for (const t of await seen(6)) assert.match(t, BOX);
  // Nut-free school: still cheese or a ragi cookie, never nuts.
  await tid(page, "tab-recipes").click();
  await tid(page, "school-nut-free").check();
  await tid(page, "tab-calendar").click();
  await cell(page, "2026-10-27").click();
  const nutFree = await seen(6);
  for (const t of nutFree) {
    assert.match(t, /Cheese cubes and cucumber sticks|Ragi cookies/);
    assert.doesNotMatch(t, /peanut|nuts\b|almond|cashew/i);
  }
  // Ragi at breakfast: the snack box is cheese that day.
  await planSlot(page, "2026-10-28", "kid_breakfast", "Ragi banana pancakes");
  for (const t of await seen(6)) assert.match(t, /Cheese cubes and cucumber sticks/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E SNK-02 filling the week with a curry every night doesn't put the same lunchbox on every school day", async () => {
  const { page, ctx, errors } = await open();
  for (const d of ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]) await planSlot(page, d, "family_dinner", "Vankaya kura (brinjal curry)");
  await cell(page, "2026-10-26").click();
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  const meals = await page.evaluate(() => ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"].map((k) => window.__mealPlanner.state.days[k].meals));
  const lunches = meals.map((m) => m.kid_lunchbox?.title);
  assert.ok(lunches.every(Boolean), lunches.join(" | "));
  assert.equal(new Set(lunches).size, lunches.length, lunches.join(" | "));
  for (const m of meals) {
    assert.match(m.kid_snack.title, /cheese|ragi cookie/i);
    if (/ragi/i.test(m.kid_breakfast?.title || "")) assert.doesNotMatch(m.kid_snack.title, /ragi/i);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E UI-20 less scrolling: the calendar opens on one week, sections start folded and remember being opened, food has pictures", async () => {
  const ctx = await newContext({ weekView: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mock.url}?today=${TODAY}`);
  await tid(page, "cal-grid").waitFor();
  const visibleDays = () => page.locator("[data-testid^=cal-day-]:visible").count();

  // One week, with arrows that step a week; "Show the whole month" opens the month and is remembered.
  assert.equal(await visibleDays(), 7);
  assert.ok(await cell(page, TOMORROW).isVisible());
  await tid(page, "cal-next").click();
  assert.equal(await tid(page, "day-panel").getAttribute("data-date"), "2026-10-29");
  await tid(page, "cal-today").click();
  await tid(page, "cal-view").click();
  assert.equal(await visibleDays(), 42);
  await page.reload();
  await tid(page, "cal-grid").waitFor();
  assert.equal(await visibleDays(), 42);
  await tid(page, "cal-view").click();
  assert.equal(await visibleDays(), 7);

  // The day's schedule, to-dos and reminders are one line each until opened; opened stays opened.
  const todoSection = page.locator("details[data-group=day-todos]");
  assert.equal(await todoSection.evaluate((d) => d.open), false);
  assert.equal(await page.locator("details[data-group=suggest]").evaluate((d) => d.open), false);
  assert.match(await todoSection.locator("summary").innerText(), /To do[\s\S]*Nothing yet/);
  await todoSection.locator("summary").click();
  await tid(page, "day-todo-input").fill("Pack the water bottle");
  await tid(page, "day-todo-add").click();
  assert.equal(await todoSection.evaluate((d) => d.open), true);
  assert.match(await todoSection.locator("summary").innerText(), /1 left/);
  assert.match(await page.locator(".hero-stats").innerText(), /1 to do/);

  // Recipes: picture cards for the top picks, everything else folded, so the page is short.
  await tid(page, "tab-recipes").click();
  assert.ok((await page.locator("[data-testid=top-pick] .pick-art").count()) > 0);
  for (const id of ["sec-quick-breakfast", "sec-kitchen", "sec-cook-veg", "sec-ready", "sec-generate", "sec-saved"]) {
    assert.equal(await page.locator(`details[data-group=${id}]`).evaluate((d) => d.open), false, `${id} starts folded`);
  }
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(height < 1600, `Recipes page is ${height}px tall`);

  // Shopping rows show a picture of the item.
  await tid(page, "tab-shopping").click();
  await addShopItems(page, ["bananas"]);
  assert.equal(await tid(page, "shop-item").locator(".art").innerText(), "🍌");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E BRK-04 weekday family breakfasts: warm ones made the night before first, with a side dip that opens its recipe", async () => {
  const { page, ctx, errors } = await open(off);
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("family");
  await tid(page, "gen-meal").selectOption("breakfast");
  await tid(page, "generate-recipes").click();
  await tid(page, "ai-notice").waitFor({ timeout: 5000 });
  const first = tid(page, "recipe-card").first();
  assert.match(await first.getByTestId("busy-morning-tag").innerText(), /reheat in the microwave/);
  assert.match(await first.getByTestId("reheat").innerText(), /microwave/);
  const cards = tid(page, "recipe-card");
  const n = await cards.count();
  let dipCard = null;
  for (let i = 0; i < n && !dipCard; i++) if (await cards.nth(i).getByTestId("recipe-side-dips").count()) dipCard = cards.nth(i);
  assert.ok(dipCard, "a breakfast with a side dip");
  const dip = dipCard.getByTestId("recipe-side-dips").getByRole("button").first();
  const name = await dip.innerText();
  await dip.click();
  await page.getByRole("dialog").getByRole("heading", { name }).waitFor({ timeout: 5000 });
  assert.deepEqual(errors.filter((e) => !/503/.test(e)), []);
  await ctx.close();
});

test("E2E BRK-05 the 4-year-old's weekday breakfast suggestion is warm and names its side dip", async () => {
  const { page, ctx, errors } = await open();
  await cell(page, "2026-10-26").click();   // a Monday
  const kid = page.locator("[data-testid=suggestion][data-slot=kid_breakfast]");
  assert.match(await kid.innerText(), /reheat in the microwave/);
  assert.match(await kid.getByTestId("side-dip").innerText(), /With .*(dip|chutney|salsa)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- planning a whole week ----------
test("E2E WEEK-01 without AI, one tap fills every empty meal of the week from the kitchen, and Undo puts it back", async () => {
  const { page, ctx, errors } = await open(off);
  await cell(page, TODAY).click();
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  assert.match(await tid(page, "toast").textContent(), /Added \d+ meals to 3 days/);
  for (const d of [TODAY, TOMORROW, "2026-10-24"]) assert.equal(await cell(page, d).getAttribute("data-status"), "pending");
  assert.equal(await cell(page, "2026-10-21").getAttribute("data-status"), "empty", "days before today stay as they were");
  // Saturday has no school lunchbox.
  const sat = await page.evaluate(() => Object.keys(window.__mealPlanner.state.days["2026-10-24"].meals));
  assert.ok(!sat.includes("kid_lunchbox"));
  await tid(page, "toast-undo").click();
  assert.equal(await cell(page, TODAY).getAttribute("data-status"), "empty");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A fake Claude for the planning chat: answers each turn with the next of `answers`, a function of the request.
async function fakePlanChat(page, answers) {
  const calls = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || "{}");
    calls.push({ headers: req.headers(), body });
    const answer = answers[calls.length - 1](body);
    await route.fulfill(streamed({ id: "msg_" + calls.length, type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "", signature: "sig" + calls.length }, { type: "text", text: JSON.stringify(answer) }] }));
  });
  return calls;
}
const refFor = (body, kind) => new RegExp(`^(r\\d+) \\| ${kind} \\| ([^|]+?) \\|`, "m").exec(body.system[1].text);
const change = (o) => ({ ref: "", title: "", ingredients: [], steps: [], notes: "", ...o });

test("E2E CHAT-01 the AI chat plans the week onto the calendar, changes it from the conversation, and drops unsafe meals", async () => {
  const ctx = await newContext();
  await ctx.addInitScript((k) => localStorage.setItem("familyMealPlanner.aiKey", k), FAKE_KEY);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let dinners;
  const calls = await fakePlanChat(page, [
    (body) => {
      const dinner = refFor(body, "family dinner");
      const baby = refFor(body, "baby lunch");
      dinners = dinner;
      return { reply: "Here is the plan for the rest of the week.", changes: [
        change({ date: TODAY, slot: "family_dinner", ref: dinner[1] }),
        change({ date: TOMORROW, slot: "baby_lunch", ref: baby[1] }),
        change({ date: TOMORROW, slot: "baby_breakfast", title: "Honey oats", ingredients: [{ name: "oats", quantity: 2, unit: "tbsp" }, { name: "honey", quantity: 1, unit: "tsp" }], steps: ["Cook"] }),
      ] };
    },
    () => ({ reply: "Swapped Thursday's dinner for a quick dal.", changes: [
      change({ date: TODAY, slot: "family_dinner", title: "Quick tomato dal", ingredients: [{ name: "toor dal", quantity: 1, unit: "cup" }, { name: "tomato", quantity: 2, unit: "pcs" }], steps: ["Pressure cook the dal", "Add the tempering"] }),
    ] }),
  ]);
  await page.goto(`${off.url}?today=${TODAY}`);
  await page.getByTestId("cal-grid").waitFor();

  await tid(page, "plan-chat-open").click();
  await tid(page, "chat-idea").first().click();
  assert.equal(await tid(page, "chat-input").inputValue(), "Plan this week");
  await tid(page, "chat-send").click();
  await tid(page, "chat-claude").waitFor({ timeout: 5000 });
  assert.equal(calls[0].headers["x-api-key"], FAKE_KEY);
  assert.equal(calls[0].body.output_config.format.type, "json_schema");
  assert.equal(calls[0].body.system[1].cache_control.type, "ephemeral", "the recipe book is cached");
  assert.equal(calls[0].body.stream, true, "the plan streams in, so a long answer isn't cut off");
  assert.match(calls[0].body.system[0].text, /never honey/);
  assert.match(calls[0].body.messages[0].content, /Parent: Plan this week$/);
  // The app fills the week on screen from the recipe book itself; Claude only changes what was asked.
  assert.match(await tid(page, "chat-app").textContent(), /Filled \d+ empty meals from your recipe book/);
  assert.match(calls[0].body.messages[0].content, /2026-10-22 Thu school day: baby_breakfast=/);
  assert.match(calls[0].body.messages[0].content, /2026-10-25 Sun weekend: nothing planned/, "only the week on screen is filled");
  assert.equal(await tid(page, "chat-claude").locator("[data-testid=chat-changes] li").count(), 2);
  assert.match(await tid(page, "chat-skipped").textContent(), /Honey oats/);
  assert.equal(await cell(page, TODAY).getAttribute("data-status"), "pending");
  assert.equal(await page.evaluate((d) => window.__mealPlanner.state.days[d].meals.family_dinner.title, TODAY), dinners[2].trim());

  // The second turn carries the first, and the plan as it is now.
  await tid(page, "chat-input").fill("Swap Thursday's dinner");
  await tid(page, "chat-input").press("Enter");
  await page.locator("[data-testid=chat-claude]").nth(1).waitFor({ timeout: 5000 });
  const msgs = calls[1].body.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].content[0].signature, "sig1", "Claude's whole answer goes back unchanged");
  assert.match(msgs[2].content, /family_dinner=/);
  const dinner = await page.evaluate((d) => window.__mealPlanner.state.days[d].meals.family_dinner, TODAY);
  assert.equal(dinner.title, "Quick tomato dal");
  assert.ok(await page.evaluate((id) => window.__mealPlanner.state.savedRecipes.some((r) => r.id === id && r.ingredients.length === 2), dinner.recipeId));

  // Undo puts the first plan's dinner back.
  await page.locator("[data-testid=chat-claude] [data-testid=chat-undo]").nth(1).click();
  assert.equal(await page.evaluate((d) => window.__mealPlanner.state.days[d].meals.family_dinner.title, TODAY), dinners[2].trim());
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E CHAT-02 without a key the chat explains and opens the key steps in Profile", async () => {
  const { page, ctx, errors } = await open(off);
  await tid(page, "plan-chat-open").click();
  await tid(page, "chat-add-key").click();
  await tid(page, "profile-dialog").waitFor();
  assert.ok(await tid(page, "ai-key-section").evaluate((d) => d.open));
  assert.match(await tid(page, "ai-key-steps").textContent(), /Create Key/);
  assert.equal(await tid(page, "ai-key-get").getAttribute("href"), "https://console.anthropic.com/settings/keys");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- use-by dates, cooking first what runs out, quick breakfasts ----------
test("E2E FRESH-01 a use-by date on kitchen food: shown on the item, editable, and the week plan cooks it first", async () => {
  const { page, ctx, errors } = await open(off);
  await tid(page, "tab-recipes").click();
  await tid(page, "pantry-input").fill("gongura");
  await tid(page, "pantry-expires").fill(TOMORROW);
  await tid(page, "pantry-add").click();
  assert.match(await tid(page, "use-soon").textContent(), /gongura \(tomorrow\)/);
  const veg = page.locator("[data-kitchen=vegetables]");
  if (!(await veg.evaluate((d) => d.open))) await veg.locator("summary").click();
  const chip = tid(page, "pantry-item").filter({ hasText: "gongura" });
  assert.match(await chip.locator("[data-testid=pantry-expiry]").textContent(), /1 day 📅/);
  assert.deepEqual(await page.evaluate(() => window.__mealPlanner.state.pantryDates.gongura), { added: "2026-10-22", expires: TOMORROW });
  // Items without a date get the fridge estimate from when they came in.
  assert.equal(await page.evaluate(() => window.__mealPlanner.state.pantryDates.carrot?.expires), "");

  // Tap the item to change its date, then back to the estimate.
  await chip.locator("[data-testid=pantry-date]").click();
  assert.match(await tid(page, "pantry-date-estimate").textContent(), /Keeps about 4 days in the fridge/);
  await tid(page, "pantry-date-input").fill("2026-10-28");
  await tid(page, "pantry-date-save").click();
  assert.equal(await page.evaluate(() => window.__mealPlanner.state.pantryDates.gongura.expires), "2026-10-28");
  await tid(page, "pantry-item").filter({ hasText: "gongura" }).locator("[data-testid=pantry-date]").click();
  await tid(page, "pantry-date-clear").click();
  assert.equal(await page.evaluate(() => window.__mealPlanner.state.pantryDates.gongura.expires), "");
  await tid(page, "pantry-item").filter({ hasText: "gongura" }).locator("[data-testid=pantry-date]").click();
  await tid(page, "pantry-date-input").fill(TOMORROW);
  await tid(page, "pantry-date-save").click();

  // The week plan uses the gongura before it runs out (today or tomorrow), once.
  await tid(page, "tab-calendar").click();
  await cell(page, TODAY).click();
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  const uses = await page.evaluate(() => {
    const { state } = window.__mealPlanner;
    const out = [];
    for (const [date, day] of Object.entries(state.days)) {
      for (const m of Object.values(day.meals)) if (/gongura/i.test(m.title)) out.push(date);
    }
    return out;
  });
  assert.ok(uses.length >= 1 && uses.every((d) => d <= TOMORROW), `gongura on ${uses.join(", ")}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E FRESH-02 Quick breakfasts from the kitchen, and AI breakfast ideas told what runs out and the staples at home", async () => {
  const ctx = await newContext();
  await ctx.addInitScript((k) => localStorage.setItem("familyMealPlanner.aiKey", k), FAKE_KEY);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = await fakeClaude(page, { recipes: [claudeRecipe({ title: "Egg dosa", forWhom: "family", mealType: "breakfast", texture: "", prepMinutes: 10,
    ingredients: [{ name: "idli/dosa batter", quantity: 1, unit: "cup" }, { name: "egg", quantity: 2, unit: "pcs" }], steps: ["Spread the batter", "Crack the egg on top"] })] });
  await page.goto(`${off.url}?today=${TODAY}`);
  await page.getByTestId("cal-grid").waitFor();
  await unfoldAll(page);
  await tid(page, "tab-recipes").click();
  const rows = tid(page, "quick-breakfast");
  assert.ok((await rows.count()) >= 1);
  assert.match(await rows.first().textContent(), /⚡ \d+ min|No cooking|night before|Weekend batch/);
  assert.ok((await tid(page, "quick-breakfast-baby").locator("[data-testid=quick-breakfast]").count()) >= 1, "the baby's quick breakfasts too");
  // Staples are assumed at home, and that can be turned off.
  assert.match(await page.locator("label", { has: tid(page, "assume-staples") }).textContent(), /rice, dals, spices/);

  await tid(page, "ai-breakfasts").click();
  await page.locator("[data-testid=recipe-card]", { hasText: "Egg dosa" }).waitFor({ timeout: 5000 });
  const prompt = calls[0].body.messages[0].content;
  assert.match(prompt, /Meal: breakfast/);
  assert.match(prompt, /Use these first, they run out soon: .*idli\/dosa batter/);
  assert.match(prompt, /Pantry staples always at home: rice, toor dal/);
  assert.match(prompt, /Easy breakfasts the 4-year-old eats too/);
  assert.match(prompt, /anything baked or slower only as a weekend batch/);
  assert.match(calls[0].body.system, /never honey/, "the age rules are still sent");

  await tid(page, "assume-staples").uncheck();
  assert.equal(await page.evaluate(() => window.__mealPlanner.state.settings.assumeStaples), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- each child's needs, and breakfasts that fit a real morning ----------
test("E2E PREF-01 a gassy baby on iron-fortified cereal: Profile saves it, suggestions follow it, and the AI is told", async () => {
  const ctx = await newContext();
  await ctx.addInitScript((k) => localStorage.setItem("familyMealPlanner.aiKey", k), FAKE_KEY);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = await fakeClaude(page, { recipes: [claudeRecipe({ title: "Moong dal rice mash", ingredients: [{ name: "rice", quantity: 2, unit: "tbsp" }, { name: "moong dal", quantity: 1, unit: "tbsp" }] }),
    claudeRecipe(), claudeRecipe({ title: "Cauliflower mash", ingredients: [{ name: "cauliflower", quantity: 50, unit: "g" }] })] });
  await page.goto(`${off.url}?today=${TODAY}`);
  await page.getByTestId("cal-grid").waitFor();
  await unfoldAll(page);
  await tid(page, "profile").click();
  await tid(page, "profile-dialog").waitFor();
  const names = tid(page, "family-names");
  if (!(await names.evaluate((d) => d.open))) await names.locator("summary").click();
  await tid(page, "baby-pref-gassy").check();
  await tid(page, "baby-pref-ironCereal").check();
  await tid(page, "baby-pref-note").fill("loves pear");
  await tid(page, "baby-avoid").fill("Ragi");
  await tid(page, "kid-pref-noEgg").check();
  await tid(page, "save-names").click();
  assert.deepEqual(await page.evaluate(() => window.__mealPlanner.state.settings.prefs), { baby: { tags: ["gassy", "ironCereal"], note: "loves pear", avoid: ["ragi"] }, kid: { tags: ["noEgg"], note: "", avoid: [] } });
  await page.keyboard.press("Escape");

  // The week's suggestions: the baby's breakfast is the cereal, nothing gassy, no egg for the 4-year-old.
  await tid(page, "tab-calendar").click();
  await cell(page, TODAY).click();
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  const meals = await page.evaluate(() => Object.values(window.__mealPlanner.state.days).map((d) => d.meals));
  assert.ok(meals.some((m) => /Iron-fortified cereal/.test(m.baby_breakfast?.title || "")), "cereal at breakfast");
  for (const m of meals) {
    for (const [slot, meal] of Object.entries(m)) {
      if (slot.startsWith("baby")) assert.doesNotMatch(meal.title, /cauliflower|cabbage|broccoli|rajma|chana|ragi/i);
      if (slot.startsWith("kid")) assert.doesNotMatch(meal.title, /(?<!no )\begg/i, `${slot}: ${meal.title}`);
    }
  }

  // AI recipes hear it, and one that breaks it is left out.
  await tid(page, "tab-recipes").click();
  await tid(page, "gen-for").selectOption("baby");
  await tid(page, "generate-recipes").click();
  await page.locator("[data-testid=recipe-card]", { hasText: "Moong dal rice mash" }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-testid=recipe-card]", { hasText: "Ragi banana porridge" }).count(), 0, "no ragi for the baby");
  assert.match(await tid(page, "rejected-notice").textContent(), /Ragi banana porridge.*ragi, which you asked to leave out/);
  assert.match(calls[0].body.messages[0].content, /The 8-month-old has a gassy tummy.*"loves pear"/);
  assert.match(calls[0].body.messages[0].content, /The 4-year-old doesn't eat egg/);
  assert.match(calls[0].body.messages[0].content, /The 8-month-old .*must never get ragi/);
  assert.equal(await page.locator("[data-testid=recipe-card]", { hasText: "Cauliflower mash" }).count(), 0);
  assert.match(await tid(page, "rejected-notice").textContent(), /Cauliflower mash.*gas/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E MORN-01 school-day breakfasts are never slow; the weekend says what to batch and the evening what to prep", async () => {
  const { page, ctx, errors } = await open(off, { today: "2026-10-24" });   // a Saturday
  await page.evaluate(() => { const s = window.__mealPlanner.state; s.pantry.push("egg", "spinach", "cheddar cheese", "flour tortilla", "potato", "black beans", "bread", "milk"); });
  await tid(page, "tab-calendar").click();
  await cell(page, "2026-10-26").click();   // Monday, so the week on screen is the school week
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  const days = await page.evaluate(() => window.__mealPlanner.state.days);

  for (const [date, d] of Object.entries(days)) {
    const dow = new Date(date + "T12:00").getDay();
    if (dow === 0 || dow === 6) continue;
    for (const slot of ["kid_breakfast", "baby_breakfast"]) assert.doesNotMatch(d.meals[slot]?.title || "", /Ven pongal|Kerala egg roast|Mild shakshuka/, `${date} ${slot}`);
  }
  // Pick a weekend batch for Monday and a night-before breakfast for Tuesday, then look at Sunday and Monday.
  await page.evaluate(() => {
    const s = window.__mealPlanner.state;
    s.days["2026-10-26"].meals.kid_breakfast = { recipeId: "lib-make-ahead-egg-muffins-with-spinach-and-cheese", title: "Make-ahead egg muffins with spinach and cheese", forWhom: "kid" };
    s.days["2026-10-27"].meals.kid_breakfast = { recipeId: "lib-vegetable-upma-made-the-night-before", title: "Vegetable upma (made the night before)", forWhom: "family" };
  });
  await cell(page, "2026-10-25").click();
  assert.match(await tid(page, "prep-ahead").textContent(), /Weekend prep for the school week: Make-ahead egg muffins with spinach and cheese for Mon/);
  await cell(page, "2026-10-26").click();
  assert.match(await tid(page, "prep-ahead").textContent(), /Tonight, for tomorrow's breakfast: Vegetable upma \(made the night before\) \(15 min\)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("E2E AGE-01 recipes by age: ☆ a baby dinner and the week's plan uses it often", async () => {
  const { page, ctx, errors } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-recipes").click();
  const sec = tid(page, "recipes-by-age");
  await sec.locator("[data-action=age-who][data-who=baby]").click();
  await sec.locator("[data-action=age-meal][data-meal=dinner]").click();
  const rows = sec.getByTestId("age-recipe");
  const pick = rows.last();
  const id = await pick.getAttribute("data-recipe-id");
  await pick.getByTestId("toggle-often").click();
  // It moves to the top of the section, marked as used often.
  assert.equal(await rows.first().getAttribute("data-recipe-id"), id);
  assert.equal(await rows.first().getAttribute("data-often"), "true");
  const regulars = await page.evaluate(() => window.__mealPlanner.state.settings.regulars);
  assert.deepEqual(regulars.baby, [id]);

  // Filling the week picks it for the baby's dinner, and brings it back every few days rather than once a week.
  await tid(page, "tab-calendar").click();
  await cell(page, "2026-10-26").click();
  await tid(page, "fill-week").click();
  await tid(page, "toast").waitFor();
  const dinners = await page.evaluate(() => ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]
    .map((k) => window.__mealPlanner.state.days[k]?.meals?.baby_dinner?.recipeId));
  assert.equal(dinners[0], id, dinners.join(" | "));
  assert.ok(dinners.filter((d) => d === id).length >= 3, dinners.join(" | "));
  // Never two days running.
  for (let i = 1; i < dinners.length; i++) assert.ok(!(dinners[i] === id && dinners[i - 1] === id), dinners.join(" | "));

  // ★ again takes it off the list.
  await tid(page, "tab-recipes").click();
  await sec.locator(`[data-recipe-id="${id}"] [data-testid=toggle-often]`).click();
  assert.deepEqual(await page.evaluate(() => window.__mealPlanner.state.settings.regulars.baby), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});
