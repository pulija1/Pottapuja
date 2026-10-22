import { load, save, exportJson, importJson } from "./store.js";
import { todayKey, addDays, addMonths, monthGrid, monthLabel, prettyDate, fromKey, isDateKey, isSchoolDay, occurrences } from "./shared/dates.js";
import { checkForAudience, isNutIngredient, isSchoolFood } from "./shared/safety.js";
import { LIBRARY, suggestFromLibrary } from "./shared/recipes.js";
import { mergeItems, groupByAisle, formatQty, missingFromPantry, normName, normUnit, aisleFor } from "./shared/shopping.js";
import { SLOTS, emptyDay, getDay, dayHasPlan, markEdited, approveDay, unapproveDay, slotsFor, bringItemsFor, remindersOn, pendingFor, dayStatus } from "./shared/plan.js";

const state = load();
const TODAY = todayKey();
const AI_TIMEOUT_MS = 60000;

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
  bringDate: nextSchoolDayFrom(TODAY),
  savedFilter: "",
  gen: { forWhom: "both", mealType: "", notes: "" },  // recipe form values survive re-renders
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const WHO_LABEL = { baby: "Baby (8 mo)", kid: "4 yr old", family: "Family", both: "Both kids" };

function nextSchoolDayFrom(key) {
  let k = key;
  for (let i = 0; i < 7 && !isSchoolDay(k); i++) k = addDays(k, 1);
  return isSchoolDay(key) ? key : k;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function commit() {
  save(state);
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
  const fn = { calendar: renderCalendar, recipes: renderRecipes, shopping: renderShopping, bring: renderBring, reminders: renderReminders }[ui.tab];
  fn();
}

// ---------- calendar ----------
function renderCalendar() {
  const cells = monthGrid(ui.month);
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const grid = cells.map((c) => {
    const st = dayStatus(state, c.key);
    const pend = pendingFor(state, c.key, TODAY);
    const rems = remindersOn(state, c.key).length;
    const cls = ["cal-cell", c.inMonth ? "" : "out", c.key === TODAY ? "today" : "", c.key === ui.selected ? "sel" : ""].join(" ");
    const label = `${prettyDate(c.key)}: ${st === "approved" ? "approved" : st === "pending" ? "waiting for approval" : "no plan"}${pend.length ? ", " + pend.length + " pending" : ""}`;
    return `<button type="button" class="${cls}" data-action="select-day" data-date="${c.key}" data-testid="cal-day-${c.key}" data-status="${st}" data-pending="${pend.length}" aria-label="${esc(label)}">
      <span class="d">${c.day}</span>
      <span class="marks"><span class="dot ${st}"></span>${pend.length ? `<span class="badge" title="Pending">${pend.length}</span>` : ""}${rems ? `<span class="badge rem" title="Reminders">⏰${rems}</span>` : ""}</span>
    </button>`;
  }).join("");

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
        ${renderUpcomingPending()}
        ${renderBackupCard()}
      </div>
      <div>${renderDayPanel(ui.selected)}</div>
    </div>`;
}

function renderUpcomingPending() {
  const rows = [];
  for (let i = -7; i <= 13; i++) {
    const k = addDays(TODAY, i);
    const p = pendingFor(state, k, TODAY);
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

function renderDayPanel(key) {
  const day = getDay(state, key) || emptyDay();
  const st = dayStatus(state, key);
  const pend = pendingFor(state, key, TODAY);
  const slots = slotsFor(key);
  const hasPlan = dayHasPlan(day);
  const bring = bringItemsFor(state, key);
  const packed = bring.filter((b) => b.packed).length;
  const rems = remindersOn(state, key);

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
    ${pend.length ? `<h3>Pending for this date</h3><ul class="pending-list" data-testid="day-pending">${pend.map((p) => `<li data-type="${p.type}">${{ approval: "⏳", plan: "📝", reminder: "⏰", bring: "🎒" }[p.type]} ${esc(p.text)}${p.overdue ? ' <span class="pill bad">overdue</span>' : ""}</li>`).join("")}</ul>` : `<p class="small muted" data-testid="day-pending-none">Nothing pending for this date.</p>`}

    <h3>Meals</h3>
    <div data-testid="day-meals">
    ${slots.map((s) => {
      const m = day.meals?.[s.id];
      const r = m?.recipeId ? findRecipe(m.recipeId) : null;
      return `<div class="slot">
        <span class="slot-label">${whoPill(s.who)} ${esc(s.label)}</span>
        <div class="slot-row">
          <input type="text" list="dl-${s.who}" value="${esc(m?.title || "")}" placeholder="Pick a recipe or type a dish" data-action="slot" data-slot="${s.id}" data-who="${s.who}" data-testid="slot-${s.id}" aria-label="${esc(s.label)}">
          ${r ? `<button class="iconbtn" data-action="view-recipe" data-id="${esc(r.id)}" title="View recipe" aria-label="View recipe">📖</button>` : ""}
          ${m?.title ? `<button class="iconbtn" data-action="clear-slot" data-slot="${s.id}" title="Clear" aria-label="Clear ${esc(s.label)}">✕</button>` : ""}
        </div>
      </div>`;
    }).join("")}
    </div>
    <datalist id="dl-baby">${slotDatalist("baby")}</datalist>
    <datalist id="dl-kid">${slotDatalist("kid")}</datalist>
    <datalist id="dl-family">${slotDatalist("family")}</datalist>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" data-action="autofill" data-testid="autofill-day">✨ Fill empty meals from pantry</button>
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

    <h3>To bring</h3>
    <div class="row between">
      <span class="small">${bring.length ? `${packed} of ${bring.length} packed` : "Nothing to bring"}</span>
      <label class="chk small" style="min-height:0;padding:0"><input type="checkbox" data-action="baby-bag" ${day.useBabyBag ? "checked" : ""} data-testid="baby-bag-toggle"> Baby going out (diaper bag)</label>
    </div>
    ${bring.length ? `<div class="progress" style="margin:6px 0"><div style="width:${Math.round((packed / bring.length) * 100)}%"></div></div>` : ""}
    <button class="btn sm" data-action="open-bring" data-date="${key}">Open checklist</button>

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

function addToShopping(items, source) {
  const fresh = items.map((i) => ({ id: uid(), name: i.name, quantity: i.quantity ?? null, unit: normUnit(i.unit), store: i.store || "", bought: false, source }));
  state.shopping = mergeItems([...state.shopping, ...fresh]).map((i) => ({ ...i, id: i.id || uid() }));
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
        <button class="btn" data-action="bought-to-pantry" data-testid="bought-to-pantry">Move bought items to kitchen</button>
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
    for (const m of Object.values(d.meals || {})) {
      const r = m?.recipeId ? findRecipe(m.recipeId) : findRecipeByTitle(m?.title);
      if (r) out.push({ date: k, recipe: r });
    }
  }
  return out;
}

// ---------- bring ----------
function renderBring() {
  const key = ui.bringDate;
  const day = getDay(state, key) || emptyDay();
  const items = bringItemsFor(state, key);
  const packed = items.filter((i) => i.packed).length;
  const section = (who, title) => {
    const list = items.filter((i) => i.who === who);
    if (!list.length) return "";
    return `<div><h3>${title}</h3>${list.map((i) => `<label class="chk ${i.packed ? "done" : ""}" data-testid="bring-item"><input type="checkbox" data-action="bring-toggle" data-id="${esc(i.id)}" ${i.packed ? "checked" : ""}><span class="txt grow">${esc(i.text)}</span>${i.extra ? `<button type="button" class="iconbtn" data-action="bring-del" data-id="${esc(i.id.slice(6))}" aria-label="Remove">✕</button>` : ""}</label>`).join("")}</div>`;
  };
  const tpl = state.bringTemplates;
  $("#view-bring").innerHTML = `
    <div class="card">
      <div class="row between">
        <button class="btn sm" data-action="bring-day" data-delta="-1" aria-label="Previous day">‹</button>
        <input type="date" value="${key}" data-action="bring-date" style="max-width:180px" aria-label="Date" data-testid="bring-date">
        <button class="btn sm" data-action="bring-day" data-delta="1" aria-label="Next day">›</button>
      </div>
      <p class="small muted" style="text-align:center;margin:6px 0">${esc(prettyDate(key))}${key === TODAY ? " · today" : ""} · ${isSchoolDay(key) ? "School day" : "No school"}</p>
      <div class="row between"><strong data-testid="bring-progress">${packed} of ${items.length} packed</strong>
        <label class="chk small" style="min-height:0"><input type="checkbox" data-action="baby-bag" ${day.useBabyBag ? "checked" : ""}> Baby going out</label></div>
      ${items.length ? `<div class="progress" style="margin:6px 0"><div style="width:${Math.round((packed / items.length) * 100)}%"></div></div>` : ""}
      <div class="bring-cols" data-testid="bring-list">
        ${section("kid", "🎒 School bag (4 yr)")}
        ${section("baby", "👶 Baby bag")}
        ${section("family", "🧺 Other things")}
      </div>
      ${!items.length ? '<p class="empty-state">Nothing to bring for this day. Switch on "Baby going out" or add an item below.</p>' : ""}
      <form data-form="bring-add" class="row" style="margin-top:10px">
        <input type="text" name="text" class="grow" placeholder="Add something to bring (e.g. birthday gift, permission slip)" required data-testid="bring-input">
        <select name="who" style="width:120px"><option value="family">Other</option><option value="kid">School bag</option><option value="baby">Baby bag</option></select>
        <button class="btn primary">Add</button>
      </form>
    </div>
    <div class="card"><h2>Everyday lists</h2>
      <p class="small muted">These items show up automatically: the school bag on school days, and the baby bag when the baby is going out.</p>
      ${["kid", "baby"].map((who) => `<h3>${who === "kid" ? "School bag" : "Baby bag"}</h3>
        <div class="chips">${tpl[who].map((t, i) => `<span class="chip">${esc(t)}<button data-action="tpl-del" data-who="${who}" data-i="${i}" aria-label="Remove ${esc(t)}">✕</button></span>`).join("")}</div>
        <form data-form="tpl-add" data-who="${who}" class="row" style="margin-top:6px"><input type="text" name="text" class="grow" placeholder="Add to ${who === "kid" ? "school bag" : "baby bag"}" required><button class="btn sm">Add</button></form>`).join("")}
    </div>`;
}

// ---------- reminders ----------
const CATS = { school: "🏫 School", health: "🩺 Doctor / vaccine", family: "🎉 Family event", shopping: "🛒 Shopping", other: "📌 Other" };

function renderReminders(prefillDate) {
  const from = addDays(TODAY, -14);
  const to = addDays(TODAY, 60);
  const occ = [];
  for (const r of state.reminders) for (const d of occurrences(r, from, to)) occ.push({ r, d, done: !!r.done?.[d] });
  occ.sort((a, b) => (a.d + (a.r.time || "99")).localeCompare(b.d + (b.r.time || "99")));
  const overdue = occ.filter((o) => o.d < TODAY && !o.done);
  const upcoming = occ.filter((o) => o.d >= TODAY);
  const row = (o) => `<div class="rem ${o.done ? "done" : ""} ${o.d < TODAY && !o.done ? "overdue" : ""}" data-testid="reminder-item">
      <input type="checkbox" data-action="rem-done" data-id="${esc(o.r.id)}" data-date="${o.d}" ${o.done ? "checked" : ""} aria-label="Done" style="width:22px;height:22px">
      <span class="when">${esc(prettyDate(o.d))}${o.r.time ? "<br>" + esc(o.r.time) : ""}</span>
      <span class="grow"><span class="title">${esc(o.r.title)}</span><br><span class="small muted">${esc(CATS[o.r.category] || "")}${o.r.repeat && o.r.repeat !== "none" ? " · repeats " + esc(o.r.repeat) : ""}${o.r.notes ? " · " + esc(o.r.notes) : ""}</span></span>
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
        <label class="field"><span>Repeat</span><select name="repeat" data-testid="rem-repeat"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
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
    case "select-day": ui.selected = el.dataset.date; ui.month = el.dataset.date; if (ui.tab !== "calendar") setTab("calendar"); else render(); break;
    case "month": ui.month = addMonths(ui.month, Number(el.dataset.delta)); render(); break;
    case "goto-today": ui.month = TODAY; ui.selected = TODAY; render(); break;
    case "approve": approveDay(day()); commit(); toast("Day approved ✅"); break;
    case "unapprove": unapproveDay(day()); commit(); break;
    case "clear-slot": { const d = day(); delete d.meals[el.dataset.slot]; markEdited(d); commit(); break; }
    case "view-recipe": { const r = findRecipe(el.dataset.id); if (r) recipeDialog(r); break; }
    case "autofill": {
      const d = day();
      let filled = 0;
      for (const s of slotsFor(ui.selected)) {
        if (d.meals[s.id]?.title) continue;
        const used = new Set(Object.values(d.meals).map((m) => m?.recipeId));
        const meal = s.id.split("_")[1];
        const opt = { forWhom: s.who, schoolNutFree: nutFreeOn() };
        const pick = suggestFromLibrary(state.pantry, { ...opt, mealType: meal, limit: 10 })
          .concat(suggestFromLibrary(state.pantry, { ...opt, limit: 40 }))
          .find((r) => (r.forWhom === s.who) && !used.has(r.id));
        if (pick) { d.meals[s.id] = { recipeId: pick.id, title: pick.title, forWhom: pick.forWhom }; filled++; }
      }
      if (filled) markEdited(d);
      commit();
      toast(filled ? `Filled ${filled} meal${filled > 1 ? "s" : ""}. Review and approve.` : "All meals are already planned.");
      break;
    }
    case "copy-prev": {
      const prev = getDay(state, addDays(ui.selected, -1));
      if (!dayHasPlan(prev)) { toast("The previous day has no plan to copy."); break; }
      const d = day();
      d.meals = structuredClone(prev.meals);
      d.schedule = prev.schedule.map((s) => ({ ...s, id: uid() }));
      markEdited(d);
      commit();
      toast("Copied. Review and approve.");
      break;
    }
    case "day-to-shopping": {
      const needs = plannedRecipes(ui.selected, 1).flatMap(({ recipe }) => shoppingNeeds(recipe).map((i) => ({ ...i })));
      if (!needs.length) { toast("Nothing missing for this day's meals."); break; }
      addToShopping(needs, prettyDate(ui.selected));
      commit();
      toast(`Added ${needs.length} item${needs.length > 1 ? "s" : ""} to the shopping list.`);
      break;
    }
    case "del-sched": { const d = day(); d.schedule = d.schedule.filter((s) => s.id !== el.dataset.id); markEdited(d); commit(); break; }
    case "school-schedule": {
      const d = day();
      const add = [["07:30", "Breakfast and get ready"], ["08:15", "School drop-off"], ["12:30", "Baby nap"], ["15:15", "School pick-up"], ["19:30", "Dinner"]];
      for (const [time, text] of add) if (!d.schedule.some((s) => s.text === text)) d.schedule.push({ id: uid(), time, text });
      markEdited(d);
      commit();
      break;
    }
    case "open-bring": ui.bringDate = el.dataset.date; setTab("bring"); break;
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
      const need = shoppingNeeds(r);
      addToShopping(need, r.title);
      commit();
      toast(`Added ${need.length} item${need.length > 1 ? "s" : ""} to the shopping list.`);
      break;
    }

    case "store-mode": ui.storeMode = !ui.storeMode; if (ui.storeMode) ui.hideBought = false; render(); break;
    case "shop-store": ui.shopStore = el.dataset.store; render(); break;
    case "shop-del": state.shopping = state.shopping.filter((i) => i.id !== el.dataset.id); commit(); break;
    case "plan-to-shopping": {
      const needs = plannedRecipes(TODAY, 7).flatMap(({ date, recipe }) => shoppingNeeds(recipe).map((i) => ({ ...i, source: prettyDate(date) })));
      if (!needs.length) { toast("Nothing missing for the next 7 days of planned meals."); break; }
      for (const n of needs) addToShopping([n], n.source);
      commit();
      toast(`Added ${needs.length} ingredient${needs.length > 1 ? "s" : ""} from the meal plan.`);
      break;
    }
    case "bought-to-pantry": {
      const bought = state.shopping.filter((i) => i.bought);
      for (const b of bought) if (!state.pantry.some((p) => normName(p) === normName(b.name))) state.pantry.push(b.name);
      state.shopping = state.shopping.filter((i) => !i.bought);
      commit();
      toast(bought.length ? `Moved ${bought.length} item${bought.length > 1 ? "s" : ""} to the kitchen.` : "Nothing marked as bought yet.");
      break;
    }
    case "clear-bought": state.shopping = state.shopping.filter((i) => !i.bought); commit(); break;
    case "copy-list": {
      const text = groupByAisle(state.shopping.filter((i) => !i.bought)).map(([aisle, list]) => `${aisle}\n${list.map((i) => `- ${i.name}${formatQty(i) ? " (" + formatQty(i) + ")" : ""}`).join("\n")}`).join("\n\n");
      navigator.clipboard?.writeText(text).then(() => toast("Copied. Paste it into WhatsApp or notes."), () => toast("Couldn't copy on this browser."));
      break;
    }
    case "store-del": state.stores = state.stores.filter((s) => s !== el.dataset.store); if (ui.shopStore === el.dataset.store) ui.shopStore = "all"; commit(); break;

    case "bring-day": ui.bringDate = addDays(ui.bringDate, Number(el.dataset.delta)); render(); break;
    case "bring-del": { const d = ensureDay(ui.bringDate); d.extraBring = d.extraBring.filter((x) => x.id !== el.dataset.id); delete d.bring["extra:" + el.dataset.id]; commit(); break; }
    case "tpl-del": state.bringTemplates[el.dataset.who].splice(Number(el.dataset.i), 1); commit(); break;

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
        if (r && el.dataset.who === "baby" && !checkForAudience({ ...r, forWhom: "baby" }).safe && r.forWhom !== "baby") toast("Heads up: this dish isn't checked as baby-safe. Take out a plain portion.");
      }
      markEdited(d);
      commit();
      break;
    }
    case "baby-bag": {
      const key = ui.tab === "bring" ? ui.bringDate : ui.selected;
      ensureDay(key).useBabyBag = el.checked;
      commit();
      break;
    }
    case "rem-done": {
      const r = state.reminders.find((x) => x.id === el.dataset.id);
      if (!r) return;
      r.done = r.done || {};
      if (el.checked) r.done[el.dataset.date] = true; else delete r.done[el.dataset.date];
      commit();
      break;
    }
    case "shop-toggle": {
      const it = state.shopping.find((i) => i.id === el.dataset.id);
      if (it) it.bought = el.checked;
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
    case "bring-toggle": {
      const d = ensureDay(ui.bringDate);
      if (el.checked) d.bring[el.dataset.id] = true; else delete d.bring[el.dataset.id];
      commit();
      break;
    }
    case "bring-date": if (isDateKey(el.value)) { ui.bringDate = el.value; render(); } break;
    case "import": {
      const file = el.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const next = importJson(text);
          for (const k of Object.keys(state)) delete state[k];
          Object.assign(state, next);
          save(state, { now: true });
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
      commit();
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
    case "bring-add": {
      const text = f.text.value.trim();
      if (!text) return;
      ensureDay(ui.bringDate).extraBring.push({ id: uid(), text, who: f.who.value });
      commit();
      $("[data-testid=bring-input]")?.focus();
      break;
    }
    case "tpl-add": {
      const text = f.text.value.trim();
      const who = form.dataset.who;
      if (text && !state.bringTemplates[who].includes(text)) state.bringTemplates[who].push(text);
      commit();
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

window.addEventListener("pagehide", () => save(state, { now: true }));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(state, { now: true }); });
window.addEventListener("online", checkAi);
window.addEventListener("offline", () => { ui.ai = "unreachable"; renderHeader(); });

// ---------- start ----------
const initialTab = location.hash.replace("#", "");
setTab(["calendar", "recipes", "shopping", "bring", "reminders"].includes(initialTab) ? initialTab : "calendar");
checkAi();
checkDueReminders();
setInterval(checkDueReminders, 30000);

// Exposed for tests and debugging in the console.
window.__mealPlanner = { state, ui, TODAY };
