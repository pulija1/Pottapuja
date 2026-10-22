import { load, save, exportJson, importJson } from "./store.js";
import { todayKey, addDays, addMonths, monthGrid, monthLabel, prettyDate, fromKey, isDateKey, isSchoolDay, occurrences } from "./shared/dates.js";
import { checkRecipe, checkForAudience, isNutIngredient, isSchoolFood } from "./shared/safety.js";
import { LIBRARY, suggestFromLibrary } from "./shared/recipes.js";
import { mergeItems, groupByAisle, formatQty, missingFromPantry, normName, normUnit, aisleFor } from "./shared/shopping.js";
import { SLOTS, emptyDay, getDay, dayHasPlan, markEdited, approveDay, unapproveDay, slotsFor, todosOn, MEAL_GROUPS, TODO_IDEAS, remindersOn, pendingFor, dayStatus } from "./shared/plan.js";

const state = load();
let TODAY = todayKey();
const AI_TIMEOUT_MS = 50000;  // the server gives up at 40 s

const ui = {
  tab: "calendar",
  month: TODAY,
  selected: TODAY,
  ai: "unknown",          // live | mock | off | unreachable | unknown
  aiBusy: false,
  aiController: null,
  aiNotice: "",
  results: [],
  rejected: [],
  shopStore: "all",
  storeMode: false,
  hideBought: false,
  todoDate: addDays(TODAY, 1),   // the To do tab opens on tomorrow
  openGroups: new Set(),          // meal sections the parent has expanded in the day panel
  suggest: {},                    // date -> { seed, picks: { slotId: recipeId } } meal suggestions shown in the day panel
  savedFilter: "",
  gen: { forWhom: "both", mealType: "", notes: "" },
  confirmUnsafe: null,    // date whose unsafe plan the parent was warned about
  // recipe form values survive re-renders
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const WHO_LABEL = { baby: "Baby (8 mo)", kid: "4 yr old", family: "Family", both: "Both kids" };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function commit() {
  save(state);
  clearCaches();
  render();
}

// The calendar asks for pending items and reminders of 42 days on every render; cache them until data changes.
const pendCache = new Map();
const remCache = new Map();
// A change that only touches one date (its meals, schedule, to-dos or reminder ticks):
// drop that date's cached pending list and refresh just its part of the calendar.
function commitDay(key = ui.selected) {
  save(state);
  pendCache.delete(key);
  remCache.delete(key);
  for (const e of Object.values(ui.suggest)) e.picks = null;
  renderDay(key);
}

function clearCaches() {
  pendCache.clear();
  remCache.clear();
  for (const e of Object.values(ui.suggest)) e.picks = null;
}
function pend(key) {
  if (!pendCache.has(key)) pendCache.set(key, pendingFor(state, key, TODAY));
  return pendCache.get(key);
}
function remsOn(key) {
  if (!remCache.has(key)) remCache.set(key, remindersOn(state, key));
  return remCache.get(key);
}

// "Today" moves on at midnight even if the app stays open.
function refreshToday() {
  const now = todayKey();
  if (now === TODAY) return;
  if (ui.selected === TODAY) ui.selected = now;
  if (ui.month === TODAY) ui.month = now;
  TODAY = now;
  window.__mealPlanner.TODAY = now;
  clearCaches();
  render();
}

function ensureDay(key) {
  if (!state.days[key]) state.days[key] = emptyDay();
  return state.days[key];
}

function allRecipes() {
  const map = new Map();
  for (const r of [...ui.results, ...LIBRARY, ...state.savedRecipes]) map.set(r.id, r);
  return map;
}

function findRecipe(id) {
  return allRecipes().get(id) || null;
}

function findRecipeByTitle(title, who) {
  const t = String(title || "").trim().toLowerCase();
  if (!t) return null;
  const list = [...state.savedRecipes, ...LIBRARY, ...ui.results];
  return list.find((r) => r.title.toLowerCase() === t && (!who || r.forWhom === who || r.forWhom === "family")) ||
    list.find((r) => r.title.toLowerCase() === t) || null;
}

const nutFreeOn = () => !!state.settings?.schoolNutFree;

// Missing ingredients for a recipe, leaving nuts off the list for school food when the school is nut-free.
function shoppingNeeds(recipe) {
  const need = missingFromPantry(recipe, state.pantry);
  return nutFreeOn() && isSchoolFood(recipe) ? need.filter((i) => !isNutIngredient(i.name)) : need;
}

// Safety problems for each planned meal on a date, including dishes typed in by hand.
function slotIssues(key) {
  const day = getDay(state, key);
  const out = {};
  if (!day) return out;
  for (const s of slotsFor(key)) {
    const m = day.meals?.[s.id];
    if (!m?.title || s.who === "family") continue;
    const linked = m.recipeId ? findRecipe(m.recipeId) : null;
    const r = linked || { title: m.title, ingredients: [], steps: [] };
    const forBaby = s.who === "baby";
    const res = checkRecipe({ ...r, title: m.title }, {
      age: forBaby ? "baby" : "kid",
      lunchbox: s.id === "kid_lunchbox" || s.id === "kid_snack",
      schoolNutFree: nutFreeOn(),
      nutFreeSwap: r.nutFreeSwap,
    });
    if (res.errors.length) {
      const msgs = res.errors.map((e) => e.message);
      if (forBaby && linked && linked.forWhom !== "baby") msgs.push("This is not a baby recipe: take out a plain, mashed portion before salt and spice.");
      out[s.id] = { label: s.label, messages: [...new Set(msgs)] };
    }
  }
  return out;
}

function whoPill(who) {
  return `<span class="pill ${esc(who)}">${esc(WHO_LABEL[who] || who)}</span>`;
}

// ---------- AI status ----------
async function checkAi() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch("api/health", { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    ui.ai = data.ai || "off";
  } catch {
    ui.ai = "unreachable";
  }
  renderHeader();
  if (ui.tab === "recipes") render();
}

function aiOnline() {
  return ui.ai === "live" || ui.ai === "mock";
}

// ---------- header & tabs ----------
function renderHeader() {
  $("#today-label").textContent = "Today: " + fromKey(TODAY).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const chip = $("#ai-chip");
  const label = { live: "AI recipes on", mock: "AI: test mode", off: "AI off: using saved recipes", unreachable: "Offline: using saved recipes", unknown: "AI: checking…" }[ui.ai];
  chip.textContent = label;
  chip.className = "ai-chip " + (aiOnline() ? "on" : ui.ai === "unknown" ? "" : "off");
}

function setTab(tab) {
  ui.tab = tab;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + tab;
  try { history.replaceState(null, "", location.pathname + location.search + "#" + tab); } catch {}
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  renderHeader();
  const fn = { calendar: renderCalendar, recipes: renderRecipes, shopping: renderShopping, todo: renderTodo, reminders: renderReminders }[ui.tab];
  fn();
}

// ---------- calendar ----------
function calCell(c) {
  const st = dayStatus(state, c.key);
  const pending = pend(c.key);
  const rems = remsOn(c.key).length;
  const cls = ["cal-cell", c.inMonth ? "" : "out", c.key === TODAY ? "today" : "", c.key === ui.selected ? "sel" : ""].join(" ");
  const label = `${prettyDate(c.key)}: ${st === "approved" ? "approved" : st === "pending" ? "waiting for approval" : "no plan"}${pending.length ? ", " + pending.length + " pending" : ""}`;
  return `<button type="button" class="${cls}" data-action="select-day" data-date="${c.key}" data-testid="cal-day-${c.key}" data-status="${st}" data-pending="${pending.length}" aria-label="${esc(label)}">
    <span class="d">${c.day}</span>
    <span class="marks"><span class="dot ${st}"></span>${pending.length ? `<span class="badge" title="Pending">${pending.length}</span>` : ""}${rems ? `<span class="badge rem" title="Reminders">⏰${rems}</span>` : ""}</span>
  </button>`;
}

// Re-render only what one date can change: its cell, the pending card and the day panel.
// Rebuilding the whole month on every tick is slow on a phone with a year of data.
function renderDay(key = ui.selected) {
  if (ui.tab !== "calendar" || !$("#cal-day")) return render();
  renderHeader();
  const cell = $(`[data-testid=cal-day-${key}]`);
  if (cell) cell.outerHTML = calCell({ key, day: Number(key.slice(8)), inMonth: key.slice(0, 7) === ui.month.slice(0, 7) });
  $("#cal-upcoming").innerHTML = renderUpcomingPending();
  $("#cal-day").innerHTML = renderDayPanel(ui.selected);
}

function renderCalendar() {
  const cells = monthGrid(ui.month);
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const grid = cells.map(calCell).join("");

  $("#view-calendar").innerHTML = `
    <div class="cal-layout">
      <div>
        <div class="card">
          <div class="cal-head">
            <button class="btn sm" data-action="month" data-delta="-1" aria-label="Previous month" data-testid="cal-prev">‹</button>
            <h2 data-testid="cal-month">${esc(monthLabel(ui.month))}</h2>
            <div class="row">
              <button class="btn sm" data-action="goto-today" data-testid="cal-today">Today</button>
              <button class="btn sm" data-action="month" data-delta="1" aria-label="Next month" data-testid="cal-next">›</button>
            </div>
          </div>
          <div class="cal-grid" data-testid="cal-grid">
            ${dows.map((d) => `<div class="cal-dow">${d}</div>`).join("")}
            ${grid}
          </div>
          <div class="legend">
            <span><i class="dot approved"></i>Approved</span>
            <span><i class="dot pending"></i>Waiting for approval</span>
            <span><i class="dot empty"></i>No plan</span>
            <span><b class="badge">2</b>Pending items</span>
          </div>
        </div>
        <div id="cal-upcoming">${renderUpcomingPending()}</div>
        ${renderBackupCard()}
      </div>
      <div id="cal-day">${renderDayPanel(ui.selected)}</div>
    </div>`;
}

function renderUpcomingPending() {
  const rows = [];
  for (let i = -7; i <= 13; i++) {
    const k = addDays(TODAY, i);
    const p = pend(k);
    if (p.length) rows.push({ k, p });
  }
  if (!rows.length) return `<div class="card"><h2>Pending</h2><p class="muted">Nothing pending in the next two weeks.</p></div>`;
  return `<div class="card" data-testid="upcoming-pending"><h2>Pending, next two weeks</h2>
    ${rows.map(({ k, p }) => `<div class="row between" style="padding:6px 0;border-bottom:1px dashed var(--line)">
      <button class="btn ghost sm" data-action="select-day" data-date="${k}">${k < TODAY ? "⚠️ " : ""}${esc(prettyDate(k))}${k === TODAY ? " (today)" : ""}</button>
      <span class="small muted grow" style="text-align:right">${p.map((x) => esc(x.text)).join(" · ")}</span>
    </div>`).join("")}
  </div>`;
}

function renderBackupCard() {
  return `<div class="card"><h2>Backup</h2>
    <p class="small muted">Everything is saved on this device. Download a backup to move it to another phone or browser.</p>
    <div class="row">
      <button class="btn sm" data-action="export" data-testid="export">Download backup</button>
      <label class="btn sm">Restore backup<input type="file" accept="application/json" data-action="import" hidden data-testid="import"></label>
    </div></div>`;
}

function slotDatalist(who) {
  const list = [...state.savedRecipes, ...LIBRARY].filter((r) => r.forWhom === who || r.forWhom === "family" || (who === "family"));
  const seen = new Set();
  return list.filter((r) => !seen.has(r.title) && seen.add(r.title)).map((r) => `<option value="${esc(r.title)}">`).join("");
}

// Suggested meals for the empty slots of a date, built from what's in the kitchen.
// Picks are safety-checked for the slot, avoid repeating the day before, and rotate with `seed`.
function suggestionsFor(key) {
  const day = getDay(state, key) || emptyDay();
  const entry = ui.suggest[key] || (ui.suggest[key] = { seed: 0, offsets: {}, picks: null });
  if (entry.picks) return entry.picks;
  const prev = getDay(state, addDays(key, -1));
  const avoid = new Set(Object.values(prev?.meals || {}).map((m) => m?.recipeId).filter(Boolean));
  const used = new Set(Object.values(day.meals || {}).map((m) => m?.recipeId).filter(Boolean));
  const picks = {};
  for (const s of slotsFor(key)) {
    if (day.meals?.[s.id]?.title) continue;
    const meal = s.id.split("_")[1];
    const opt = { forWhom: s.who, schoolNutFree: nutFreeOn(), limit: 40 };
    const seen = new Set();
    const candidates = suggestFromLibrary(state.pantry, { ...opt, mealType: meal })
      .concat(suggestFromLibrary(state.pantry, opt))
      .filter((r) => r.forWhom === s.who && !seen.has(r.id) && seen.add(r.id))
      .filter((r) => checkRecipe(r, { age: s.who === "baby" ? "baby" : "kid", lunchbox: s.id === "kid_lunchbox" || s.id === "kid_snack", schoolNutFree: nutFreeOn() }).safe);
    const fresh = candidates.filter((r) => !used.has(r.id) && !avoid.has(r.id));
    const pool = (fresh.length ? fresh : candidates).slice(0, 6);
    if (!pool.length) continue;
    const r = pool[(entry.seed + (entry.offsets[s.id] || 0)) % pool.length];
    picks[s.id] = r.id;
    used.add(r.id);
  }
  entry.picks = picks;
  return picks;
}

function applySuggestions(key) {
  const d = ensureDay(key);
  let n = 0;
  for (const [slot, id] of Object.entries(suggestionsFor(key))) {
    const r = findRecipe(id);
    if (!r || d.meals[slot]?.title) continue;
    d.meals[slot] = { recipeId: r.id, title: r.title, forWhom: r.forWhom };
    n++;
  }
  if (n) markEdited(d);
  delete ui.suggest[key];
  return n;
}

function renderSuggestions(key) {
  if (key < TODAY) return "";
  const picks = suggestionsFor(key);
  const rows = MEAL_GROUPS.flatMap((g) => slotsFor(key).filter((s) => s.who === g.who && picks[s.id]));
  if (!rows.length) return "";
  return `<div class="suggest" data-testid="day-suggestions">
    <div class="row between"><strong>💡 Suggested from your kitchen</strong>
      <button type="button" class="btn sm ghost" data-action="suggest-shuffle" data-testid="suggest-shuffle">🔀 Other ideas</button></div>
    ${rows.map((s) => {
      const r = findRecipe(picks[s.id]);
      const need = shoppingNeeds(r);
      return `<div class="suggest-row" data-testid="suggestion" data-slot="${s.id}">
        <span class="small muted">${esc(s.label)}</span>
        <span class="grow">${esc(r.title)}${r.familyFavorite ? " ⭐" : ""}${need.length ? ` <span class="small" style="color:var(--warn)">· need ${esc(need.map((i) => i.name).join(", "))}</span>` : ' <span class="small" style="color:var(--ok)">· all in the kitchen</span>'}</span>
        <button type="button" class="iconbtn" data-action="suggest-swap" data-slot="${s.id}" title="Another idea" aria-label="Another idea for ${esc(s.label)}">🔀</button>
      </div>`;
    }).join("")}
    <div class="row" style="margin-top:8px">
      <button class="btn ok sm" data-action="suggest-approve" data-testid="suggest-approve">✅ Approve these meals</button>
      <button class="btn sm" data-action="autofill" data-testid="autofill-day">Add to plan, approve later</button>
    </div>
  </div>`;
}

function slotRow(s, day, issues) {
  const m = day.meals?.[s.id];
  const r = m?.recipeId ? findRecipe(m.recipeId) : null;
  return `<div class="slot">
    <span class="slot-label">${esc(s.label)}</span>
    <div class="slot-row">
      <input type="text" list="dl-${s.who}" value="${esc(m?.title || "")}" placeholder="Pick a recipe or type a dish" data-action="slot" data-slot="${s.id}" data-who="${s.who}" data-testid="slot-${s.id}" aria-label="${esc(s.label)}">
      ${r ? `<button class="iconbtn" data-action="view-recipe" data-id="${esc(r.id)}" title="View recipe" aria-label="View recipe">📖</button>` : ""}
      ${m?.title ? `<button class="iconbtn" data-action="clear-slot" data-slot="${s.id}" title="Clear" aria-label="Clear ${esc(s.label)}">✕</button>` : ""}
    </div>
    ${issues[s.id] ? `<span class="small" style="color:var(--bad)" data-testid="slot-warning">⛔ ${esc(issues[s.id].messages[0])}</span>` : ""}
  </div>`;
}

function todoRow(t, { showDate = false } = {}) {
  return `<div class="chk todo ${t.done ? "done" : ""}" data-testid="todo-item">
    <input type="checkbox" data-action="todo-toggle" data-id="${esc(t.id)}" ${t.done ? "checked" : ""} aria-label="Done: ${esc(t.text)}">
    <span class="txt grow">${t.time ? `<strong>${esc(t.time)}</strong> ` : ""}${esc(t.text)}${showDate ? ` <span class="small muted">· ${esc(prettyDate(t.date))}</span>` : ""}</span>
    ${whoPill(t.who)}
    <button type="button" class="iconbtn" data-action="todo-del" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.text)}">✕</button>
  </div>`;
}

const WHO_OPTIONS = (sel = "kid") => [["kid", "4-year-old"], ["baby", "Baby"], ["family", "Family"]]
  .map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");

function renderDayPanel(key) {
  const day = getDay(state, key) || emptyDay();
  const st = dayStatus(state, key);
  const pendList = pend(key);
  const slots = slotsFor(key);
  const hasPlan = dayHasPlan(day);
  const todos = todosOn(state, key);
  const rems = remsOn(key);
  const issues = slotIssues(key);
  const issueList = Object.values(issues);

  const safetyBox = issueList.length && st !== "approved" ? `<div class="notice" data-testid="day-safety" style="margin-top:8px">
      ⛔ <strong>Safety check:</strong> ${issueList.map((i) => `${esc(i.label)}: ${esc(i.messages.join(" "))}`).join("<br>")}
      ${ui.confirmUnsafe === key ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-action="approve-anyway" data-testid="approve-anyway">Approve anyway</button><button class="btn sm ghost" data-action="cancel-approve">Go back and change it</button></div>` : ""}
    </div>` : "";

  const banner = st === "approved"
    ? `<div class="status-banner approved" data-testid="day-status" data-status="approved"><span>✅ Approved${day.approvedAt ? " " + esc(new Date(day.approvedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) : ""}</span>
        <button class="btn sm" data-action="unapprove" data-testid="unapprove-day">Undo approval</button></div>`
    : st === "pending"
      ? `<div class="status-banner pending" data-testid="day-status" data-status="pending"><span>⏳ ${day.changedAfterApproval ? "Changed after approval" : "Waiting for your approval"}</span>
          <button class="btn ok" data-action="approve" data-testid="approve-day">Approve day</button></div>`
      : `<div class="status-banner empty" data-testid="day-status" data-status="empty"><span>No meals or schedule yet</span></div>`;

  return `<div class="card" data-testid="day-panel" data-date="${key}">
    <div class="row between"><h2>${esc(fromKey(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}${key === TODAY ? " · Today" : ""}</h2>
      ${isSchoolDay(key) ? '<span class="pill kid">School day</span>' : '<span class="pill">Weekend</span>'}</div>
    ${banner}
    ${safetyBox}
    ${pendList.length ? `<h3>Pending for this date</h3><ul class="pending-list" data-testid="day-pending">${pendList.map((p) => `<li data-type="${p.type}">${{ approval: "⏳", plan: "📝", reminder: "⏰", todo: "✅" }[p.type]} ${esc(p.text)}${p.overdue ? ' <span class="pill bad">overdue</span>' : ""}</li>`).join("")}</ul>` : `<p class="small muted" data-testid="day-pending-none">Nothing pending for this date.</p>`}

    <h3>Meals</h3>
    ${renderSuggestions(key)}
    <div data-testid="day-meals">
    ${MEAL_GROUPS.map((g) => {
      const groupSlots = slots.filter((s) => s.who === g.who);
      const planned = groupSlots.filter((s) => day.meals?.[s.id]?.title).length;
      const hasIssue = groupSlots.some((s) => issues[s.id]);
      const open = ui.openGroups.has(g.who) || hasIssue;
      return `<details class="meal-group" data-group="${g.who}" data-testid="meal-group-${g.who}" ${open ? "open" : ""}>
        <summary><span class="grow"><strong>${g.icon} ${esc(g.label)}</strong></span>
          <span class="small ${hasIssue ? "" : "muted"}" ${hasIssue ? 'style="color:var(--bad)"' : ""}>${hasIssue ? "⛔ check safety · " : ""}${planned} of ${groupSlots.length} planned</span></summary>
        ${groupSlots.map((s) => slotRow(s, day, issues)).join("")}
      </details>`;
    }).join("")}
    </div>
    <datalist id="dl-baby">${slotDatalist("baby")}</datalist>
    <datalist id="dl-kid">${slotDatalist("kid")}</datalist>
    <datalist id="dl-family">${slotDatalist("family")}</datalist>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" data-action="copy-prev" data-testid="copy-prev">Copy previous day</button>
      <button class="btn sm" data-action="day-to-shopping" data-testid="day-to-shopping">🛒 Add missing to shopping</button>
    </div>

    <h3>Schedule</h3>
    <div data-testid="day-schedule">
      ${(day.schedule || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time))).map((s) => `<div class="sched-item"><time>${esc(s.time || "--:--")}</time><span class="grow">${esc(s.text)}</span><button class="iconbtn" data-action="del-sched" data-id="${esc(s.id)}" aria-label="Remove">✕</button></div>`).join("") || '<p class="small muted">No schedule yet.</p>'}
    </div>
    <form class="row" data-form="add-sched" style="margin-top:6px">
      <input type="time" name="time" style="width:120px" aria-label="Time" data-testid="sched-time">
      <input type="text" name="text" class="grow" placeholder="e.g. School drop-off, nap, swim class" aria-label="Schedule item" data-testid="sched-text" required>
      <button class="btn sm primary" data-testid="sched-add">Add</button>
    </form>
    ${isSchoolDay(key) ? `<p class="small muted" style="margin-top:6px"><button type="button" class="btn ghost sm" data-action="school-schedule">+ Add usual school-day times</button></p>` : ""}

    <h3>To do</h3>
    <div data-testid="day-todos">${todos.length ? todos.map((t) => todoRow(t)).join("") : '<p class="small muted">Nothing to do for the kids on this date.</p>'}</div>
    <form class="row" data-form="todo-add-day" style="margin-top:6px">
      <input type="text" name="text" class="grow" placeholder="e.g. Buy dresses, check school schedule" aria-label="New to-do" required data-testid="day-todo-input">
      <select name="who" style="width:120px" aria-label="For">${WHO_OPTIONS()}</select>
      <button class="btn sm primary" data-testid="day-todo-add">Add</button>
    </form>

    <h3>Reminders</h3>
    ${rems.length ? rems.map((r) => `<label class="chk ${r.doneOnDate ? "done" : ""}"><input type="checkbox" data-action="rem-done" data-id="${esc(r.id)}" data-date="${key}" ${r.doneOnDate ? "checked" : ""}><span class="txt">${esc(r.time || "")} ${esc(r.title)}</span></label>`).join("") : '<p class="small muted">No reminders.</p>'}
    <button class="btn sm" data-action="new-reminder" data-date="${key}">+ Reminder on this date</button>
  </div>`;
}

// ---------- recipes ----------
const STAPLES = ["rice", "moong dal", "toor dal", "urad dal", "ragi flour", "rava", "curd", "ghee", "milk", "egg", "banana", "apple", "carrot", "potato", "sweet potato", "tomato", "onion", "beans", "peas", "pumpkin", "spinach", "lemon", "idli/dosa batter", "vermicelli", "atta", "coconut", "curry leaves", "mustard seeds", "jeera", "turmeric", "tamarind"];

function renderRecipes() {
  const pantrySet = new Set(state.pantry.map(normName));
  const suggestions = STAPLES.filter((s) => !pantrySet.has(normName(s)));
  const filt = ui.savedFilter.trim().toLowerCase();
  const saved = state.savedRecipes.filter((r) => !filt || r.title.toLowerCase().includes(filt));

  $("#view-recipes").innerHTML = `
    <div class="card">
      <h2>What's in the kitchen</h2>
      <div class="chips" data-testid="pantry-list">
        ${state.pantry.map((p) => `<span class="chip" data-testid="pantry-item">${esc(p)}<button data-action="pantry-del" data-name="${esc(p)}" aria-label="Remove ${esc(p)}">✕</button></span>`).join("") || '<span class="muted small">Add what you have at home.</span>'}
      </div>
      <form class="row" data-form="pantry-add" style="margin-top:10px">
        <input type="text" name="items" class="grow" placeholder="Add items, comma separated (e.g. drumstick, paneer)" aria-label="Add pantry items" data-testid="pantry-input">
        <button class="btn primary" data-testid="pantry-add">Add</button>
      </form>
      ${suggestions.length ? `<details style="margin-top:8px"><summary>Quick add common items</summary><div class="chips" style="margin-top:8px">${suggestions.map((s) => `<button class="chip add" data-action="pantry-quick" data-name="${esc(s)}">+ ${esc(s)}</button>`).join("")}</div></details>` : ""}
    </div>

    <div class="card">
      <h2>Make recipes from these ingredients</h2>
      <form data-form="generate" class="form-grid">
        <label class="field"><span>For</span>
          <select name="forWhom" data-testid="gen-for" data-action="gen-field">
            ${[["both", "Both kids"], ["baby", "Baby (8 months)"], ["kid", "4-year-old"], ["family", "Whole family"]].map(([v, l]) => `<option value="${v}" ${ui.gen.forWhom === v ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <label class="field"><span>Meal</span>
          <select name="mealType" data-testid="gen-meal" data-action="gen-field">
            ${[["", "Any"], ["breakfast", "Breakfast"], ["lunchbox", "School lunchbox"], ["lunch", "Lunch"], ["snack", "Snack"], ["dinner", "Dinner"]].map(([v, l]) => `<option value="${v}" ${ui.gen.mealType === v ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <label class="chk full" style="min-height:0"><input type="checkbox" data-action="nut-free" ${nutFreeOn() ? "checked" : ""} data-testid="school-nut-free"> School is nut-free (no peanuts or tree nuts in the lunchbox or snack box)</label>
        <label class="field full"><span>Anything else? (optional)</span>
          <input type="text" name="notes" maxlength="300" value="${esc(ui.gen.notes)}" placeholder="e.g. baby just started eggs, no onion today" data-testid="gen-notes" data-action="gen-field"></label>
        <div class="full row">
          <button class="btn primary" data-testid="generate-recipes" ${ui.aiBusy ? "disabled" : ""}>${aiOnline() ? "✨ Get recipes" : "Find recipes"}</button>
          ${ui.aiBusy ? `<span class="spinner" aria-hidden="true"></span><span class="small muted">Asking the AI… this can take up to a minute</span><button type="button" class="btn sm" data-action="cancel-ai" data-testid="cancel-ai">Cancel</button>` : ""}
        </div>
      </form>
      <p class="small muted" style="margin-top:8px">Every recipe is checked for age safety: no honey, salt, sugar or whole nuts for the baby, soft textures only, chopped (not whole) nuts for the 4-year-old, and nut-free lunchboxes when the school is nut-free.</p>
    </div>

    <div data-testid="recipe-results">
      ${ui.aiNotice ? `<div class="notice" data-testid="ai-notice">${esc(ui.aiNotice)}</div>` : ""}
      ${ui.rejected.length ? `<div class="notice info small" data-testid="rejected-notice">Removed ${ui.rejected.length} AI suggestion${ui.rejected.length > 1 ? "s" : ""} that failed the age-safety check: ${ui.rejected.map((r) => esc(r.title) + " (" + esc(r.errors.map((e) => e.rule).join(", ")) + ")").join("; ")}</div>` : ""}
      <div class="recipe-grid">${ui.results.map((r) => recipeCard(r)).join("")}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="row between"><h2>Saved recipes (${state.savedRecipes.length})</h2>
        <input type="text" placeholder="Search saved" value="${esc(ui.savedFilter)}" data-action="saved-filter" style="max-width:220px" aria-label="Search saved recipes"></div>
      <div class="recipe-grid" data-testid="saved-recipes" style="margin-top:8px">${saved.map((r) => recipeCard(r, { saved: true })).join("") || '<p class="muted small">Save recipes you like and they will work even when offline.</p>'}</div>
    </div>`;
}

function recipeCard(r, { saved = false } = {}) {
  const safety = checkForAudience(r, { schoolNutFree: nutFreeOn() });
  const missing = new Set(shoppingNeeds(r).map((i) => normName(i.name)));
  const hasNuts = r.nutFree === false || r.ingredients.some((i) => isNutIngredient(i.name));
  const isSaved = state.savedRecipes.some((s) => s.id === r.id || s.title === r.title);
  const issues = [...safety.errors, ...safety.warnings];
  return `<article class="card recipe" data-testid="recipe-card" data-recipe-id="${esc(r.id)}" data-safe="${safety.safe}">
    <div class="row between"><h3>${esc(r.title)}</h3><span>${r.familyFavorite ? '<span class="pill warn" data-testid="family-favorite">⭐ Family favorite</span> ' : ""}${whoPill(r.forWhom)}</span></div>
    ${hasNuts && !nutFreeOn() ? `<div class="small muted" data-testid="contains-nuts">🥜 Contains nuts${r.nutFreeSwap ? ". Nut-free swap: " + esc(r.nutFreeSwap) : ""}</div>` : ""}
    <div class="small muted">${esc(r.mealType || "")}${r.prepMinutes ? " · " + esc(r.prepMinutes) + " min" : ""}${r.texture ? " · " + esc(r.texture) : ""}${r.source === "ai" ? " · ✨ AI" : r.source === "library" ? " · Family recipe book" : ""}</div>
    <div class="safety ${safety.safe && !safety.warnings.length ? "ok" : safety.safe ? "warn" : "warn"}" data-testid="safety-badge">
      ${safety.safe ? (safety.warnings.length ? "⚠️ Safe with care" : "✅ Age-safe") : "⛔ Not safe as written"}
      ${issues.length ? `<ul>${issues.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul>` : ""}
    </div>
    <details><summary>Ingredients (${r.ingredients.length})${missing.size ? ` · ${missing.size} to buy` : ""}</summary>
      <ul>${r.ingredients.map((i) => `<li class="${missing.has(normName(i.name)) ? "missing" : ""}">${esc(i.name)} ${i.quantity != null ? `<span class="muted">${esc(i.quantity)} ${esc(i.unit || "")}</span>` : ""}${missing.has(normName(i.name)) ? " (need)" : ""}</li>`).join("")}</ul>
    </details>
    <details><summary>Steps</summary><ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ""}</details>
    <div class="actions">
      ${saved ? `<button class="btn sm danger" data-action="unsave" data-id="${esc(r.id)}">Remove</button>` : isSaved ? '<span class="pill ok">Saved</span>' : `<button class="btn sm" data-action="save-recipe" data-id="${esc(r.id)}" data-testid="save-recipe">⭐ Save</button>`}
      <button class="btn sm" data-action="plan-recipe" data-id="${esc(r.id)}" data-testid="plan-recipe">📅 Plan</button>
      ${missing.size ? `<button class="btn sm" data-action="recipe-to-shopping" data-id="${esc(r.id)}" data-testid="recipe-to-shopping">🛒 Add ${missing.size} to list</button>` : ""}
    </div>
  </article>`;
}

async function generate(form) {
  ui.gen = { forWhom: form.forWhom.value, mealType: form.mealType.value, notes: form.notes.value };
  const body = {
    ingredients: state.pantry,
    forWhom: form.forWhom.value,
    mealType: form.mealType.value,
    notes: form.notes.value,
    count: 4,
    schoolNutFree: nutFreeOn(),
  };
  ui.aiNotice = "";
  ui.rejected = [];
  const fallback = (why) => {
    ui.results = suggestFromLibrary(state.pantry, { forWhom: body.forWhom, mealType: body.mealType, limit: 6, schoolNutFree: body.schoolNutFree });
    ui.aiNotice = `${why} Showing recipes from the built-in family recipe book that best match your kitchen.`;
  };
  if (!aiOnline()) {
    fallback(ui.ai === "off" ? "The recipe AI is turned off." : "The recipe AI can't be reached right now.");
    render();
    return;
  }
  ui.aiBusy = true;
  ui.aiController = new AbortController();
  const timer = setTimeout(() => ui.aiController?.abort("timeout"), AI_TIMEOUT_MS);
  render();
  const started = performance.now();
  try {
    const res = await fetch("api/recipes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ui.aiController.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      fallback((data.error || "The recipe AI is unavailable.") + "");
    } else {
      ui.results = data.recipes || [];
      ui.rejected = data.rejected || [];
      if (!ui.results.length) fallback("The AI didn't return any recipes that passed the safety check.");
      console.info(`[recipes] ${ui.results.length} recipes in ${Math.round(performance.now() - started)} ms`);
    }
  } catch (err) {
    const reason = ui.aiController?.signal.reason;
    if (reason === "cancel") ui.aiNotice = "Cancelled.";
    else fallback(reason === "timeout" ? "The recipe AI took too long." : "Couldn't reach the recipe AI.");
  } finally {
    clearTimeout(timer);
    ui.aiBusy = false;
    ui.aiController = null;
    render();
  }
}

// Items can carry a `key` (date|slot|recipe|ingredient). An item whose key is already on the
// list and not yet bought is skipped, so pressing "add" twice doesn't double the quantities.
// Returns how many items were added.
function addToShopping(items, source) {
  const onList = new Set(state.shopping.filter((i) => !i.bought).flatMap((i) => i.keys || []));
  const fresh = items
    .filter((i) => !i.key || !onList.has(i.key))
    .map((i) => ({ id: uid(), name: i.name, quantity: i.quantity ?? null, unit: normUnit(i.unit), store: i.store || "", bought: false, source: i.source || source, keys: i.key ? [i.key] : [] }));
  state.shopping = mergeItems([...state.shopping, ...fresh]).map((i) => ({ ...i, id: i.id || uid() }));
  return fresh.length;
}

function planDialog(recipe) {
  const dlg = document.createElement("dialog");
  const slots = SLOTS.filter((s) => recipe.forWhom === "family" ? true : s.who === recipe.forWhom || s.who === "family");
  dlg.innerHTML = `<form method="dialog" class="stack">
    <h2>Plan “${esc(recipe.title)}”</h2>
    <label class="field"><span>Date</span><input type="date" name="date" value="${ui.selected >= TODAY ? ui.selected : TODAY}" required data-testid="plan-date"></label>
    <label class="field"><span>Meal</span><select name="slot" data-testid="plan-slot">${slots.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}</select></label>
    <div class="row"><button class="btn primary" value="ok" data-testid="plan-confirm">Add to plan</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "ok") {
      const f = dlg.querySelector("form");
      const date = f.date.value;
      if (isDateKey(date)) {
        if (!state.savedRecipes.some((s) => s.id === recipe.id) && !recipe.id.startsWith("lib-")) state.savedRecipes.push(recipe);
        const day = ensureDay(date);
        day.meals[f.slot.value] = { recipeId: recipe.id, title: recipe.title, forWhom: recipe.forWhom };
        markEdited(day);
        commit();
        toast(`Planned for ${prettyDate(date)}. Approve it on the calendar.`);
      }
    }
    dlg.remove();
  });
  dlg.showModal();
}

