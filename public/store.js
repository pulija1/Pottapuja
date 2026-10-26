// Local storage of all app data. Works fully offline; nothing is sent to the server except recipe requests.

import { migrateBringToTodos } from "./shared/plan.js";

const KEY = "familyMealPlanner.v1";
const STORES = ["Indian grocery", "Supermarket", "Costco", "HEB", "Trader Joe's", "Kroger"];
const NEW_STORES = ["HEB", "Trader Joe's", "Kroger"];

export function defaultState() {
  return {
    version: 1,
    pantry: ["rice", "moong dal", "toor dal", "ragi flour", "rava", "curd", "ghee", "carrot", "banana", "tomato", "onion", "idli/dosa batter", "curry leaves", "mustard seeds", "turmeric"],
    pantryDates: {},   // kitchen item (normName) -> { added, expires }: when it came in and its use-by date ("" = estimate it)
    savedRecipes: [],
    days: {},
    shopping: [],
    stores: [...STORES],
    todos: [],
    frozen: [],        // what's in the freezer: { id, name, qty, unit, date (when it went in), note }
    reminders: [],
    notified: {},
    settings: { schoolNutFree: false, kidName: "", babyName: "", airFryer: "", oven: false, moreStores: true },   // airFryer: "dual" (two baskets), "single" or ""
    updatedAt: null,   // last change made in the app; family sync uses it to tell a used phone from a new one
  };
}

// Saved data can be old, hand-edited or half-written: keep each field only if it has the right shape.
function sanitize(data) {
  const def = defaultState();
  const out = { ...def };
  for (const [k, v] of Object.entries(def)) {
    const d = data[k];
    if (Array.isArray(v)) out[k] = Array.isArray(d) ? d.filter((x) => x && (typeof x === "object" || typeof x === "string")) : v;
    else if (v && typeof v === "object") out[k] = d && typeof d === "object" && !Array.isArray(d) ? { ...v, ...d } : v;
    else if (d !== undefined) out[k] = d;
  }
  out.pantry = out.pantry.filter((x) => typeof x === "string");
  out.stores = out.stores.filter((x) => typeof x === "string");
  // Lists saved before HEB, Trader Joe's and Kroger were offered get them once; one removed later stays removed.
  if (!data.settings?.moreStores) out.stores.push(...NEW_STORES.filter((x) => !out.stores.includes(x)));
  out.pantryDates = cleanPantryDates(out.pantryDates);
  for (const k of ["savedRecipes", "shopping", "todos", "frozen", "reminders"]) out[k] = out[k].filter((x) => typeof x === "object");
  out.todos = out.todos.filter((t) => typeof t.text === "string" && typeof t.date === "string");
  out.shopping = out.shopping.filter((i) => typeof i.name === "string");
  out.frozen = out.frozen.filter((i) => typeof i.name === "string");
  out.reminders = out.reminders.filter((r) => typeof r.title === "string" && typeof r.date === "string");
  for (const [key, day] of Object.entries(out.days)) {
    if (!day || typeof day !== "object" || Array.isArray(day)) { delete out.days[key]; continue; }
    if (!day.meals || typeof day.meals !== "object") day.meals = {};
    if (!Array.isArray(day.schedule)) day.schedule = [];
  }
  return migrateBringToTodos(out);
}

// Only { added, expires } date strings survive; anything else in the map is dropped.
export function cleanPantryDates(v) {
  const out = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const date = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");
  for (const [k, e] of Object.entries(v)) {
    if (!k || !e || typeof e !== "object") continue;
    out[k] = { added: date(e.added), expires: date(e.expires) };
  }
  return out;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || data.version !== 1) return defaultState();
    return sanitize(data);
  } catch {
    return defaultState();
  }
}

let timer = null;
let changeListener = null;
export function onChange(fn) { changeListener = fn; }
let lastError = null;
let errorListener = null;
// Called with the error when a write fails (storage full or blocked), and with null once writes work again.
export function onSaveError(fn) { errorListener = fn; }

export function save(state, { now = false } = {}) {
  const write = () => {
    timer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      if (lastError) { lastError = null; errorListener?.(null); }
    } catch (e) {
      lastError = e;
      console.warn("Could not save", e);
      errorListener?.(e);
    }
  };
  // Only edits bump the change time; the "now" saves (page close, restore) don't change anything.
  if (!now) { state.updatedAt = new Date().toISOString(); changeListener?.(); }
  if (now) {
    clearTimeout(timer);
    write();
  } else if (!timer) {
    timer = setTimeout(write, 150);
  }
}

// Drop a write that hasn't happened yet, e.g. because another tab saved newer data.
export function cancelPendingSave() {
  clearTimeout(timer);
  timer = null;
}

export function saveError() {
  return lastError;
}

export function exportJson(state) {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1) throw new Error("This is not a meal planner backup.");
  return sanitize(data);
}

export const STORAGE_KEY = KEY;
