// Family sync (SYNC): how the data is split into Firestore documents and how two phones' changes merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decodeInto, merge, firstMerge, diff, docFor, sectionOf, clone, cleanDoc, normEmail, validEmail } from "../public/shared/cloud-sync.js";
import { defaultState } from "../public/store.js";

function sample() {
  const s = defaultState();
  s.shopping = [{ id: "a1", name: "toor dal", bought: false }, { id: "b2", name: "ghee", bought: false }];
  s.todos = [{ id: "t1", text: "Pack the school bag", date: "2026-10-23", done: false }, { id: "t2", text: "Buy dresses", date: "2026-11-02", done: false }];
  s.reminders = [{ id: "r1", title: "Vaccine", date: "2026-11-05", done: {} }];
  s.savedRecipes = [{ id: "rec1", title: "Ragi porridge", forWhom: "baby" }];
  s.days = { "2026-10-23": { meals: { baby_breakfast: { title: "Ragi porridge" } }, schedule: [] } };
  s.notified = { "r1|2026-11-05": true };
  return s;
}

test("SYNC-01 items go to small documents: one per list, per month for to-dos and days", () => {
  const docs = encode(sample());
  assert.deepEqual(Object.keys(docs.shopping), ["a1", "b2"]);
  assert.ok(docs["todos-2026-10"].t1 && docs["todos-2026-11"].t2);
  assert.ok(docs["days-2026-10"]["2026-10-23"]);
  assert.ok(docs.reminders.r1);
  assert.equal(Object.keys(docs).filter((d) => d.startsWith("recipes-")).length, 1);
  assert.deepEqual(Object.keys(docs.meta).sort(), ["pantry", "settings", "stores"]);
  for (const d of Object.keys(docs)) assert.ok(sectionOf(d), d);
  assert.equal(sectionOf("bogus"), null);
  assert.equal(docFor("todos", "x", { date: "" }), "todos-none");
});

test("SYNC-02 encode then decode gives the same data back, and the alerts list stays on the phone", () => {
  const s = sample();
  const docs = encode(s);
  const other = defaultState();
  other.notified = { mine: true };
  assert.equal(decodeInto(other, docs), true);
  for (const k of ["shopping", "todos", "reminders", "savedRecipes", "days", "pantry", "stores", "settings"]) assert.deepEqual(other[k], s[k], k);
  assert.deepEqual(other.notified, { mine: true });
  assert.equal(decodeInto(other, docs), false, "nothing changes the second time");
});

test("SYNC-03 items without an id get one so they can sync", () => {
  const s = defaultState();
  s.shopping = [{ name: "rava" }];
  const docs = encode(s);
  assert.ok(s.shopping[0].id);
  assert.ok(docs.shopping[s.shopping[0].id]);
});

test("SYNC-04 two phones tick different shopping items at the same time: both ticks stay", () => {
  const start = sample();
  const base = encode(start);
  const a = structuredClone(start); a.shopping[0].bought = true;
  const b = structuredClone(start); b.shopping[1].bought = true;
  // Phone B wrote first; phone A merges B's change into its own.
  const remote = encode(b);
  const merged = merge(encode(a), base, remote);
  const s = structuredClone(a);
  decodeInto(s, merged);
  assert.deepEqual(s.shopping.map((i) => i.bought), [true, true]);
  // What A writes is only its own item.
  const { writes } = diff(merged, remote);
  assert.deepEqual(Object.keys(writes), ["shopping"]);
  assert.deepEqual(Object.keys(writes.shopping), ["a1"]);
});

test("SYNC-05 a delete on another phone removes the item here; a local edit to the same item wins", () => {
  const start = sample();
  const base = encode(start);
  const remoteState = structuredClone(start);
  remoteState.shopping = remoteState.shopping.filter((i) => i.id !== "a1");
  remoteState.todos = remoteState.todos.filter((t) => t.id !== "t1");
  const local = structuredClone(start);
  local.todos[0].done = true;   // edited here while the other phone deleted it
  const merged = merge(encode(local), base, encode(remoteState));
  const s = structuredClone(local);
  decodeInto(s, merged);
  assert.deepEqual(s.shopping.map((i) => i.id), ["b2"]);
  assert.deepEqual(s.todos.map((t) => t.id), ["t1", "t2"]);
});

test("SYNC-06 new items from another phone are added after this phone's items, in a stable order", () => {
  const start = sample();
  const base = encode(start);
  const remoteState = structuredClone(start);
  remoteState.shopping.push({ id: "z9", name: "curd" }, { id: "c3", name: "rice" });
  const s = structuredClone(start);
  decodeInto(s, merge(encode(s), base, encode(remoteState)));
  assert.deepEqual(s.shopping.map((i) => i.id), ["a1", "b2", "c3", "z9"]);
});

test("SYNC-07 moving a to-do to another month moves it between documents", () => {
  const start = sample();
  const base = encode(start);
  start.todos[0].date = "2026-11-01";
  const { writes, empty } = diff(encode(start), base);
  assert.deepEqual(empty, ["todos-2026-10"]);
  assert.ok(writes["todos-2026-11"].t1);
});

test("SYNC-08 first sync: an unused phone takes the family's data; a used phone adds its own", () => {
  const family = sample();
  const remote = encode(family);
  const fresh = defaultState();
  const takeAll = firstMerge(encode(fresh), remote, { used: false });
  assert.deepEqual(takeAll, remote);

  const mine = defaultState();
  mine.shopping = [{ id: "m1", name: "jaggery" }, { id: "a1", name: "toor dal", bought: true }];
  mine.pantry = ["rice", "jaggery"];
  mine.stores = ["Patel Brothers"];
  const s = structuredClone(mine);
  decodeInto(s, firstMerge(encode(mine), remote, { used: true }));
  assert.deepEqual(s.shopping.map((i) => i.id).sort(), ["a1", "b2", "m1"]);
  assert.equal(s.shopping.find((i) => i.id === "a1").bought, false, "the family's copy wins for the same item");
  assert.ok(s.pantry.includes("jaggery") && s.pantry.includes("turmeric"), "kitchen lists are combined");
  assert.ok(s.stores.includes("Patel Brothers") && s.stores.includes("Costco"));
  assert.equal(s.pantry.filter((p) => p === "rice").length, 1);
});

test("SYNC-09 first sync into an empty family space uploads everything", () => {
  const mine = sample();
  const merged = firstMerge(encode(mine), {}, { used: true });
  assert.deepEqual(merged, encode(mine));
  const { writes } = diff(merged, {});
  assert.ok(writes.shopping && writes.meta && writes.reminders);
});

test("SYNC-10 broken or foreign fields in the cloud are ignored", () => {
  const s = sample();
  const docs = clone(encode(s));
  docs.shopping.bad = "{not json";
  docs.shopping.num = 5;
  docs.meta.evil = JSON.stringify("x");
  docs.other = { a: "1" };
  assert.deepEqual(cleanDoc({ a: "1", b: 2, c: null }), { a: "1" });
  const t = sample();
  decodeInto(t, docs);
  assert.deepEqual(t.shopping, s.shopping);
  assert.equal(t.evil, undefined);
});

test("SYNC-11 emails are compared in lower case", () => {
  assert.equal(normEmail("  Ram@Gmail.COM "), "ram@gmail.com");
  assert.ok(validEmail("a@b.co"));
  assert.ok(!validEmail("not an email"));
});