function recipeDialog(r) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<div class="stack">${recipeCard(r).replace('class="card recipe"', 'class="recipe"')}<form method="dialog"><button class="btn">Close</button></form></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

// ---------- shopping ----------
function renderShopping() {
  const items = state.shopping.filter((i) => (ui.shopStore === "all" || (i.store || "") === ui.shopStore || (ui.shopStore === "" && !i.store)) && (!ui.hideBought || !i.bought));
  const groups = groupByAisle(items);
  const left = state.shopping.filter((i) => !i.bought).length;

  $("#view-shopping").innerHTML = `
    <div class="card ${ui.storeMode ? "store-mode" : ""}">
      <div class="row between">
        <h2>Shopping list <span class="pill" data-testid="shop-left">${left} to buy</span></h2>
        <button class="btn sm ${ui.storeMode ? "primary" : ""}" data-action="store-mode" aria-pressed="${ui.storeMode}" data-testid="store-mode">${ui.storeMode ? "🛒 In store mode" : "🛒 I'm at the store"}</button>
      </div>
      ${ui.storeMode ? "" : `<form data-form="shop-add" class="row" style="margin:10px 0">
        <input type="text" name="name" class="grow" placeholder="Item (e.g. toor dal)" required aria-label="Item" data-testid="shop-name">
        <input type="number" name="qty" min="0" step="any" placeholder="Qty" style="width:80px" aria-label="Quantity" data-testid="shop-qty">
        <select name="unit" style="width:90px" aria-label="Unit" data-testid="shop-unit"><option value="">unit</option>${["g", "kg", "ml", "l", "pcs", "packet", "bunch", "dozen"].map((u) => `<option>${u}</option>`).join("")}</select>
        <select name="store" style="width:150px" aria-label="Store" data-testid="shop-store"><option value="">Any store</option>${state.stores.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        <button class="btn primary" data-testid="shop-add">Add</button>
      </form>`}
      <div class="row" style="margin:8px 0">
        <div class="seg" role="group" aria-label="Store filter" data-testid="store-filter">
          <button data-action="shop-store" data-store="all" aria-pressed="${ui.shopStore === "all"}">All</button>
          ${state.stores.map((s) => `<button data-action="shop-store" data-store="${esc(s)}" aria-pressed="${ui.shopStore === s}">${esc(s)}</button>`).join("")}
        </div>
        <label class="chk small" style="min-height:0"><input type="checkbox" data-action="hide-bought" ${ui.hideBought ? "checked" : ""} data-testid="hide-bought"> Hide bought</label>
      </div>
      <div data-testid="shop-list">
      ${groups.length ? groups.map(([aisle, list]) => `<div class="aisle"><h3>${esc(aisle)}</h3>${list.map((i) => `
        <div class="shop-item ${i.bought ? "bought" : ""}" data-testid="shop-item" data-name="${esc(i.name)}">
          <label><input type="checkbox" data-action="shop-toggle" data-id="${esc(i.id)}" ${i.bought ? "checked" : ""}><span class="name">${esc(i.name)}</span></label>
          <span class="qty" data-testid="shop-qty-label">${esc(formatQty(i))}</span>
          ${i.store ? `<span class="pill store">${esc(i.store)}</span>` : ""}
          ${ui.storeMode ? "" : `<button class="iconbtn" data-action="shop-del" data-id="${esc(i.id)}" aria-label="Delete ${esc(i.name)}">✕</button>`}
        </div>`).join("")}</div>`).join("") : '<p class="empty-state">The list is empty. Add items, or pull them from your meal plan.</p>'}
      </div>
    </div>
    ${ui.storeMode ? "" : `<div class="card">
      <h2>Fill the list</h2>
      <div class="row">
        <button class="btn" data-action="plan-to-shopping" data-testid="plan-to-shopping">From next 7 days of meals</button>
        <button class="btn" data-action="copy-list" data-testid="copy-list">Copy list as text</button>
        <button class="btn danger" data-action="clear-bought" data-testid="clear-bought">Clear bought</button>
      </div>
      <details style="margin-top:10px"><summary>Stores</summary>
        <div class="chips" style="margin-top:8px">${state.stores.map((s) => `<span class="chip">${esc(s)}<button data-action="store-del" data-store="${esc(s)}" aria-label="Remove ${esc(s)}">✕</button></span>`).join("")}</div>
        <form data-form="store-add" class="row" style="margin-top:8px"><input type="text" name="store" class="grow" placeholder="Add a store" required><button class="btn sm">Add</button></form>
      </details>
    </div>`}`;
}

function plannedRecipes(fromKey_, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const k = addDays(fromKey_, i);
    const d = getDay(state, k);
    if (!d) continue;
    for (const [slot, m] of Object.entries(d.meals || {})) {
      const r = m?.recipeId ? findRecipe(m.recipeId) : findRecipeByTitle(m?.title);
      if (r) out.push({ date: k, slot, recipe: r });
    }
  }
  return out;
}

