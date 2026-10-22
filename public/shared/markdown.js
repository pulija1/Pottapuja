// Turns the app's data into Markdown files for the family's git repository, and back.
// Each file has a readable part for people and, at the end, the exact data the app needs
// inside an HTML comment (invisible when GitHub shows the file). Loading reads only that
// comment, so editing the readable part by hand can't break the app.

import { SLOTS } from "./plan.js";
import { formatQty, groupByAisle } from "./shopping.js";

// Which parts of the app's data each file carries.
export const FILES = {
  "meal-plan.md": ["days"],
  "shopping-list.md": ["shopping", "stores"],
  "todo.md": ["todos"],
  "reminders.md": ["reminders", "notified"],
  "kitchen.md": ["pantry", "settings"],
  "recipes.md": ["savedRecipes"],
};
export const INDEX = "README.md";

const MARK = "meal-planner-data";
const WHO = { baby: "Maya", kid: "Dhari", family: "Family", both: "Dhari and Maya" };
const STATUS = { approved: "✅ Approved", pending: "⏳ Waiting for approval" };
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

// JSON can't contain "-->" outside strings, so escaping it inside strings keeps the comment closed.
function dataBlock(obj) {
  return `<!-- ${MARK}\n${JSON.stringify(obj, null, 1).replace(/-->/g, "--\\u003e")}\n-->\n`;
}

