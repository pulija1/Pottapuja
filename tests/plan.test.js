// Calendar approval and pending states (CAL), items to bring (BRING), reminders (REM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDay, approveDay, unapproveDay, markEdited, pendingFor, dayStatus, bringItemsFor, remindersOn, slotsFor, dayHasPlan } from "../public/shared/plan.js";
import { occurrences, monthGrid, addDays, addMonths, isSchoolDay, isDateKey } from "../public/shared/dates.js";

const TODAY = "2026-10-22"; // Thursday
const planned = (title = "Ragi porridge") => ({ ...emptyDay(), meals: { baby_breakfast: { title } } });
const st = (days = {}, reminders = []) => ({ days, reminders });
const types = (p) => p.map((x) => x.type);

test("CAL-01 status is empty, pending or approved", () => {
  const s = st({ "2026-10-23": planned(), "2026-10-24": approveDay(planned()) });
  assert.equal(dayStatus(s, "2026-10-22"), "empty");
  assert.equal(dayStatus(s, "2026-10-23"), "pending");
  assert.equal(dayStatus(s, "2026-10-24"), "approved");
});

test("CAL-01b a day with only a schedule entry counts as planned", () => {
  const d = { ...emptyDay(), schedule: [{ id: "1", time: "08:00", text: "School drop" }] };
  assert.equal(dayHasPlan(d), true);
});

test("CAL-02 a planned, unapproved day shows approval pending", () => {
  const p = pendingFor(st({ [TODAY]: planned() }), TODAY, TODAY);
  assert.ok(types(p).includes("approval"));
});

test("CAL-03 approving clears the approval item", () => {
  const p = pendingFor(st({ "2026-10-24": approveDay(planned()) }), "2026-10-24", TODAY);
  assert.ok(!types(p).includes("approval"));
});

test("CAL-04 editing an approved day sends it back to pending with a 'changed' note", () => {
  const d = markEdited(approveDay(planned()));
  assert.equal(d.status, "pending");
  const p = pendingFor(st({ "2026-10-24": d }), "2026-10-24", TODAY);
  assert.match(p.find((x) => x.type === "approval").text, /changed after approval/i);
});

test("CAL-04b editing a pending day keeps it pending and not 'changed'", () => {
  const d = markEdited(planned());
  assert.equal(d.status, "pending");
  assert.equal(d.changedAfterApproval, false);
});

test("CAL-04c unapproving clears the 'changed after approval' note", () => {
  const d = unapproveDay(approveDay(markEdited(approveDay(planned()))));
  assert.equal(d.changedAfterApproval, false);
});

test("CAL-05 days in the next week with no plan say 'no meal plan yet'; further out they don't", () => {
  assert.ok(types(pendingFor(st(), addDays(TODAY, 6), TODAY)).includes("plan"));
  assert.ok(!types(pendingFor(st(), addDays(TODAY, 7), TODAY)).includes("plan"));
});

test("CAL-06 pending lists reminders and bring items for the date", () => {
  const s = st({}, [{ id: "r1", title: "Soak urad dal", date: TODAY, time: "20:00", repeat: "none" }]);
  const t = types(pendingFor(s, TODAY, TODAY));
  assert.ok(t.includes("reminder"));
  assert.ok(t.includes("bring")); // Thursday is a school day
});

test("CAL-08 past days don't ask for approval but keep overdue reminders", () => {
  const past = addDays(TODAY, -2);
  const s = st({ [past]: planned() }, [{ id: "r1", title: "Pay school fee", date: past, repeat: "none" }]);
  const p = pendingFor(s, past, TODAY);
  assert.ok(!types(p).includes("approval"));
  assert.ok(p.find((x) => x.type === "reminder").overdue);
});

test("CAL-09 month grid: 42 cells, starts on Sunday, handles leap year", () => {
  const g = monthGrid("2028-02-10");
  assert.equal(g.length, 42);
  assert.equal(new Date(g[0].key + "T12:00").getDay(), 0);
  assert.ok(g.some((c) => c.key === "2028-02-29" && c.inMonth));
  assert.ok(!monthGrid("2026-02-10").some((c) => c.key === "2026-02-29"));
  assert.equal(isDateKey("2026-02-29"), false);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
});