// ---------- to do ----------
function renderTodo() {
  const key = ui.todoDate;
  const list = todosOn(state, key);
  const left = list.filter((t) => !t.done).length;
  const soon = (state.todos || [])
    .filter((t) => !t.done && t.date >= TODAY && t.date <= addDays(TODAY, 7) && t.date !== key)
    .sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
  // Newest missed first; only the last two weeks unless asked, since a long list is slow and unread.
  const allMissed = (state.todos || []).filter((t) => !t.done && t.date < TODAY).sort((a, b) => b.date.localeCompare(a.date));
  const missed = ui.showOlderMissed ? allMissed : allMissed.filter((t) => t.date >= addDays(TODAY, -14));
  const older = allMissed.length - missed.length;
  const dayName = key === TODAY ? "Today" : key === addDays(TODAY, 1) ? "Tomorrow" : prettyDate(key);
  $("#view-todo").innerHTML = `
    <div class="card">
      <div class="row between">
        <button class="btn sm" data-action="todo-day" data-delta="-1" aria-label="Previous day">‹</button>
        <input type="date" value="${key}" data-action="todo-date" style="max-width:180px" aria-label="Date" data-testid="todo-date">
        <button class="btn sm" data-action="todo-day" data-delta="1" aria-label="Next day">›</button>
      </div>
      <div class="row between" style="margin-top:10px"><h2 style="margin:0">To do: ${esc(dayName)}</h2><span class="pill ${left ? "warn" : "ok"}" data-testid="todo-left">${left ? `${left} left` : list.length ? "All done" : "Nothing yet"}</span></div>
      <div data-testid="todo-list" style="margin-top:6px">${list.length ? list.map((t) => todoRow(t)).join("") : '<p class="empty-state">Nothing planned for the kids on this day. Add something below or tap an idea.</p>'}</div>
      <form data-form="todo-add" class="form-grid" style="margin-top:10px">
        <label class="field full"><span>What needs doing</span><input type="text" name="text" required maxlength="120" placeholder="e.g. Buy dresses for the school function" data-testid="todo-input"></label>
        <label class="field"><span>For</span><select name="who" data-testid="todo-who">${WHO_OPTIONS()}</select></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${key}" required data-testid="todo-input-date"></label>
        <label class="field"><span>Time (optional)</span><input type="time" name="time"></label>
        <div class="field" style="justify-content:flex-end"><button class="btn primary" data-testid="todo-add">Add to do</button></div>
      </form>
      <h3>Quick ideas for ${esc(dayName.toLowerCase() === "today" || dayName.toLowerCase() === "tomorrow" ? dayName.toLowerCase() : prettyDate(key))}</h3>
      <div class="chips">${TODO_IDEAS.map((i) => `<button class="chip add" data-action="todo-idea" data-text="${esc(i.text)}" data-who="${i.who}" data-testid="todo-idea">+ ${esc(i.text)}</button>`).join("")}</div>
    </div>
    ${allMissed.length ? `<div class="card" data-testid="todo-missed"><h2>⚠️ Not done yet</h2>${missed.map((t) => todoRow(t, { showDate: true })).join("")}
      ${older ? `<button class="btn ghost sm" data-action="todo-older" data-testid="todo-older">Show ${older} older</button>` : ""}</div>` : ""}
    <div class="card" data-testid="todo-upcoming"><h2>Coming up this week</h2>
      ${soon.length ? soon.map((t) => todoRow(t, { showDate: true })).join("") : '<p class="small muted">Nothing else in the next 7 days.</p>'}
    </div>`;
}

