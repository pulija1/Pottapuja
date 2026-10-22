// Local storage of all app data. Works fully offline; nothing is sent to the server except recipe requests.

import { migrateBringToTodos } from "./shared/plan.js";

const KEY = "familyMealPlanner.v1";

export function defaultState() {
  return {
    version: 1,
    pantry: ["rice", "moong dal", "toor dal", "ragi flour", "rava", "curd", "ghee", "carrot", "banana", "tomato", "onion", "idli/dosa batter", "curry leaves", "mustard seeds", "turmeric"],
    savedRecipes: [],
    days: {},
    shopping: [],
    stores: ["Indian grocery", "Supermarket", "Costco"],
    todos: [],
    reminders: [],
    notified: {},
    settings: { schoolNutFree: false },
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
  for (const k of ["savedRecipes", "shopping", "todos", "reminders"]) out[k] = out[k].filter((x) => typeof x === "object");
  out.todos = out.todos.filter((t) => typeof t.text === "string" && typeof t.date === "string");
  out.shopping = out.shopping.filter((i) => typeof i.name === "string");
  out.reminders = out.reminders.filter((r) => typeof r.title === "string" && typeof r.date === "string");
  for (const [key, day] of Object.entries(out.days)) {
    if (!day || typeof day !== "object" || Array.isArray(day)) { delete out.days[key]; continue; }
    if (!day.meals || typeof day.meals !== "object") day.meals = {};
    if (!Array.isArray(day.schedule)) day.schedule = [];
  }
  return migrateBringToTodos(out);
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
let lastError = null;

export function save(state, { now = false } = {}) {
  const write = () => {
    timer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      lastError = null;
    } catch (e) {
      lastError = e;
      console.warn("Could not save", e);
    }
  };
  if (now) {
    clearTimeout(timer);
    write();
  } else if (!timer) {
    timer = setTimeout(write, 150);
  }
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