test("CAL-10 approving twice is harmless", () => {
  const d = approveDay(approveDay(planned()));
  assert.equal(d.status, "approved");
  assert.equal(dayStatus(st({ x: d }), "x"), "approved");
});

test("CAL-11 date keys survive DST changes (US and India)", () => {
  assert.equal(addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
});

test("BRING-01 school days include the kid's school bag", () => {
  const items = bringItemsFor(st(), TODAY).map((i) => i.text);
  for (const x of ["Lunchbox", "Snack box", "Water bottle"]) assert.ok(items.includes(x), x);
});

test("BRING-02 baby bag only when switched on", () => {
  assert.ok(!bringItemsFor(st(), TODAY).some((i) => i.who === "baby"));
  const s = st({ [TODAY]: { ...emptyDay(), useBabyBag: true } });
  assert.ok(bringItemsFor(s, TODAY).some((i) => i.text.startsWith("Diapers")));
});

test("BRING-03 packed state is per date", () => {
  const s = st({ [TODAY]: { ...emptyDay(), bring: { "kid:Lunchbox": true } } });
  assert.equal(bringItemsFor(s, TODAY).find((i) => i.text === "Lunchbox").packed, true);
  assert.equal(bringItemsFor(s, addDays(TODAY, 1)).find((i) => i.text === "Lunchbox").packed, false);
});

test("BRING-04 weekends have no school bag and no lunchbox slot", () => {
  const sat = "2026-10-24";
  assert.equal(isSchoolDay(sat), false);
  assert.ok(!bringItemsFor(st(), sat).some((i) => i.who === "kid"));
  assert.ok(!slotsFor(sat).some((s) => s.id === "kid_lunchbox"));
  assert.ok(slotsFor(TODAY).some((s) => s.id === "kid_lunchbox"));
});

test("REM-01 reminders on a date are sorted by time, untimed last", () => {
  const s = st({}, [
    { id: "a", title: "untimed", date: TODAY },
    { id: "b", title: "late", date: TODAY, time: "20:00" },
    { id: "c", title: "early", date: TODAY, time: "07:30" },
  ]);
  assert.deepEqual(remindersOn(s, TODAY).map((r) => r.id), ["c", "b", "a"]);
});

test("REM-06 marking a repeating reminder done only affects that date", () => {
  const s = st({}, [{ id: "a", title: "x", date: TODAY, repeat: "daily", done: { [TODAY]: true } }]);
  assert.equal(remindersOn(s, TODAY)[0].doneOnDate, true);
  assert.equal(remindersOn(s, addDays(TODAY, 1))[0].doneOnDate, false);
});

test("REM-07 daily, weekly and monthly repeats", () => {
  assert.equal(occurrences({ date: TODAY, repeat: "daily" }, TODAY, addDays(TODAY, 6)).length, 7);
  assert.deepEqual(occurrences({ date: TODAY, repeat: "weekly" }, TODAY, addDays(TODAY, 14)), [TODAY, "2026-10-29", "2026-11-05"]);
  assert.deepEqual(occurrences({ date: "2026-01-31", repeat: "monthly" }, "2026-02-01", "2026-03-31"), ["2026-02-28", "2026-03-31"]);
  assert.deepEqual(occurrences({ date: TODAY, repeat: "none" }, addDays(TODAY, 1), addDays(TODAY, 5)), []);
});

test("REM-07b a 'school days' repeat (Mon to Fri) exists for lunchbox and soaking reminders", () => {
  const occ = occurrences({ date: TODAY, repeat: "weekdays" }, TODAY, addDays(TODAY, 6));
  assert.deepEqual(occ, ["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"]);
});

test("REM-09 a daily reminder still shows three years after it was created", () => {
  const start = "2026-01-01";
  assert.deepEqual(occurrences({ date: start, repeat: "daily" }, "2029-01-01", "2029-01-01"), ["2029-01-01"]);
});

test("REM-10 a reminder with a bad date is ignored, not a crash", () => {
  assert.deepEqual(occurrences({ date: "2026-13-40", repeat: "daily" }, TODAY, TODAY), []);
  assert.doesNotThrow(() => pendingFor(st({}, [{ id: "x", title: "y", date: "nope" }]), TODAY, TODAY));
});