// ---------- reminders ----------
const CATS = { school: "🏫 School", health: "🩺 Doctor / vaccine", family: "🎉 Family event", shopping: "🛒 Shopping", other: "📌 Other" };

function renderReminders(prefillDate) {
  // One row per reminder: a one-off shows its date; a repeating one shows its next date
  // (today's if it is not done yet). Missed: one-offs in the last 14 days that were not ticked.
  const occ = [];
  const overdue = [];
  for (const r of state.reminders) {
    if (!r.repeat || r.repeat === "none") {
      const o = { r, d: r.date, done: !!r.done?.[r.date] };
      if (r.date < TODAY) { if (!o.done && r.date >= addDays(TODAY, -14)) overdue.push(o); }
      else occ.push(o);
      continue;
    }
    const next = occurrences(r, TODAY, addDays(TODAY, 62)).find((d) => d > TODAY || !r.done?.[d]);
    if (next) occ.push({ r, d: next, done: false });
  }
  const byDate = (a, b) => (a.d + (a.r.time || "99")).localeCompare(b.d + (b.r.time || "99"));
  occ.sort(byDate);
  overdue.sort(byDate);
  const upcoming = occ;
  const row = (o) => `<div class="rem ${o.done ? "done" : ""} ${o.d < TODAY && !o.done ? "overdue" : ""}" data-testid="reminder-item">
      <input type="checkbox" data-action="rem-done" data-id="${esc(o.r.id)}" data-date="${o.d}" ${o.done ? "checked" : ""} aria-label="Done" style="width:22px;height:22px">
      <span class="when">${esc(prettyDate(o.d))}${o.r.time ? "<br>" + esc(o.r.time) : ""}</span>
      <span class="grow"><span class="title">${esc(o.r.title)}</span><br><span class="small muted">${esc(CATS[o.r.category] || "")}${o.r.repeat && o.r.repeat !== "none" ? " · repeats " + esc(o.r.repeat === "weekdays" ? "on school days" : o.r.repeat) : ""}${o.r.notes ? " · " + esc(o.r.notes) : ""}</span></span>
      <button class="iconbtn" data-action="rem-del" data-id="${esc(o.r.id)}" aria-label="Delete reminder">🗑</button>
    </div>`;
  const notifState = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  $("#view-reminders").innerHTML = `
    <div class="card">
      <h2>New reminder</h2>
      <form data-form="rem-add" class="form-grid">
        <label class="field full"><span>What</span><input type="text" name="title" required maxlength="120" placeholder="e.g. School annual day, 9-month vaccine, PTM" data-testid="rem-title"></label>
        <label class="field"><span>Date</span><input type="date" name="date" required value="${esc(prefillDate || TODAY)}" data-testid="rem-date"></label>
        <label class="field"><span>Time</span><input type="time" name="time" data-testid="rem-time"></label>
        <label class="field"><span>Type</span><select name="category">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label class="field"><span>Repeat</span><select name="repeat" data-testid="rem-repeat"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">School days (Mon to Fri)</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label class="field full"><span>Notes</span><input type="text" name="notes" maxlength="200" placeholder="Optional"></label>
        <div class="full"><button class="btn primary" data-testid="rem-add">Add reminder</button></div>
      </form>
    </div>
    ${overdue.length ? `<div class="card" data-testid="overdue"><h2>⚠️ Missed</h2>${overdue.map(row).join("")}</div>` : ""}
    <div class="card" data-testid="upcoming">
      <div class="row between"><h2>Coming up</h2>
      ${notifState === "default" ? `<button class="btn sm" data-action="notif">🔔 Turn on alerts</button>` : notifState === "granted" ? '<span class="pill ok">Alerts on while the app is open</span>' : ""}</div>
      ${upcoming.length ? upcoming.map(row).join("") : '<p class="empty-state">No reminders in the next two months.</p>'}
    </div>`;
}

