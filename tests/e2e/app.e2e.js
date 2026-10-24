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
async function newContext(opts = {}) {
  return browser.newContext(opts);
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
  return { page, ctx, errors };
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

test("E2E TODO-05 to-dos: tap the row to tick, edit in the sheet, swipe left to delete", async () => {
  const { page, ctx } = await open(mock, { viewport: { width: 390, height: 844 } });
  await tid(page, "tab-todo").click();
  await tid(page, "todo-idea").filter({ hasText: "Pack school bag" }).click();
  await tid(page, "todo-item").locator(".name").click();
  assert.equal(await tid(page, "todo-left").innerText(), "All done");
  await tid(page, "todo-more").click();
  await tid(page, "todo-input").fill("Pack school bag and water bottle");
  await tid(page, "todo-save").click();
  assert.match(await tid(page, "todo-list").innerText(), /water bottle/);
  await swipeRow(page, tid(page, "todo-list").getByTestId("todo-item"), -160);
  assert.equal(await tid(page, "todo-list").getByTestId("todo-item").count(), 0);
  await ctx.close();
});

test("E2E TODO-01 the To do tab opens on tomorrow; ideas and ticks persist; the calendar shows them", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-todo").click();
  assert.equal(await tid(page, "todo-date").inputValue(), TOMORROW);
  await tid(page, "todo-idea").filter({ hasText: "Buy dresses" }).click();
  await tid(page, "todo-fab").click();
  await tid(page, "todo-input").fill("Doctor's appointment");
  await tid(page, "todo-who").getByText("8-month-old").click();
  await tid(page, "todo-add").click();
  assert.equal(await tid(page, "todo-item").count(), 2);
  await tid(page, "todo-item").filter({ hasText: "Buy dresses" }).locator("input[type=checkbox]").check();
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-todo").click();
  assert.ok(await tid(page, "todo-item").filter({ hasText: "Buy dresses" }).locator("input[type=checkbox]").isChecked());
  await tid(page, "tab-calendar").click();
  await cell(page, TOMORROW).click();
  const t = await page.locator("[data-testid=day-pending] li[data-type=todo]").allInnerTexts();
  assert.deepEqual(t.map((x) => x.trim()), ["✅ Doctor's appointment"]);
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
  for (const tab of ["calendar", "recipes", "shopping", "todo", "reminders"]) {
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

test("E2E TODO-05 old missed to-dos are folded behind 'Show N older'; ticking updates in place", async () => {
  const todos = [];
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.UTC(2026, 9, 22 - i)).toISOString().slice(0, 10);
    todos.push({ id: "t" + i, text: "Old task " + i, who: "kid", date: d, time: "", done: false });
  }
  todos.push({ id: "tm", text: "Buy shoes", who: "kid", date: TOMORROW, time: "", done: false });
  // Seed before the app loads (a reload would save the app's own state over it on pagehide).
  const ctx = await newContext();
  await ctx.addInitScript((t) => { if (!localStorage.getItem("familyMealPlanner.v1")) localStorage.setItem("familyMealPlanner.v1", JSON.stringify({ version: 1, todos: t })); }, todos);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mock.url}?today=${TODAY}`);
  await tid(page, "tab-todo").click();
  assert.equal(await tid(page, "todo-missed").getByTestId("todo-item").count(), 14);
  await tid(page, "todo-older").click();
  assert.equal(await tid(page, "todo-missed").getByTestId("todo-item").count(), 40);
  await tid(page, "todo-list").locator("input[type=checkbox]").check();
  assert.equal(await tid(page, "todo-left").innerText(), "All done");
  assert.match(await tid(page, "todo-list").getByTestId("todo-item").getAttribute("class"), /done/);
  assert.deepEqual(errors, []);
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

test("E2E TODO-03 blank to-dos are ignored and HTML is shown as text", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-todo").click();
  const before = await tid(page, "todo-item").count();
  await tid(page, "todo-fab").click();
  await tid(page, "todo-input").fill("   ");
  await tid(page, "todo-add").click();
  assert.equal(await tid(page, "todo-item").count(), before);
  await tid(page, "todo-input").fill(`<img src=x onerror="window.__xss=1">`);
  await tid(page, "todo-add").click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
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

test("E2E DATA-10 a change made in another tab shows up here instead of being overwritten later", async () => {
  const a = await open();
  const other = await a.ctx.newPage();
  await other.goto(`${mock.url}?today=${TODAY}`);
  await tid(other, "cal-grid").waitFor();
  await tid(other, "tab-todo").click();
  await tid(other, "todo-idea").first().click();
  const text = await other.evaluate(() => window.__mealPlanner.state.todos[0].text);
  await a.page.waitForFunction((t) => window.__mealPlanner.state.todos.some((x) => x.text === t), text);
  await a.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("another tab"));
  // An edit here now keeps the other tab's to-do.
  await tid(a.page, "tab-todo").click();
  await tid(a.page, "todo-idea").nth(1).click();
  await other.waitForFunction(() => window.__mealPlanner.state.todos.length === 2);
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
  await tid(a.page, "tab-todo").click();
  await tid(a.page, "todo-idea").first().click();
  await tid(a.page, "save-warning").waitFor();
  assert.match(await tid(a.page, "save-warning").innerText(), /aren't being saved/);
  await a.page.evaluate(() => window.__restoreSave());
  await tid(a.page, "todo-idea").nth(1).click();
  await tid(a.page, "save-warning").waitFor({ state: "hidden" });
  await a.ctx.close();
});

// ---------- AI recipes with the family's own Claude API key (sites with no server, like GitHub Pages) ----------
const FAKE_KEY = "sk-ant-api03-" + "x".repeat(40);
const claudeRecipe = (o) => ({ title: "Ragi banana porridge", forWhom: "baby", mealType: "breakfast", texture: "porridge", prepMinutes: 10,
  ingredients: [{ name: "ragi flour", quantity: 2, unit: "tbsp" }, { name: "water", quantity: 1, unit: "cup" }, { name: "banana", quantity: 0.5, unit: "pcs" }],
  steps: ["Whisk ragi into water.", "Cook on low, stirring, until thick.", "Mash in banana and cool."], notes: "", ...o });

async function fakeClaude(page, { status = 200, recipes = [claudeRecipe()] } = {}) {
  const calls = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    calls.push({ headers: req.headers(), body: JSON.parse(req.postData() || "{}") });
    if (status !== 200) return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ recipes }) }] }) });
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
