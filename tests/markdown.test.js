// Check-in files: readable Markdown that round-trips the app's data exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdownFiles, fromMarkdownFiles, readDataBlock, sessionMd, summarize, FILES, INDEX } from "../public/shared/markdown.js";
import { defaultState } from "../public/store.js";

const meta = { at: "2026-10-22 03:30 UTC", name: "Ram", today: "2026-10-22" };

function sample() {
  const s = defaultState();
  s.updatedAt = "2026-10-22T03:29:00.000Z";
  s.settings = { ...s.settings, kidName: "Asha", babyName: "Nila" };
  s.days["2026-10-23"] = { meals: { kid_lunchbox: { title: "Lemon rice", forWhom: "kid" }, baby_lunch: { title: "Moong dal khichdi (soft)", forWhom: "baby" } }, schedule: [{ id: "a", time: "08:15", text: "School drop-off" }], status: "approved", approvedAt: "x", changedAfterApproval: false };
  s.shopping = [{ id: "s1", name: "toor dal", quantity: 1, unit: "kg", bought: false }, { id: "s2", name: "paneer", quantity: null, unit: "", bought: true }];
  s.todos = [{ id: "t1", text: "Buy dresses | <b>party</b> -->", who: "kid", date: "2026-10-23", time: "", done: false }];
  s.reminders = [{ id: "r1", title: "Maya vaccine", date: "2026-10-30", time: "10:00", category: "health", repeat: "none", notes: "", done: {} }];
  s.savedRecipes = [{ id: "x", title: "Ragi dosa", forWhom: "kid", ingredients: [{ name: "ragi flour", quantity: 1, unit: "cup" }], steps: ["Mix.", "Cook."] }];
  return s;
}

test("SYNC-01 check-in files round-trip the app data exactly", () => {
  const s = sample();
  const files = toMarkdownFiles(s, meta);
  assert.deepEqual(Object.keys(files).sort(), [INDEX, ...Object.keys(FILES)].sort());
  const back = fromMarkdownFiles(files);
  for (const keys of Object.values(FILES)) for (const k of keys) assert.deepEqual(back[k], s[k], k);
  assert.equal(back.updatedAt, s.updatedAt);
});

test("SYNC-02 the files are readable Markdown with names, and '-->' in text can't break the data", () => {
  const files = toMarkdownFiles(sample(), meta);
  assert.match(files["meal-plan.md"], /## 2026-10-23 · ✅ Approved/);
  assert.match(files["meal-plan.md"], /\| School lunchbox \| Lemon rice \|/);
  assert.match(files["shopping-list.md"], /- \[x\] paneer/);
  assert.match(files["todo.md"], /- \[ \] Buy dresses \\\| <b>party<\/b> --> · Asha/);
  assert.match(files["reminders.md"], /Maya vaccine/);
  assert.match(files["meal-plan.md"], /\| Nila lunch \| Moong dal khichdi/);
  assert.match(files["recipes.md"], /## Ragi dosa[\s\S]*1\. Mix\./);
  assert.equal(readDataBlock(files["todo.md"]).todos[0].text, "Buy dresses | <b>party</b> -->");
});

test("SYNC-03 missing or hand-broken files are skipped, not fatal", () => {
  const files = toMarkdownFiles(sample(), meta);
  files["todo.md"] = "# edited by hand\n<!-- meal-planner-data\n{oops\n-->";
  delete files["recipes.md"];
  const back = fromMarkdownFiles(files);
  assert.equal(back.todos, undefined);
  assert.equal(back.savedRecipes, undefined);
  assert.equal(back.shopping.length, 2);
  assert.equal(fromMarkdownFiles({}), null);
});

test("SYNC-04 the session log shows what changed since the last check-in", () => {
  const s = sample();
  const prev = { ...summarize(s), mealsPlanned: 0, todosDone: 1 };
  const md = sessionMd(s, prev, meta);
  assert.match(md, /By: Ram/);
  assert.match(md, /\| Meals planned \| 2 \| \+2 \|/);
  assert.match(md, /\| To-dos done \| 0 \| -1 \|/);
  assert.match(sessionMd(s, null, meta), /First check-in from this device/);
});

test("SYNC-05 names come from the family's settings; without them labels use the ages", async () => {
  const { whoLabel, slotLabel, SLOTS } = await import("../public/shared/plan.js");
  assert.equal(whoLabel("kid", {}, { age: true }), "4-year-old");
  assert.equal(whoLabel("baby", {}), "Baby");
  assert.equal(whoLabel("kid", { kidName: "Asha" }, { age: true }), "Asha (4 yrs)");
  assert.equal(whoLabel("both", { kidName: "Asha", babyName: "Nila" }), "Asha and Nila");
  assert.equal(slotLabel(SLOTS.find((x) => x.id === "baby_lunch"), {}), "Baby lunch");
  assert.equal(slotLabel(SLOTS.find((x) => x.id === "kid_breakfast"), { kidName: "Asha" }), "Asha breakfast");
  const s = sample();
  const a = toMarkdownFiles(s, meta), b = toMarkdownFiles(s, { ...meta, at: "later", name: "Someone else" });
  for (const f of Object.keys(FILES)) assert.equal(a[f], b[f], f + " should not change when only the time or person changes");
});
