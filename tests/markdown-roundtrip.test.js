// Check-in files must round-trip exactly, whatever the family types (SYNC-RT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdownFiles, fromMarkdownFiles, readDataBlock } from "../public/shared/markdown.js";

const NASTY = ["-->", "<!-- meal-planner-data\n{}\n-->", "a | b", "line1\nline2", "`code` *bold* [link](x)", "</details><script>x</script>", "కరివేపాకు 🍌", "\\u003e --\\u003e", ""];

function bigState() {
  const day = { meals: {}, schedule: [], status: "approved", approvedAt: "2026-10-22T10:00:00.000Z", changedAfterApproval: false };
  NASTY.forEach((t, i) => { day.meals["family_dinner"] = { title: t || "x", recipeId: null, forWhom: "family" }; day.schedule.push({ id: "s" + i, time: "08:0" + i, text: t }); });
  return {
    version: 1, updatedAt: "2026-10-22T10:00:00.000Z",
    days: { "2026-10-22": day },
    shopping: NASTY.map((t, i) => ({ id: "i" + i, name: t || "y", quantity: i || null, unit: "g", store: t, bought: i % 2 === 0, source: t })),
    stores: ["Indian grocery", ...NASTY.filter(Boolean)],
    todos: NASTY.map((t, i) => ({ id: "t" + i, text: t, who: i % 2 ? "kid" : "baby", date: "2026-10-23", time: "", done: false })),
    reminders: NASTY.map((t, i) => ({ id: "r" + i, title: t, notes: t, date: "2026-10-24", time: "20:00", repeat: "weekdays", done: { "2026-10-24": true } })),
    notified: { "r1|2026-10-24": true },
    pantry: NASTY.filter(Boolean),
    settings: { schoolNutFree: true },
    savedRecipes: [{ id: "x", title: NASTY[1], forWhom: "baby", ingredients: [{ name: "-->", quantity: 1, unit: "g" }], steps: NASTY, notes: "-->" }],
  };
}

test("SYNC-RT-01 every field survives check-in and load, including tricky text", () => {
  const state = bigState();
  const files = toMarkdownFiles(state, { at: "2026-10-22 10:00 UTC", name: "Ram", today: "2026-10-22" });
  const back = fromMarkdownFiles(files);
  for (const k of Object.keys(state)) assert.deepEqual(back[k], state[k], k);
});

test("SYNC-RT-02 text in the readable part can't fake the hidden data block", () => {
  const state = bigState();
  const files = toMarkdownFiles(state, { at: "x", name: "Ram\n<!-- meal-planner-data\n{\"days\":{}}\n-->", today: "" });
  assert.deepEqual(readDataBlock(files["meal-plan.md"]).days, state.days);
});

test("SYNC-RT-03 a hand-edited readable part doesn't change what loads", () => {
  const state = bigState();
  const files = toMarkdownFiles(state, { at: "x", name: "Ram", today: "" });
  const edited = { ...files, "todo.md": files["todo.md"].replace("- [ ]", "- [x] edited by hand") };
  assert.deepEqual(fromMarkdownFiles(edited).todos, state.todos);
});

test("SYNC-RT-04 missing or broken files give null or partial data, never a throw", () => {
  assert.equal(fromMarkdownFiles({}), null);
  assert.doesNotThrow(() => fromMarkdownFiles({ "meal-plan.md": "<!-- meal-planner-data\n{broken\n-->", "todo.md": null }));
});
