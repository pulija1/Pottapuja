// Local storage of all app data. Works fully offline; nothing is sent to the server except recipe requests.

import { DEFAULT_BRING } from "./shared/plan.js";

const KEY = "familyMealPlanner.v1";

export function defaultState() {
  return {
    version: 1,
    pantry: ["rice", "moong dal", "toor dal", "ragi flour", "rava", "curd", "ghee", "carrot", "banana", "tomato", "onion", "idli/dosa batter", "curry leaves", "mustard seeds", "turmeric"],
    savedRecipes: [],
    days: {},
    shopping: [],
    stores: ["Indian grocery", "Supermarket", "Costco"],
    bringTemplates: structuredClone(DEFAULT_BRING),
    reminders: [],
    notified: {},
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || data.version !== 1) return defaultState();
    return { ...defaultState(), ...data };
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
  return { ...defaultState(), ...data };
}

export const STORAGE_KEY = KEY;