export function readDataBlock(md) {
  const m = String(md || "").match(new RegExp(`<!-- ${MARK}\\n([\\s\\S]*?)\\n-->`));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function pick(state, keys) {
  return Object.fromEntries(keys.map((k) => [k, state[k]]));
}

function header(title, meta) {
  return `# ${title}\n\n_Checked in ${meta.at}${meta.name ? ` by ${meta.name}` : ""}. Written by the Family Meal Planner app; edit in the app, not here._\n\n`;
}

function mealPlanMd(state, meta) {
  const keys = Object.keys(state.days || {}).filter((k) => {
    const d = state.days[k];
    return Object.values(d.meals || {}).some((m) => m?.title) || (d.schedule || []).length;
  }).sort().reverse();
  let out = header("Meal plan", meta);
  if (!keys.length) out += "Nothing planned yet.\n\n";
  for (const k of keys) {
    const d = state.days[k];
    out += `## ${k} · ${STATUS[d.status] || STATUS.pending}${d.changedAfterApproval && d.status !== "approved" ? " (changed after approval)" : ""}\n\n`;
    const meals = SLOTS.filter((s) => d.meals?.[s.id]?.title);
    if (meals.length) {
      out += "| Meal | Dish |\n|---|---|\n" + meals.map((s) => `| ${cell(s.label)} | ${cell(d.meals[s.id].title)} |`).join("\n") + "\n\n";
    }
    if ((d.schedule || []).length) {
      out += "Schedule:\n" + [...d.schedule].sort((a, b) => String(a.time || "99").localeCompare(String(b.time || "99")))
        .map((s) => `- ${s.time ? s.time + " " : ""}${cell(s.text)}`).join("\n") + "\n\n";
    }
  }
  return out;
}

function shoppingMd(state, meta) {
  let out = header("Shopping list", meta);
  const items = state.shopping || [];
  if (!items.length) out += "The list is empty.\n\n";
  for (const [aisle, list] of groupByAisle(items)) {
    out += `## ${aisle}\n\n` + list.map((i) => `- [${i.bought ? "x" : " "}] ${cell(i.name)}${formatQty(i) ? ` (${formatQty(i)})` : ""}${i.store ? ` · ${cell(i.store)}` : ""}`).join("\n") + "\n\n";
  }
  return out;
}

function todoMd(state, meta) {
  let out = header("To do for the kids", meta);
  const todos = [...(state.todos || [])].sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
  if (!todos.length) out += "Nothing to do yet.\n\n";
  let date = "";
  for (const t of todos) {
    if (t.date !== date) { date = t.date; out += `\n## ${date}\n\n`; }
    out += `- [${t.done ? "x" : " "}] ${t.time ? t.time + " " : ""}${cell(t.text)} · ${WHO[t.who] || cell(t.who)}\n`;
  }
  return out + "\n";
}

function remindersMd(state, meta) {
  let out = header("Reminders", meta);
  const list = [...(state.reminders || [])].sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  if (!list.length) return out + "No reminders.\n\n";
  out += "| Date | Time | Reminder | Repeats | Done on |\n|---|---|---|---|---|\n";
  out += list.map((r) => `| ${r.date} | ${r.time || ""} | ${cell(r.title)}${r.notes ? ` (${cell(r.notes)})` : ""} | ${r.repeat && r.repeat !== "none" ? cell(r.repeat) : ""} | ${Object.keys(r.done || {}).sort().join(", ")} |`).join("\n");
  return out + "\n\n";
}

function kitchenMd(state, meta) {
  let out = header("In the kitchen", meta);
  const p = [...(state.pantry || [])].sort((a, b) => a.localeCompare(b));
  out += p.length ? p.map((x) => `- ${cell(x)}`).join("\n") + "\n\n" : "The kitchen list is empty.\n\n";
  out += `School is ${state.settings?.schoolNutFree ? "" : "not "}nut-free.\n\n`;
  return out;
}

function recipesMd(state, meta) {
  let out = header("Saved recipes", meta);
  const list = state.savedRecipes || [];
  if (!list.length) return out + "No saved recipes yet.\n\n";
  for (const r of list) {
    out += `## ${cell(r.title)}\n\n_For ${WHO[r.forWhom] || cell(r.forWhom || "family")}${r.prepMinutes ? `, ${r.prepMinutes} min` : ""}_\n\n`;
    if (r.ingredients?.length) out += r.ingredients.map((i) => `- ${cell(i.name)}${formatQty(i) ? ` (${formatQty(i)})` : ""}`).join("\n") + "\n\n";
    if (r.steps?.length) out += r.steps.map((s, n) => `${n + 1}. ${cell(s)}`).join("\n") + "\n\n";
  }
  return out;
}

const WRITERS = { "meal-plan.md": mealPlanMd, "shopping-list.md": shoppingMd, "todo.md": todoMd, "reminders.md": remindersMd, "kitchen.md": kitchenMd, "recipes.md": recipesMd };

// Counts used for the session log, so each check-in says what changed since the last one.
export function summarize(state) {
  const days = Object.values(state.days || {});
  return {
    mealsPlanned: days.reduce((n, d) => n + Object.values(d.meals || {}).filter((m) => m?.title).length, 0),
    daysApproved: days.filter((d) => d.status === "approved").length,
    shoppingItems: (state.shopping || []).length,
    bought: (state.shopping || []).filter((i) => i.bought).length,
    todos: (state.todos || []).length,
    todosDone: (state.todos || []).filter((t) => t.done).length,
    reminders: (state.reminders || []).length,
    kitchenItems: (state.pantry || []).length,
    savedRecipes: (state.savedRecipes || []).length,
  };
}

const SUMMARY_LABELS = {
  mealsPlanned: "Meals planned", daysApproved: "Days approved", shoppingItems: "Shopping items", bought: "Bought",
  todos: "To-dos", todosDone: "To-dos done", reminders: "Reminders", kitchenItems: "Kitchen items", savedRecipes: "Saved recipes",
};

export function sessionMd(state, prev, meta) {
  const now = summarize(state);
  const rows = Object.keys(SUMMARY_LABELS).map((k) => {
    const d = prev ? now[k] - (prev[k] || 0) : null;
    return `| ${SUMMARY_LABELS[k]} | ${now[k]} | ${d === null ? "" : d > 0 ? "+" + d : d} |`;
  });
  return `# Check-in ${meta.at}\n\n- By: ${meta.name || "someone"}\n- Device date: ${meta.today}\n${prev ? "" : "- First check-in from this device\n"}\n` +
    `| | Now | Change since last check-in |\n|---|---|---|\n${rows.join("\n")}\n\n` + dataBlock({ summary: now });
}

// All files for one check-in, keyed by path inside the output folder.
export function toMarkdownFiles(state, meta) {
  const files = {};
  for (const [file, keys] of Object.entries(FILES)) files[file] = WRITERS[file](state, meta) + dataBlock(pick(state, keys));
  const s = summarize(state);
  files[INDEX] = header("Family Meal Planner data", meta) +
    `This folder is the family's check-in record. The app saves to it with **Check in** and reads it back with **Load latest**.\n\n` +
    Object.keys(FILES).map((f) => `- [${f.replace(/\.md$/, "").replace(/-/g, " ")}](${f})`).join("\n") +
    `\n- [check-in sessions](sessions/)\n\n${s.mealsPlanned} meals planned, ${s.daysApproved} days approved, ${s.shoppingItems - s.bought} things to buy, ${s.todos - s.todosDone} to-dos open.\n\n` +
    dataBlock({ version: state.version || 1, updatedAt: state.updatedAt || null });
  return files;
}

// Back from files (path -> text) to app data. Missing or unreadable files are left out,
// so the app keeps its defaults for those parts.
export function fromMarkdownFiles(files) {
  const out = { version: 1 };
  const index = readDataBlock(files[INDEX]);
  if (index?.updatedAt) out.updatedAt = index.updatedAt;
  let found = 0;
  for (const [file, keys] of Object.entries(FILES)) {
    const data = readDataBlock(files[file]);
    if (!data) continue;
    found++;
    for (const k of keys) if (k in data) out[k] = data[k];
  }
  return found ? out : null;
}