// ---------- notifications ----------
function checkDueReminders() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const key = todayKey();
  let changed = false;
  for (const r of remindersOn(state, key)) {
    if (r.doneOnDate || !r.time || r.time > hhmm) continue;
    const nk = `${r.id}|${key}`;
    if (state.notified[nk]) continue;
    state.notified[nk] = true;
    changed = true;
    const text = `${r.time} ${r.title}`;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification("Reminder", { body: text }); } catch { toast("⏰ " + text); }
    } else toast("⏰ " + text);
  }
  if (changed) save(state);
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tabs button");
  if (tab) return setTab(tab.dataset.tab);
  if (e.target.closest("#ai-chip")) { ui.ai = "unknown"; renderHeader(); return checkAi(); }
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "INPUT" && el.type !== "button") return;
  const a = el.dataset.action;
  const day = () => ensureDay(ui.selected);
  switch (a) {
    case "select-day": {
      const prev = ui.selected;
      const sameMonth = el.dataset.date.slice(0, 7) === ui.month.slice(0, 7);
      ui.selected = el.dataset.date;
      ui.month = el.dataset.date;
      if (ui.tab !== "calendar") setTab("calendar");
      else if (!sameMonth || !$("#cal-day")) render();
      else {
        $(`[data-testid=cal-day-${prev}]`)?.classList.remove("sel");
        $(`[data-testid=cal-day-${ui.selected}]`)?.classList.add("sel");
        $("#cal-day").innerHTML = renderDayPanel(ui.selected);
      }
      break;
    }
    case "month": ui.month = addMonths(ui.month, Number(el.dataset.delta)); render(); break;
    case "goto-today": ui.month = TODAY; ui.selected = TODAY; render(); break;
    case "approve":
      if (Object.keys(slotIssues(ui.selected)).length && ui.confirmUnsafe !== ui.selected) {
        ui.confirmUnsafe = ui.selected;
        renderDay();
        $("[data-testid=day-safety]")?.scrollIntoView({ block: "center", behavior: "smooth" });
        break;
      }
      approveDay(day()); ui.confirmUnsafe = null; commitDay(); toast("Day approved ✅");
      break;
    case "approve-anyway": approveDay(day()); ui.confirmUnsafe = null; commitDay(); toast("Day approved ✅"); break;
    case "cancel-approve": ui.confirmUnsafe = null; renderDay(); break;
    case "unapprove": unapproveDay(day()); commitDay(); break;
    case "clear-slot": { const d = day(); delete d.meals[el.dataset.slot]; markEdited(d); commitDay(); break; }
    case "view-recipe": { const r = findRecipe(el.dataset.id); if (r) recipeDialog(r); break; }
    case "autofill": {
      const n = applySuggestions(ui.selected);
      commitDay();
      toast(n ? `Added ${n} meal${n > 1 ? "s" : ""}. Approve the day when ready.` : "All meals are already planned.");
      break;
    }
    case "suggest-approve": {
      const n = applySuggestions(ui.selected);
      if (!n) { commitDay(); toast("All meals are already planned. Use Approve below when ready."); break; }
      if (Object.keys(slotIssues(ui.selected)).length) {
        ui.confirmUnsafe = ui.selected;
        commitDay();
        toast("Meals added, but one needs a safety check before approving.");
      } else {
        approveDay(day());
        commitDay();
        toast(`${n} meal${n === 1 ? "" : "s"} added and the day is approved ✅`);
      }
      break;
    }
    case "suggest-shuffle": {
      const e = ui.suggest[ui.selected];
      if (e) { e.seed++; e.picks = null; }
      renderDay();
      break;
    }
    case "suggest-swap": {
      const e = ui.suggest[ui.selected];
      if (e) { e.offsets[el.dataset.slot] = (e.offsets[el.dataset.slot] || 0) + 1; e.picks = null; }
      renderDay();
      break;
    }
    case "copy-prev": {
      const prev = getDay(state, addDays(ui.selected, -1));
      if (!dayHasPlan(prev)) { toast("The previous day has no plan to copy."); break; }
      const d = day();
      d.meals = structuredClone(prev.meals);
      d.schedule = prev.schedule.map((s) => ({ ...s, id: uid() }));
      markEdited(d);
      commitDay();
      toast("Copied. Review and approve.");
      break;
    }
    case "day-to-shopping": {
      const needs = plannedRecipes(ui.selected, 1).flatMap(({ date, slot, recipe }) => shoppingNeeds(recipe).map((i) => ({ ...i, key: `${date}|${slot}|${recipe.id}|${normName(i.name)}` })));
      if (!needs.length) { toast("Nothing missing for this day's meals."); break; }
      const added = addToShopping(needs, prettyDate(ui.selected));
      commit();
      toast(added ? `Added ${added} item${added > 1 ? "s" : ""} to the shopping list.` : "Already on the shopping list.");
      break;
    }
    case "del-sched": { const d = day(); d.schedule = d.schedule.filter((s) => s.id !== el.dataset.id); markEdited(d); commitDay(); break; }
    case "school-schedule": {
      const d = day();
      const add = [["07:30", "Breakfast and get ready"], ["08:15", "School drop-off"], ["12:30", "Baby nap"], ["15:15", "School pick-up"], ["19:30", "Dinner"]];
      for (const [time, text] of add) if (!d.schedule.some((s) => s.text === text)) d.schedule.push({ id: uid(), time, text });
      markEdited(d);
      commitDay();
      break;
    }
    case "todo-del": {
      const t = state.todos.find((x) => x.id === el.dataset.id);
      state.todos = state.todos.filter((x) => x !== t);
      if (t && ui.tab === "calendar") commitDay(t.date); else commit();
      break;
    }
    case "new-reminder": setTab("reminders"); renderReminders(el.dataset.date); $("[data-testid=rem-title]")?.focus(); break;
    case "export": {
      const blob = new Blob([exportJson(state)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `meal-planner-backup-${TODAY}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      break;
    }

    case "pantry-del": state.pantry = state.pantry.filter((p) => p !== el.dataset.name); commit(); break;
    case "pantry-quick": if (!state.pantry.some((p) => normName(p) === normName(el.dataset.name))) state.pantry.push(el.dataset.name); commit(); break;
    case "cancel-ai": ui.aiController?.abort("cancel"); break;
    case "save-recipe": {
      const r = findRecipe(el.dataset.id);
      if (r && !state.savedRecipes.some((s) => s.id === r.id)) state.savedRecipes.push(r);
      commit();
      toast("Saved. It will work offline too.");
      break;
    }
    case "unsave": state.savedRecipes = state.savedRecipes.filter((s) => s.id !== el.dataset.id); commit(); break;
    case "plan-recipe": { const r = findRecipe(el.dataset.id); if (r) planDialog(r); break; }
    case "recipe-to-shopping": {
      const r = findRecipe(el.dataset.id);
      if (!r) break;
      const need = shoppingNeeds(r).map((i) => ({ ...i, key: `recipe|${r.id}|${normName(i.name)}` }));
      const added = addToShopping(need, r.title);
      commit();
      toast(added ? `Added ${added} item${added > 1 ? "s" : ""} to the shopping list.` : "Already on the shopping list.");
      break;
    }

    case "store-mode": ui.storeMode = !ui.storeMode; if (ui.storeMode) ui.hideBought = false; render(); break;
    case "shop-store": ui.shopStore = el.dataset.store; render(); break;
    case "shop-del": state.shopping = state.shopping.filter((i) => i.id !== el.dataset.id); commit(); break;
    case "plan-to-shopping": {
      const needs = plannedRecipes(TODAY, 7).flatMap(({ date, slot, recipe }) => shoppingNeeds(recipe).map((i) => ({ ...i, source: prettyDate(date), key: `${date}|${slot}|${recipe.id}|${normName(i.name)}` })));
      if (!needs.length) { toast("Nothing missing for the next 7 days of planned meals."); break; }
      const added = addToShopping(needs);
      commit();
      toast(added ? `Added ${added} ingredient${added > 1 ? "s" : ""} from the meal plan.` : "Everything for the next 7 days is already on the list.");
      break;
    }
    case "clear-bought": state.shopping = state.shopping.filter((i) => !i.bought); commit(); break;
    case "copy-list": {
      const text = groupByAisle(state.shopping.filter((i) => !i.bought)).map(([aisle, list]) => `${aisle}\n${list.map((i) => `- ${i.name}${formatQty(i) ? " (" + formatQty(i) + ")" : ""}`).join("\n")}`).join("\n\n");
      navigator.clipboard?.writeText(text).then(() => toast("Copied. Paste it into WhatsApp or notes."), () => toast("Couldn't copy on this browser."));
      break;
    }
    case "store-del": state.stores = state.stores.filter((s) => s !== el.dataset.store); if (ui.shopStore === el.dataset.store) ui.shopStore = "all"; commit(); break;

    case "todo-older": ui.showOlderMissed = true; render(); break;
    case "todo-day": ui.todoDate = addDays(ui.todoDate, Number(el.dataset.delta)); render(); break;
    case "todo-idea": {
      const date = ui.todoDate;
      if (!state.todos.some((t) => t.date === date && t.text === el.dataset.text)) {
        state.todos.push({ id: uid(), text: el.dataset.text, who: el.dataset.who, date, time: "", done: false });
      }
      commit();
      toast(`Added for ${prettyDate(date)}.`);
      break;
    }

    case "rem-del": state.reminders = state.reminders.filter((r) => r.id !== el.dataset.id); commit(); break;
    case "notif": Notification.requestPermission().then(() => render()); break;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  const a = el.dataset?.action;
  if (!a) return;
  switch (a) {
    case "slot": {
      const d = ensureDay(ui.selected);
      const title = el.value.trim();
      const prev = d.meals[el.dataset.slot]?.title || "";
      if (title === prev) return;
      if (!title) delete d.meals[el.dataset.slot];
      else {
        const r = findRecipeByTitle(title, el.dataset.who);
        d.meals[el.dataset.slot] = { recipeId: r?.id || null, title, forWhom: el.dataset.who };
      }
      markEdited(d);
      commitDay();
      break;
    }
    case "todo-toggle": {
      const t = state.todos.find((x) => x.id === el.dataset.id);
      if (!t) return;
      t.done = el.checked;
      if (ui.tab === "calendar") { commitDay(t.date); break; }
      if (ui.tab !== "todo") { commit(); break; }
      // On the To do tab, tick the row in place instead of rebuilding a long list.
      save(state);
      pendCache.delete(t.date);
      el.closest(".chk")?.classList.toggle("done", t.done);
      const list = todosOn(state, ui.todoDate);
      const left = list.filter((x) => !x.done).length;
      const pill = $("[data-testid=todo-left]");
      if (pill) { pill.textContent = left ? `${left} left` : "All done"; pill.className = `pill ${left ? "warn" : "ok"}`; }
      break;
    }
    case "rem-done": {
      const r = state.reminders.find((x) => x.id === el.dataset.id);
      if (!r) return;
      r.done = r.done || {};
      if (el.checked) r.done[el.dataset.date] = true; else delete r.done[el.dataset.date];
      if (ui.tab === "calendar") commitDay(el.dataset.date); else commit();
      break;
    }
    case "shop-toggle": {
      const it = state.shopping.find((i) => i.id === el.dataset.id);
      if (it) it.bought = el.checked;
      // Bought food goes straight into the kitchen, so meal suggestions can use it.
      if (it && el.checked && aisleFor(it.name) !== "Baby care" && aisleFor(it.name) !== "School & household" && !state.pantry.some((p) => normName(p) === normName(it.name))) {
        state.pantry.push(it.name);
        it.addedToPantry = true;
        clearCaches();
        toast(`${it.name} added to your kitchen`);
      } else if (it && !el.checked && it.addedToPantry) {
        // Unticked by mistake: take back only what this tick added, not food already in the kitchen.
        state.pantry = state.pantry.filter((p) => normName(p) !== normName(it.name));
        delete it.addedToPantry;
        clearCaches();
        toast(`${it.name} taken out of your kitchen`);
      }
      el.closest(".shop-item")?.classList.toggle("bought", el.checked);
      save(state);
      const left = state.shopping.filter((i) => !i.bought).length;
      const pill = $("[data-testid=shop-left]");
      if (pill) pill.textContent = `${left} to buy`;
      if (ui.hideBought) setTimeout(render, 250);
      break;
    }
    case "hide-bought": ui.hideBought = el.checked; render(); break;
    case "nut-free":
      state.settings = { ...state.settings, schoolNutFree: el.checked };
      ui.results = ui.results.filter((r) => !el.checked || checkForAudience(r, { schoolNutFree: true }).safe || !isSchoolFood(r));
      commit();
      toast(el.checked ? "Nut-free school: lunchbox nuts are blocked and kept off the shopping list." : "Nuts allowed in the lunchbox.");
      break;
    case "todo-date": if (isDateKey(el.value)) { ui.todoDate = el.value; render(); } break;
    case "import": {
      const file = el.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const next = importJson(text);
          for (const k of Object.keys(state)) delete state[k];
          Object.assign(state, next);
          save(state, { now: true });
          clearCaches();
          render();
          toast("Backup restored.");
        } catch (err) {
          toast(err.message || "That file couldn't be read.");
        }
      });
      break;
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.dataset?.action === "gen-field") ui.gen[e.target.name] = e.target.value;
  if (e.target.dataset?.action === "saved-filter") {
    ui.savedFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = $("[data-action=saved-filter]");
    inp?.focus();
    inp?.setSelectionRange(pos, pos);
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  const f = form.elements;
  switch (kind) {
    case "add-sched": {
      const text = f.text.value.trim();
      if (!text) return;
      const d = ensureDay(ui.selected);
      d.schedule.push({ id: uid(), time: f.time.value, text });
      markEdited(d);
      commitDay();
      $("[data-testid=sched-text]")?.focus();
      break;
    }
    case "pantry-add": {
      const items = f.items.value.split(",").map((s) => s.trim()).filter(Boolean);
      for (const it of items) if (!state.pantry.some((p) => normName(p) === normName(it))) state.pantry.push(it.toLowerCase());
      commit();
      $("[data-testid=pantry-input]")?.focus();
      break;
    }
    case "generate": generate(f); break;
    case "shop-add": {
      const name = f.name.value.trim();
      if (!name) return;
      const qty = f.qty.value === "" ? null : Number(f.qty.value);
      addToShopping([{ name, quantity: qty, unit: f.unit.value, store: f.store.value }], "manual");
      commit();
      $("[data-testid=shop-name]")?.focus();
      break;
    }
    case "store-add": {
      const s = f.store.value.trim();
      if (s && !state.stores.includes(s)) state.stores.push(s);
      commit();
      break;
    }
    case "todo-add":
    case "todo-add-day": {
      const text = f.text.value.trim();
      const date = kind === "todo-add" ? f.date.value : ui.selected;
      if (!text || !isDateKey(date)) return;
      state.todos.push({ id: uid(), text, who: f.who.value, date, time: f.time?.value || "", done: false });
      if (kind === "todo-add") ui.todoDate = date;
      if (kind === "todo-add-day") commitDay(date); else commit();
      $(kind === "todo-add" ? "[data-testid=todo-input]" : "[data-testid=day-todo-input]")?.focus();
      break;
    }
    case "rem-add": {
      const title = f.title.value.trim();
      const date = f.date.value;
      if (!title || !isDateKey(date)) { toast("Add a title and a date."); return; }
      state.reminders.push({ id: uid(), title, date, time: f.time.value, category: f.category.value, repeat: f.repeat.value, notes: f.notes.value.trim(), done: {} });
      commit();
      toast(`Reminder added for ${prettyDate(date)}.`);
      break;
    }
  }
});

// Remember which meal sections are open so re-renders don't collapse them. The click
// is recorded straight away, because the toggle event fires later and is lost if a
// re-render replaces the section first.
document.addEventListener("click", (e) => {
  const d = e.target.closest?.("summary")?.parentElement;
  const g = d?.dataset?.group;
  if (!g || e.target.closest("button, input, select, a")) return;
  if (d.open) ui.openGroups.delete(g); else ui.openGroups.add(g);
}, true);
document.addEventListener("toggle", (e) => {
  const g = e.target?.dataset?.group;
  if (!g) return;
  if (e.target.open) ui.openGroups.add(g); else ui.openGroups.delete(g);
}, true);

window.addEventListener("pagehide", () => save(state, { now: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save(state, { now: true });
  else refreshToday();
});
window.addEventListener("online", checkAi);
window.addEventListener("offline", () => { ui.ai = "unreachable"; renderHeader(); });

// ---------- start ----------
const initialTab = location.hash.replace("#", "");
setTab(["calendar", "recipes", "shopping", "todo", "reminders"].includes(initialTab) ? initialTab : "calendar");
checkAi();
checkDueReminders();
setInterval(() => { refreshToday(); checkDueReminders(); }, 30000);

// Exposed for tests and debugging in the console.
window.__mealPlanner = { state, ui, TODAY };
