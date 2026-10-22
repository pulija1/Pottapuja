// Day plans, approval and "what is pending" logic. Pure functions over the app state.

import { addDays, isSchoolDay, occurrences } from "./dates.js";

export const SLOTS = [
  { id: "baby_breakfast", who: "baby", label: "{baby} breakfast" },
  { id: "baby_lunch", who: "baby", label: "{baby} lunch" },
  { id: "baby_snack", who: "baby", label: "{baby} evening snack" },
  { id: "baby_dinner", who: "baby", label: "{baby} dinner" },
  { id: "kid_breakfast", who: "kid", label: "{kid} breakfast" },
  { id: "kid_lunchbox", who: "kid", label: "School lunchbox", schoolOnly: true },
  { id: "kid_snack", who: "kid", label: "Snack box / after school" },
  { id: "family_dinner", who: "family", label: "Family dinner" },
];

// The day panel groups meals into these collapsible sections, in this order.
export const MEAL_GROUPS = [
  { who: "kid", icon: "👧" },
  { who: "baby", icon: "👶" },
  { who: "family", icon: "🍛" },
];

// The children's names live in the family's own data (settings), never in the code, because
// the code is public. Without names the labels fall back to the ages.
export function whoLabel(who, settings = {}, { age = false } = {}) {
  const kid = String(settings?.kidName || "").trim();
  const baby = String(settings?.babyName || "").trim();
  if (who === "kid") return kid ? (age ? `${kid} (4 yrs)` : kid) : "4-year-old";
  if (who === "baby") return baby ? (age ? `${baby} (8 months)` : baby) : age ? "8-month-old" : "Baby";
  if (who === "both") return kid && baby ? `${kid} and ${baby}` : "Both kids";
  return "Family";
}

export function slotLabel(slot, settings) {
  return slot.label.replace("{kid}", whoLabel("kid", settings)).replace("{baby}", whoLabel("baby", settings));
}

// Ideas offered as one-tap to-dos.
export const TODO_IDEAS = [
  { text: "Buy dresses", who: "kid" },
  { text: "Check school schedule", who: "kid" },
  { text: "Pack school bag", who: "kid" },
  { text: "Doctor's appointment", who: "baby" },
  { text: "Buy diapers and wipes", who: "baby" },
  { text: "Pay school fees", who: "kid" },
];

export function emptyDay() {
  return { meals: {}, schedule: [], status: "pending", approvedAt: null, changedAfterApproval: false };
}

export function getDay(state, key) {
  return state.days?.[key] || null;
}

export function dayHasPlan(day) {
  if (!day) return false;
  return Object.values(day.meals || {}).some((m) => m && m.title) || (day.schedule || []).length > 0;
}

// Call after any change to a day's meals or schedule.
export function markEdited(day) {
  if (day.status === "approved") {
    day.status = "pending";
    day.approvedAt = null;
    day.changedAfterApproval = true;
  }
  return day;
}

export function approveDay(day, now = new Date()) {
  day.status = "approved";
  day.approvedAt = now.toISOString();
  day.changedAfterApproval = false;
  return day;
}

export function unapproveDay(day) {
  day.status = "pending";
  day.approvedAt = null;
  return day;
}

export function slotsFor(key) {
  return SLOTS.filter((s) => !s.schoolOnly || isSchoolDay(key));
}

// To-dos for the kids on a date ({ id, text, who, date, time, done }), timed ones first.
export function todosOn(state, key) {
  return (state.todos || [])
    .filter((t) => t.date === key)
    .sort((a, b) => String(a.time || "99").localeCompare(String(b.time || "99")) || a.text.localeCompare(b.text));
}

// Old saved data had per-day "to bring" extras; turn them into to-dos once.
export function migrateBringToTodos(state) {
  state.todos = state.todos || [];
  for (const [date, day] of Object.entries(state.days || {})) {
    for (const x of day.extraBring || []) {
      state.todos.push({ id: "b-" + x.id, text: x.text, who: x.who || "family", date, time: "", done: false });
    }
    delete day.extraBring;
    delete day.bring;
    delete day.useBabyBag;
  }
  delete state.bringTemplates;
  return state;
}

export function remindersOn(state, key) {
  const out = [];
  for (const r of state.reminders || []) {
    if (occurrences(r, key, key).length) out.push({ ...r, doneOnDate: !!r.done?.[key] });
  }
  return out.sort((a, b) => String(a.time || "99").localeCompare(String(b.time || "99")));
}

// Everything still open for a date, as a list of { type, text }.
//   - meal plan / schedule not approved (today and future)
//   - no meal plan yet (today through the next 6 days)
//   - reminders not marked done (any date, so overdue ones stay visible)
//   - to-dos not ticked off (any date, so missed ones stay visible)
export function pendingFor(state, key, today) {
  const out = [];
  const day = getDay(state, key);
  const isPast = key < today;
  if (!isPast) {
    if (dayHasPlan(day) && day.status !== "approved") {
      out.push({ type: "approval", text: day.changedAfterApproval ? "Plan changed after approval: approve again" : "Meal plan and schedule waiting for approval" });
    } else if (!dayHasPlan(day) && key <= addDays(today, 6)) {
      out.push({ type: "plan", text: "No meal plan yet" });
    }
  }
  for (const r of remindersOn(state, key)) {
    if (!r.doneOnDate) out.push({ type: "reminder", text: `${r.time ? r.time + " " : ""}${r.title}`, id: r.id, overdue: isPast });
  }
  for (const t of todosOn(state, key)) {
    if (!t.done) out.push({ type: "todo", text: `${t.time ? t.time + " " : ""}${t.text}`, id: t.id, overdue: isPast });
  }
  return out;
}

// Calendar dot: "approved" | "pending" | "empty".
export function dayStatus(state, key) {
  const day = getDay(state, key);
  if (!dayHasPlan(day)) return "empty";
  return day.status === "approved" ? "approved" : "pending";
}
