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

// Fresh browser context per test so localStorage starts empty. Collects console errors.
async function open(server = mock, { today = TODAY, viewport } = {}) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
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

async function planSlot(page, date, slot, title) {
  await cell(page, date).click();
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

test("E2E CAL-05/06 clicking a date lists what is pending: plan, reminders, bring items", async () => {
  const { page, ctx } = await open();
  await cell(page, TODAY).click();
  const t = await pendingTypes(page);
  assert.ok(t.includes("plan"), "no 'No meal plan yet'");
  assert.ok(t.includes("bring"), "no bring items on a school day");
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
  await tid(page, "shop-name").fill("Curry leaves");
  await tid(page, "shop-add").click();
  assert.equal(await tid(page, "shop-item").count(), 1);
  await ctx.setOffline(false);
  await ctx.close();
});

test("E2E SHOP-02/05 add items, merge duplicates, tick bought, survives reload", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-shopping").click();
  for (const [n, q, u] of [["Toor dal", "500", "g"], ["tuvar dal", "1", "kg"], ["Curry leaves", "", ""]]) {
    await tid(page, "shop-name").fill(n);
    await tid(page, "shop-qty").fill(q);
    if (u) await tid(page, "shop-unit").fill(u).catch(() => tid(page, "shop-unit").selectOption(u));
    await tid(page, "shop-add").click();
  }
  assert.equal(await tid(page, "shop-item").count(), 2);
  assert.match(await page.locator('[data-testid=shop-item][data-name="toor dal"]').innerText(), /1\.5\s*kg/);
  await page.locator('[data-testid=shop-item][data-name="curry leaves"] input[type=checkbox]').check();
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
  await tid(page, "shop-name").fill("Drumstick");
  await tid(page, "shop-add").click();
  await tid(page, "store-mode").click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page is ${overflow}px wider than the phone`);
  await ctx.close();
});

test("E2E BRING-01/03/04 school bag on weekdays, packed state per date, nothing on Saturday", async () => {
  const { page, ctx } = await open();
  await tid(page, "tab-bring").click();
  const texts = await tid(page, "bring-item").allInnerTexts();
  assert.ok(texts.some((t) => /Lunchbox/.test(t)));
  await tid(page, "bring-item").first().locator("input[type=checkbox]").check();
  await page.waitForTimeout(300);
  await page.reload();
  await tid(page, "tab-bring").click();
  assert.ok(await tid(page, "bring-item").first().locator("input[type=checkbox]").isChecked());
  await tid(page, "bring-date").fill("2026-10-24");
  await tid(page, "bring-date").dispatchEvent("change");
  assert.ok(!(await tid(page, "bring-item").allInnerTexts()).some((t) => /Lunchbox/.test(t)));
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
  const { page, ctx } = await open();
  await page.evaluate(() => localStorage.setItem("familyMealPlanner.v1", "{broken"));
  await page.reload();
  await tid(page, "cal-grid").waitFor({ timeout: 3000 });
  await page.evaluate(() => localStorage.setItem("familyMealPlanner.v1", JSON.stringify({ version: 1, days: "oops", reminders: null, shopping: 5, pantry: null })));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.reload();
  await page.waitForTimeout(500);
  assert.ok(await tid(page, "cal-grid").isVisible(), "calendar did not render: " + errors.join("; "));
  await ctx.close();
});

test("E2E DATA-04 HTML typed into fields is shown as text, never run", async () => {
  const { page, ctx } = await open();
  const xss = `<img src=x onerror="window.__xss=1">`;
  await planSlot(page, TOMORROW, "family_dinner", xss);
  await tid(page, "tab-shopping").click();
  await tid(page, "shop-name").fill(xss);
  await tid(page, "shop-add").click();
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
  for (const tab of ["calendar", "recipes", "shopping", "bring", "reminders"]) {
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
