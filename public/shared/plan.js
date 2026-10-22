// Day plans, approval and "what is pending" logic. Pure functions over the app state.

import { addDays, isSchoolDay, occurrences } from "./dates.js";

export const SLOTS = [
  { id: "baby_breakfast", who: "baby", label: "Baby breakfast" },
  { id: "baby_lunch", who: "baby", label: "Baby lunch" },
  { id: "baby_snack", who: "baby", label: "Baby evening snack" },
  { id: "baby_dinner", who: "baby", label: "Baby dinner" },
  { id: "kid_breakfast", who: "kid", label: "Breakfast (4 yr)" },
  { id: "kid_lunchbox", who: "kid", label: "School lunchbox", schoolOnly: true },
  { id: "kid_snack", who: "kid", label: "Snack box / after school" },
  { id: "family_dinner", who: "family", label: "Family dinner" },
];

export const DEFAULT_BRING = {
  kid: ["Lunchbox", "Snack box", "Water bottle", "Napkin", "School diary / folder", "Spare clothes"],
  baby: ["Diapers (4)", "Wipes", "Change of clothes", "Bib", "Baby food container and spoon", "Milk bottle / formula", "Burp cloth"],
};

export function emptyDay() {
  return { meals: {}, schedule: [], status: "pending", approvedAt: null, changedAfterApproval: false, bring: {}, extraBring: [], useBabyBag: false };
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

// Bring-list items for a date: kid school bag on school days, baby bag if switched on, plus extras.
export function bringItemsFor(state, key) {
  const day = getDay(state, key) || emptyDay();
  const tpl = state.bringTemplates || DEFAULT_BRING;
  const items = [];
  if (isSchoolDay(key)) tpl.kid.forEach((text, i) => items.push({ id: `kid:${text}`, text, who: "kid", order: i }));
  if (day.useBabyBag) tpl.baby.forEach((text, i) => items.push({ id: `baby:${text}`, text, who: "baby", order: i }));
  (day.extraBring || []).forEach((x) => items.push({ id: `extra:${x.id}`, text: x.text, who: x.who || "family", extra: true }));
  return items.map((it) => ({ ...it, packed: !!day.bring?.[it.id] }));
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
//   - bring items not packed (today and tomorrow only)
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
  if (!isPast && key <= addDays(today, 1)) {
    const unpacked = bringItemsFor(state, key).filter((i) => !i.packed);
    if (unpacked.length) out.push({ type: "bring", text: `${unpacked.length} item${unpacked.length > 1 ? "s" : ""} to pack` });
  }
  return out;
}

// Calendar dot: "approved" | "pending" | "empty".
export function dayStatus(state, key) {
  const day = getDay(state, key);
  if (!dayHasPlan(day)) return "empty";
  return day.status === "approved" ? "approved" : "pending";
}
