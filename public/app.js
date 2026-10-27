import { load, save, exportJson, importJson, onChange, defaultState, onSaveError, cancelPendingSave, STORAGE_KEY } from "./store.js";
import * as cloud from "./cloud.js";
import { getAiKey, setAiKey, looksLikeKey, browserRecipes, browserPlanChat } from "./ai-browser.js";
import { catalogText, libraryRefs, savedRefs, planWindow, contextText, userTurn, planChanges } from "./shared/plan-chat.js";
import { QUICK_MINUTES } from "./shared/ai-prompt.js";
import { todayKey, addDays, addMonths, monthGrid, monthLabel, prettyDate, fromKey, isDateKey, isSchoolDay, occurrences, daysBetween } from "./shared/dates.js";
import { checkRecipe, checkForAudience, isNutIngredient, isSchoolFood } from "./shared/safety.js";
import { LIBRARY, suggestFromLibrary, readyToCook, RECIPE_BOOK_STATUS, cookByVegetables, missingForRecipe, CUISINES, inCuisines, topPicks, leftoverKind, leftoverRecipesFor, freezerSet, sideDipsFor, quickBreakfasts, breakfastKind, fitsMorning, familyDinnerIdeas, withVegCurries, isVegCurry, mainVegOf, oneEachVeg, VEG_CURRY_MIN, MORNING_MINUTES, EASY_NIGHT_MINUTES } from "./shared/recipes.js";
import { PREF_OPTIONS, prefsFor, prefProblem, avoidedIn, prefsPrompt, prefStaples, cleanPrefs } from "./shared/preferences.js";
import { kitchenExpiry, useSoonWeights, goneBy, staplesFor, staplesSummary, expiryOf, dateKeyOf, daysLeftLabel, shelfLifeDays } from "./shared/freshness.js";
import { nutritionTags, TAG_LABELS } from "./shared/recipe-book.js";
import { groupKitchen, babyFruitFor, recipeHasFruit } from "./shared/kitchen.js";
import { APPLIANCES, ownedAppliances, methodsFor, fastestMinutes, basketPairs, applianceRequest } from "./shared/appliances.js";
import { NUTRIENTS, DAILY_NEEDS, estimateNutrition, dailyShare } from "./shared/nutrition.js";
import { mergeItems, groupByAisle, formatQty, missingFromPantry, normName, normUnit, aisleFor } from "./shared/shopping.js";
import { foodArt } from "./shared/food-art.js";
import { lunchTurn } from "./shared/lunch-rotation.js";
import { AGE_SECTIONS, SECTION_MEALS, REGULAR_GAP_DAYS, regularsFor, isRegular, toggleRegular, ageSection, regularsFirst } from "./shared/regulars.js";
import { SLOTS, emptyDay, getDay, dayHasPlan, markEdited, approveDay, unapproveDay, slotsFor, todosOn, MEAL_GROUPS, whoLabel, slotLabel, remindersOn, pendingFor, dayStatus } from "./shared/plan.js";

const state = load();
let TODAY = todayKey();
const AI_TIMEOUT_MS = 50000;  // the server gives up at 40 s
const KEY_AI_TIMEOUT_MS = 120000;  // straight to Claude with the family's key: no server limit, the answer streams in
const CHAT_IDLE_MS = 60000;   // the planning chat gives up when nothing new arrives for a minute
const CHAT_MAX_MS = 300000;   // or after five minutes in all

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
  cartOpen: false,       // the "In the cart" section on the shopping list is expanded
  openGroups: new Set(),          // meal sections the parent has expanded in the day panel
  closedGroups: new Set(),        // sections that start open but the parent has closed
  calView: calViewPref(),         // "week": only the chosen day's week shows, "month": the whole month
  suggest: {},                    // date -> { seed, picks: { slotId: recipeId } } meal suggestions shown in the day panel
  savedFilter: "",
  morePicks: false,       // Recipes tab: show 15 top picks instead of 5
  gen: { forWhom: "both", mealType: "", notes: "", quick: false },
  cookVeg: [],            // vegetables picked in "Cook by vegetable"
  cookQuick: true,        // ...and only the ones ready in QUICK_MINUTES
  age: { who: "kid", meal: "", all: false },   // Recipes by age: whose section, which meal, and the whole list or the first few
  confirmUnsafe: null,    // date whose unsafe plan the parent was warned about
  // The week-planning chat: what the parent and Claude said (shown), and the turns sent to Claude.
  chat: { shown: [], turns: [], busy: false, controller: null },
  // recipe form values survive re-renders
};

// ---------- helpers ----------
// The calendar opens on one week to save scrolling; the parent's choice is remembered on this phone.
function calViewPref() {
  try { return localStorage.getItem("mealPlanner.calView") === "month" ? "month" : "week"; } catch { return "week"; }
}
function setCalView(v) {
  ui.calView = v;
  try { localStorage.setItem("mealPlanner.calView", v); } catch {}
}
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// With an undo function the toast carries an Undo button and stays up longer.
function toast(msg, undo = null) {
  const t = $("#toast");
  t.innerHTML = esc(msg) + (undo ? ' <button type="button" class="toast-undo" data-testid="toast-undo">Undo</button>' : "");
  t.classList.toggle("has-undo", !!undo);
  t.classList.add("show");
  toast.undo = undo;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.classList.remove("show"); toast.undo = null; }, undo ? 5000 : 2600);
}

// A bottom sheet: slides up from the bottom, closes on Escape, a tap on the dimmed
// backdrop, the ✕, or dragging the handle down. Forms inside use the global submit handler.
let ignorePop = false;
function sheet(testid, html) {
  $(`dialog[data-testid=${testid}]`)?.close();
  const dlg = document.createElement("dialog");
  dlg.className = "sheet";
  dlg.dataset.testid = testid;
  dlg.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>${html}`;
  document.body.appendChild(dlg);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("[data-sheet-close]")) dlg.close();
  });
  // The phone's Back gesture closes the sheet instead of leaving the app.
  history.pushState({ sheet: true }, "");
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (history.state?.sheet) { ignorePop = true; history.back(); }
  });
  let startY = null;
  const grip = dlg.querySelector(".sheet-grip");
  grip.addEventListener("pointerdown", (e) => { startY = e.clientY; grip.setPointerCapture(e.pointerId); dlg.style.transition = "none"; });
  grip.addEventListener("pointermove", (e) => { if (startY != null) dlg.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
  grip.addEventListener("pointerup", (e) => {
    const dy = e.clientY - (startY ?? e.clientY);
    startY = null;
    dlg.style.transition = "";
    dlg.style.transform = "";
    if (dy > 80) dlg.close();
  });
  dlg.showModal();
  return dlg;
}

// Radio buttons drawn as big chips, for picking a unit, store or person with one tap.
function chipRadios(name, options, selected, testid) {
  return `<div class="seg radio-chips" role="radiogroup" data-testid="${testid}">${options.map(([v, label]) =>
    `<label><input type="radio" name="${name}" value="${esc(v)}" ${v === selected ? "checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>`;
}

// A list row that can be ticked by a tap anywhere on it or a swipe to the right, and
// deleted with a swipe to the left. `check` is the checkbox, `more` the details button.
function swipeRow({ testid, cls = "", data = "", check, pic = "", body, more, leftLabel, rightLabel = "Delete" }) {
  return `<div class="swipe ${cls}" data-testid="${testid}" ${data}>
    <div class="swipe-bg" aria-hidden="true"><span class="swipe-l">✓ ${esc(leftLabel)}</span><span class="swipe-r">${esc(rightLabel)} 🗑</span></div>
    <div class="swipe-fg">
      <label class="tap-main">${check}${pic}<span class="tap-text">${body}</span></label>
      ${more || ""}
    </div>
  </div>`;
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

// Swap in a whole new set of data (restore, load latest, another tab's save) and redraw.
function replaceState(next) {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  stampUndated();
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
// The air fryer and oven the family has, from 👤 Profile.
const appliancesOwned = () => ownedAppliances(state.settings);
// The cuisines picked in Profile (ids from CUISINES). Empty means every cuisine counts the same.
const cuisinePicks = () => (Array.isArray(state.settings?.cuisines) ? state.settings.cuisines : []).filter((c) => CUISINES.some((x) => x.id === c));
// What's in the freezer (the Frozen tab) counts as in the kitchen for suggestions, well behind fresh food.
const frozenOnHand = () => state.frozen || [];
// The cuisine's basics (rice, dals, spices, oil, onions) count as at home unless the parent turns it off.
const assumeStaples = () => state.settings?.assumeStaples !== false;
// The baby's iron-fortified cereal (set in Profile) is always at home too.
const staplesOn = () => [...(assumeStaples() ? staplesFor(cuisinePicks()) : []), ...prefStaples(state.settings)];
// Use-by dates of the kitchen food, typed in or estimated from how long it keeps in the fridge.
const pantryDates = () => state.pantryDates || {};
const expiryList = () => kitchenExpiry(state.pantry, pantryDates(), TODAY);
const USE_SOON_DAYS = 3;   // the kitchen flags food that runs out within this many days
// A kitchen item came in today; `expires` is its use-by date, or "" to estimate it.
function noteAdded(name, expires = "") {
  const k = dateKeyOf(name);
  if (k) state.pantryDates = { ...pantryDates(), [k]: { added: TODAY, expires: isDateKey(expires) ? expires : "" } };
}
// Kitchen items from before use-by dates (or from an old backup) start their fridge estimate from now.
function stampUndated() {
  const dates = pantryDates();
  const missing = state.pantry.filter((p) => dateKeyOf(p) && !dates[dateKeyOf(p)]);
  if (!missing.length) return false;
  state.pantryDates = { ...dates, ...Object.fromEntries(missing.map((p) => [dateKeyOf(p), { added: TODAY, expires: "" }])) };
  return true;
}
function forgetDates(name) {
  const k = dateKeyOf(name);
  if (!(k in pantryDates()) || state.pantry.some((p) => dateKeyOf(p) === k)) return;
  const { [k]: _gone, ...rest } = pantryDates();
  state.pantryDates = rest;
}
// What to cook first on a date: food that runs out by then, leaving out what meals planned from
// today up to that date (and `picks`, recipe ids about to be planned) already use up.
function useSoonOn(key, picks = {}) {
  const skip = new Set();
  const mark = (r) => { for (const i of r?.ingredients || []) skip.add(normName(i.name)); };
  for (let k = TODAY; k <= key; k = addDays(k, 1)) {
    for (const m of Object.values(getDay(state, k)?.meals || {})) if (m?.title) mark((m.recipeId && findRecipe(m.recipeId)) || findRecipeByTitle(m.title));
  }
  for (const id of Object.values(picks)) mark(findRecipe(id));
  return useSoonWeights(state.pantry, pantryDates(), { today: TODAY, onKey: key < TODAY ? TODAY : key, skip });
}
// Vegetables count most when ranking top picks; onion, tomato and the aromatics are in almost everything, so they don't.
const isMainVeg = (n) => aisleFor(n) === "Vegetables" && !/onion|shallot|ginger|garlic|chill?i|curry leaves|coriander|mint|lemon|lime|tomato/.test(n);

// Family curries cooked on a date that can be made into something new the next day ("chicken curry", "dal", ...).
function leftoversFrom(key) {
  const day = getDay(state, key);
  const out = [];
  for (const s of slotsFor(key)) {
    const m = day?.meals?.[s.id];
    if (!m?.title || s.who !== "family") continue;
    const r = (m.recipeId && findRecipe(m.recipeId)) || findRecipeByTitle(m.title) || { title: m.title };
    const kind = leftoverKind(r);
    if (kind && !out.some((o) => o.kind === kind)) out.push({ kind, title: m.title.replace(/\s*\(.*?\)/g, "").trim() || m.title });
  }
  return out;
}

// Missing ingredients for a recipe, leaving nuts off the list for school food when the school is nut-free.
// Whatever is in the freezer isn't missing either.
function shoppingNeeds(recipe) {
  const cold = freezerSet(frozenOnHand());
  const need = missingFromPantry(recipe, state.pantry).filter((i) => !cold.has(normName(i.name)));
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
    // A food on the child's never-use list (Profile) is flagged like a safety problem.
    const avoided = avoidedIn({ ...r, title: m.title }, prefsFor(state.settings, s.who).avoid);
    if (res.errors.length || avoided) {
      const msgs = res.errors.map((e) => e.message);
      if (avoided) msgs.push(`Has ${avoided}, which you asked to leave out for ${whoLabel(s.who, state.settings)}.`);
      if (forBaby && linked && linked.forWhom !== "baby") msgs.push("This is not a baby recipe: take out a plain, mashed portion before salt and spice.");
      out[s.id] = { label: slotLabel(s, state.settings), messages: [...new Set(msgs)] };
    }
  }
  return out;
}

// The family's daily goal for the 4-year-old: an egg, a milk/dairy food and some nuts.
// Counts the kid's meals and the family dinner; a dish typed by hand is judged by its name.
const GOALS = ["egg", "dairy", "nuts"];
const GOAL_LABELS = { egg: "🥚 Egg", dairy: "🥛 Milk", nuts: "🥜 Nuts" };
function mealTags(m) {
  const r = m?.recipeId ? findRecipe(m.recipeId) : null;
  return r ? (r.tags || nutritionTags(r)) : nutritionTags({ ingredients: [{ name: m?.title || "" }] });
}

function kidGoals(key, extra = {}) {
  const day = getDay(state, key) || emptyDay();
  const out = Object.fromEntries(GOALS.map((g) => [g, null]));
  for (const s of slotsFor(key).filter((x) => x.who === "kid" || x.who === "family")) {
    const m = day.meals?.[s.id]?.title ? day.meals[s.id] : extra[s.id] ? { recipeId: extra[s.id] } : null;
    if (!m) continue;
    for (const t of mealTags(m)) if (out[t] === null) out[t] = { slot: s, title: m.title || findRecipe(m.recipeId)?.title || "", planned: !!day.meals?.[s.id]?.title };
  }
  return out;
}

function renderKidGoals(key) {
  const goals = kidGoals(key);
  const sugg = key >= TODAY ? kidGoals(key, suggestionsFor(key)) : goals;
  // Folded to one small line under the meals: the checks still run, but take no room until opened.
  const ticks = GOALS.filter((g) => goals[g]).length;
  return `<details class="goals-foot" data-group="kid-goals" data-testid="kid-goals-foot" ${ui.openGroups.has("kid-goals") ? "open" : ""}>
    <summary class="small muted">${GOALS.map((g) => GOAL_LABELS[g].split(" ")[0]).join("")} Egg, milk, nuts · ${ticks} of ${GOALS.length}</summary>
    <div class="goals" data-testid="kid-goals" aria-label="Daily goals for ${esc(whoLabel("kid", state.settings))}">
    ${GOALS.map((g) => {
      const hit = goals[g];
      const idea = !hit && sugg[g];
      const how = hit ? `${slotLabel(hit.slot, state.settings)}: ${hit.title}` : idea ? `Suggested: ${idea.title}` : "Not planned yet";
      return `<div class="goal ${hit ? "done" : idea ? "idea" : "todo"}" data-testid="kid-goal" data-goal="${g}" data-done="${!!hit}" title="${esc(how)}">
        <span class="goal-label">${GOAL_LABELS[g]} ${hit ? "✓" : ""}</span><span class="goal-how">${esc(how)}</span></div>`;
    }).join("")}
    </div>
  </details>`;
}

// A picture tile for a dish or an item: a big emoji on a soft colour (see shared/food-art.js).
function art(x, cls = "", fallback = "") {
  const a = foodArt(x);
  return `<span class="art tone-${a.tone} ${cls}" aria-hidden="true">${a.emoji === "🍽️" && fallback ? fallback : a.emoji}</span>`;
}

// A collapsible card: one line with an icon, a title and a short summary (a count, a few names).
// Sections start closed unless `open`; whatever the parent opens or closes stays that way.
function section({ id, icon, title, meta = "", open = false, testid = "", cls = "", body }) {
  const isOpen = ui.openGroups.has(id) || (open && !ui.closedGroups.has(id));
  return `<details class="card section ${cls}" data-group="${id}" ${testid ? `data-testid="${testid}"` : ""} ${isOpen ? "open" : ""}>
    <summary class="sec-head"><span class="sec-icon" aria-hidden="true">${icon}</span><span class="sec-title"><strong>${title}</strong>${meta ? `<span class="sec-meta">${meta}</span>` : ""}</span><span class="chev" aria-hidden="true"></span></summary>
    <div class="sec-body">${body}</div>
  </details>`;
}

const tagIcons = (r) => (r?.tags || []).map((t) => TAG_LABELS[t].split(" ")[0]).join("");

function whoPill(who) {
  return `<span class="pill ${esc(who)}">${esc(whoLabel(who, state.settings, { age: true }))}</span>`;
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
  // No AI on this site (GitHub Pages has no server): use the family's own key from this browser.
  if (!aiOnline() && getAiKey()) ui.ai = "key";
  renderHeader();
  if (ui.tab === "recipes") render();
}

function aiOnline() {
  return ui.ai === "live" || ui.ai === "mock" || ui.ai === "key";
}

// ---------- header & tabs ----------
function renderHeader() {
  $("#today-label").textContent = "Today: " + fromKey(TODAY).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const chip = $("#ai-chip");
  const label = { live: "AI recipes on", key: "AI recipes on (your key)", mock: "AI: test mode", off: "AI off: tap to add a key", unreachable: "AI off: tap to add a key", unknown: "AI: checking…" }[ui.ai];
  chip.title = aiOnline() ? "Tap to check the recipe AI again" : "Recipes come from the built-in recipe book. Tap to add a Claude API key for AI recipes.";
  chip.textContent = label;
  chip.className = "ai-chip " + (aiOnline() ? "on" : ui.ai === "unknown" ? "" : "off");
  renderSyncButtons();
}

// ---------- sign-in & profile ----------
function modal(testid, html, onClick) {
  $(`dialog[data-testid=${testid}]`)?.close();
  const dlg = document.createElement("dialog");
  dlg.dataset.testid = testid;
  dlg.innerHTML = html;
  dlg.addEventListener("click", (e) => { const b = e.target.closest("button[data-sync]"); if (b) onClick(b.dataset.sync, dlg, b); });
  dlg.addEventListener("submit", (e) => e.preventDefault());
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function hideLogin() {
  $("#login").hidden = true;
  $("#login").innerHTML = "";
  document.body.classList.remove("locked");
}

$("#login").addEventListener("click", (e) => {
  if (e.target.closest("[data-login=skip]")) { cloud.setCloudSkipped(true); hideLogin(); renderSyncButtons(); }
  if (e.target.closest("[data-login=google]")) cloudSignIn(e.target.closest("button"));
});

// First launch: offer Google sign-in when family sync is set up and nobody is signed in.
async function maybeShowLogin() {
  if (!cloud.cloudConfigured()) return;
  await cloud.cloudAuthSettled();
  if (cloud.getCloud().status === "signed-out" && !cloud.cloudSkipped()) showCloudLogin();
}

function downloadBackup() {
  const blob = new Blob([exportJson(state)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `meal-planner-backup-${TODAY}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- family sync (Firebase) ----------
const CLOUD_LABEL = {
  loading: "☁ Starting…", connecting: "☁ Connecting…", synced: "☁ Synced", saving: "☁ Saving…",
  offline: "☁ Offline", error: "☁ Sync problem", "no-family": "☁ Set up sync", choose: "☁ Set up sync", "signed-out": "☁ Sign in", unavailable: "☁ Sync off",
};
const CLOUD_TEXT = {
  loading: "Starting family sync…",
  connecting: "Connecting to your family's data…",
  synced: "Everything is synced with your family.",
  saving: "Saving your changes to the family…",
  offline: "Offline. Changes are saved on this phone and sync when it's back online.",
  "no-family": "Signed in, but not in a family space yet.",
  choose: "Signed in. Choose the family space to join.",
  "signed-out": "Not signed in. Your data is saved on this phone only.",
};

function cloudStatusText(c = cloud.getCloud()) {
  return c.error && (c.status === "error" || c.status === "unavailable") ? "⚠️ " + c.error : CLOUD_TEXT[c.status] || "";
}

function renderSyncButtons() {
  const c = cloud.getCloud();
  const btn = $("#cloud");
  btn.hidden = !c.configured;
  btn.textContent = CLOUD_LABEL[c.status] || "☁ Sync";
  btn.dataset.status = c.status;
  btn.title = cloudStatusText(c);
  const prof = $("#profile");
  prof.innerHTML = c.user?.photo ? `<img src="${esc(c.user.photo)}" alt="" width="32" height="32" referrerpolicy="no-referrer">` : c.user ? esc((c.user.name || c.user.email).trim().charAt(0).toUpperCase()) : "👤";
  prof.setAttribute("aria-label", c.user ? `Signed in as ${c.user.email}. Profile and family sync` : "Profile and family sync");
  for (const el of document.querySelectorAll("[data-testid=cloud-status-text]")) el.textContent = cloudStatusText(c);
}

function showCloudLogin(note = "") {
  const el = $("#login");
  el.innerHTML = `<div class="card login-card" data-testid="cloud-login">
    <div class="brand"><span class="logo" aria-hidden="true">🍛</span><h1>Family Meal Planner</h1></div>
    <h2>Sign in</h2>
    <p class="small muted">Sign in with Google to keep the meal plans, shopping list, to-dos and reminders the same on every phone in the family. Changes save on their own, and the app still works with no signal.</p>
    ${note ? `<p class="small" style="color:var(--warn)">${esc(note)}</p>` : ""}
    <p class="small sync-status" data-testid="login-status" role="status"></p>
    <button type="button" class="btn primary" data-login="google" data-testid="google-signin">Sign in with Google</button>
    <button type="button" class="btn ghost" data-login="skip" data-testid="login-skip">Use on this device only, without signing in</button>
  </div>`;
  el.hidden = false;
  document.body.classList.add("locked");
  el.querySelector("[data-login=google]").focus();
}

async function cloudSignIn(btn) {
  const status = $("[data-testid=login-status]") || $("[data-testid=cloud-status-text]");
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Opening Google sign-in…";
  try {
    await cloud.signIn();
    cloud.setCloudSkipped(false);
    hideLogin();
    $("dialog[data-testid=profile-dialog]")?.close();
  } catch (err) {
    if (btn) btn.disabled = false;
    if (status) status.textContent = "⚠️ " + (err?.message || "Couldn't sign in.");
  }
}

// Signed in, but this Google account isn't in a family space: start one, or wait to be added.
function noFamilyDialog(c = cloud.getCloud(), { removed = false } = {}) {
  hideLogin();
  modal("no-family", `<div class="stack">
    <h2>${removed ? "You're no longer in the family space" : "Set up family sync"}</h2>
    <p>${removed ? "Someone took" : "There's no family space for"} <strong>${esc(c.user?.email || "")}</strong>${removed ? " out of the family space. Your data stays on this phone." : " yet."}</p>
    ${c.otherAccountData ? `<p class="small" style="color:var(--warn)">The lists on this phone were synced by a different Google account. Start fresh to keep them out of your space; they stay in that account's family space.</p>
    <button class="btn primary" data-sync="start-fresh" data-testid="family-start-fresh">Start our family space, fresh</button>
    <button class="btn" data-sync="start" data-testid="family-start">Start it with this phone's lists</button>` : `<button class="btn primary" data-sync="start" data-testid="family-start">Start our family space</button>
    <p class="small muted">Starts a new space with this phone's data in it.</p>`}
    <p class="small muted">Then add the rest of the family in 👤 Profile by their Google email.</p>
    <p class="small muted">If someone in the family already started one, ask them to add <strong>${esc(c.user?.email || "")}</strong> in their 👤 Profile, then tap Check again.</p>
    <p class="small sync-status" data-testid="no-family-status" role="status"></p>
    <button class="btn" data-sync="again" data-testid="family-check">Check again</button>
    <button class="btn ghost" data-sync="signout" data-testid="family-signout">Sign out</button>
  </div>`, async (act, dlg, b) => {
    const st = dlg.querySelector("[data-testid=no-family-status]");
    if (act === "start" || act === "start-fresh") {
      b.disabled = true;
      st.textContent = "Starting your family space…";
      try { await cloud.startFamily({ fresh: act === "start-fresh" }); dlg.close(); } catch (err) { b.disabled = false; st.textContent = "⚠️ " + (err?.message || "Couldn't start it."); }
    } else if (act === "again") {
      dlg.close();
      // Opens the join question, or this dialog again when nobody has added this account yet.
      if (!(await cloud.checkFamilyAgain())) $("dialog[data-testid=no-family] [data-testid=no-family-status]")?.replaceChildren(`Not added yet. Ask them to add ${c.user?.email || "your email"} in 👤 Profile.`);
    } else if (act === "signout") {
      await cloud.signOutCloud();
      dlg.close();
    }
  });
}

// This account is listed in one or more family spaces. Anyone can list any email in their own
// space, so show who started each one and join only when the person says so.
function chooseFamilyDialog(c, list) {
  hideLogin();
  const used = !!state.updatedAt;
  const rows = list.map((f) => {
    const takeFamily = f.otherFamilyData || c.otherAccountData;
    const buttons = !used
      ? `<button class="btn primary" data-sync="join" data-id="${esc(f.id)}" data-testid="family-join">Join</button>`
      : takeFamily
        ? `<button class="btn primary" data-sync="join-family" data-id="${esc(f.id)}" data-testid="family-join-theirs">Join and use the family's lists</button>
           <button class="btn" data-sync="join" data-id="${esc(f.id)}" data-testid="family-join">Join and add this phone's lists</button>`
        : `<button class="btn primary" data-sync="join" data-id="${esc(f.id)}" data-testid="family-join">Join and add this phone's lists</button>
           <button class="btn" data-sync="join-family" data-id="${esc(f.id)}" data-testid="family-join-theirs">Join and use only the family's lists</button>`;
    return `<div class="card family-choice" data-testid="family-choice">
      <strong>${esc(f.name)}</strong>
      <span class="small">Started by <strong>${esc(f.ownerEmail)}</strong> · ${f.emails.length} ${f.emails.length === 1 ? "person" : "people"}</span>
      ${takeFamily && used ? `<span class="small muted">The lists on this phone came from ${c.otherAccountData ? "a different Google account" : "another family space"}.</span>` : ""}
      ${buttons}
    </div>`;
  }).join("");
  modal("choose-family", `<div class="stack">
    <h2>Join a family space?</h2>
    <p class="small">${list.length === 1 ? "A family space lists" : "These family spaces list"} <strong>${esc(c.user?.email || "")}</strong>. Join only if you know who started it: everyone in it sees the lists.</p>
    ${rows}
    <button class="btn ghost" data-sync="none" data-testid="family-decline">None of these</button>
    <button class="btn ghost" data-sync="signout" data-testid="family-signout">Sign out</button>
  </div>`, async (act, dlg, b) => {
    if (act === "join" || act === "join-family") { dlg.close(); cloud.joinFamily(b.dataset.id, { useFamilyData: act === "join-family" }); }
    else if (act === "none") { dlg.close(); noFamilyDialog(cloud.getCloud()); }
    else if (act === "signout") { dlg.close(); await cloud.signOutCloud(); }
  });
}

function profileDialog({ focusKey = false } = {}) {
  const c = cloud.getCloud();
  const hasKey = !!getAiKey();
  const aiKey = `<details ${focusKey ? "open" : ""} data-testid="ai-key-section"><summary class="small">Claude API key (AI recipes and week planning)${hasKey ? " · added" : ""}</summary>
      ${hasKey ? "" : `<div class="key-steps" data-testid="ai-key-steps">
        <p class="small"><strong>Get a key in about two minutes:</strong></p>
        <ol class="small">
          <li>Sign in or sign up at the Claude Console (a Claude.ai subscription doesn't include it; the API is billed on its own).</li>
          <li>Under <strong>Billing</strong>, add some credit ($5 covers many weekly plans) and set a monthly spend limit.</li>
          <li>Under <strong>API Keys</strong>, tap <strong>Create Key</strong>, copy it and paste it below.</li>
        </ol>
        <a class="btn sm primary" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" data-testid="ai-key-get">🔑 Get a Claude key</a>
      </div>`}
      <p class="small muted">Kept only in this browser. It is never synced to the family or put in backups. Each phone adds the key once.</p>
      <label class="field"><span>API key</span><input name="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? "Saved. Paste a new key to replace it" : "sk-ant-…"}" data-testid="ai-key"></label>
      <p class="small" data-testid="ai-key-status" role="status"></p>
      <div class="row"><button type="button" class="btn sm" data-sync="aikey-save" data-testid="ai-key-save">Save key</button>${hasKey ? '<button type="button" class="btn sm ghost" data-sync="aikey-remove" data-testid="ai-key-remove">Remove key</button>' : ""}</div>
    </details>`;
  // Each child's name, then what their food has to suit: a gassy tummy, iron-fortified cereal, no egg...
  const needs = (who) => {
    const p = prefsFor(state.settings, who);
    return `<div class="field"><span>What ${who === "baby" ? "the baby's" : "their"} food should suit</span>
      <div class="chips" data-testid="${who}-prefs">${PREF_OPTIONS[who].map((o) => `<label class="chk" style="min-height:0" title="${esc(o.hint || "")}"><input type="checkbox" name="${who}Pref" value="${o.id}" ${p.tags.has(o.id) ? "checked" : ""} data-testid="${who}-pref-${o.id}"> ${esc(o.label)}</label>`).join("")}</div></div>
      <label class="field"><span>Never use (comma separated)</span><input name="${who}Avoid" value="${esc(p.avoid.join(", "))}" maxlength="300" placeholder="${who === "baby" ? "e.g. ragi, brinjal" : "e.g. mushroom, bitter gourd"}" data-testid="${who}-avoid"></label>
      <label class="field"><span>Anything else for recipes (optional)</span><input name="${who}Note" value="${esc(p.note)}" maxlength="200" placeholder="${who === "baby" ? "e.g. started egg last week, loves pear" : "e.g. doesn't like brinjal"}" data-testid="${who}-pref-note"></label>`;
  };
  const prefCount = ["baby", "kid"].reduce((n, w) => { const p = prefsFor(state.settings, w); return n + p.tags.size + p.avoid.length + (p.note ? 1 : 0); }, 0);
  const names = `<details ${state.settings.kidName ? "" : "open"} data-testid="family-names"><summary class="small">Children's names and needs${prefCount ? ` · ${prefCount} set` : ""}</summary>
      <p class="small muted">Saved with the family's data, not in the app's public code. Suggestions, recipes and the AI follow each child's needs.</p>
      <label class="field"><span>4-year-old</span><input name="kidName" value="${esc(state.settings.kidName || "")}" maxlength="30" data-testid="kid-name"></label>
      ${needs("kid")}
      <label class="field"><span>8-month-old</span><input name="babyName" value="${esc(state.settings.babyName || "")}" maxlength="30" data-testid="baby-name"></label>
      ${needs("baby")}
      <button type="button" class="btn sm" data-sync="names" data-testid="save-names">Save names and needs</button>
    </details>`;
  const fryer = state.settings.airFryer || "";
  const appliances = `<details ${fryer || state.settings.oven ? "" : "open"} data-testid="appliances-section"><summary class="small">Cooking appliances${appliancesOwned().length ? " · " + esc(appliancesOwned().map((k) => APPLIANCES[k].label).join(", ")) : ""}</summary>
      <p class="small muted">Recipes and suggestions use these for quicker cooking: air fryer and oven times, and both baskets at once.</p>
      <div class="field"><span>🍟 Air fryer</span>${chipRadios("airFryer", [["dual", "Two baskets (Ninja dual zone)"], ["single", "One basket"], ["", "None"]], fryer, "air-fryer")}</div>
      <label class="chk" style="min-height:0"><input type="checkbox" name="oven" ${state.settings.oven ? "checked" : ""} data-testid="has-oven"> ♨️ Oven</label>
      <button type="button" class="btn sm" data-sync="appliances" data-testid="save-appliances">Save appliances</button>
    </details>`;
  const picked = cuisinePicks();
  const cuisines = `<details ${picked.length ? "" : "open"} data-testid="cuisine-section"><summary class="small">Cuisines we cook${picked.length ? " · " + esc(picked.map((id) => CUISINES.find((x) => x.id === id).label.replace(/ \(.*\)/, "")).join(", ")) : ""}</summary>
      <p class="small muted">Suggestions and top picks come mostly from these. Leave them all off to see every cuisine.</p>
      <div class="chips">${CUISINES.map((x) => `<label class="chk" style="min-height:0"><input type="checkbox" name="cuisine" value="${x.id}" ${picked.includes(x.id) ? "checked" : ""} data-testid="cuisine-${x.id}"> ${esc(x.label)}</label>`).join("")}</div>
      <button type="button" class="btn sm" data-sync="cuisines" data-testid="save-cuisines">Save cuisines</button>
    </details>`;
  const fam = c.family;
  const members = fam ? `<div class="stack" data-testid="family-members">
      <strong class="small">Family members</strong>
      <ul class="members">${fam.emails.map((e) => `<li data-testid="family-member"><span class="grow">${esc(e)}${e === fam.ownerEmail ? ' <span class="muted">(started it)</span>' : ""}${e === c.user?.email ? ' <span class="muted">(you)</span>' : ""}</span>${e !== fam.ownerEmail ? `<button type="button" class="btn ghost sm" data-sync="remove" data-email="${esc(e)}" aria-label="Remove ${esc(e)}" data-testid="member-remove">Remove</button>` : ""}</li>`).join("")}</ul>
      <label class="field"><span>Add someone by their Google email</span><input name="member" type="email" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="name@gmail.com" data-testid="member-email"></label>
      <button type="button" class="btn sm" data-sync="add" data-testid="member-add">Add to family</button>
      <p class="small muted">They sign in on their phone with that Google account and see the same lists.</p>
    </div>` : "";
  const top = !c.configured
    ? `<p class="small muted">Family sync isn't set up in this copy of the app, so your data is saved on this phone only. Download a backup to move it to another phone.</p>`
    : !c.user
    ? `<p class="small muted">Not signed in. Your data is saved on this device only.</p>
       <button type="button" class="btn primary" data-sync="google" data-testid="profile-google">Sign in with Google to sync</button>`
    : `<div class="row">${c.user.photo ? `<img class="avatar-img" src="${esc(c.user.photo)}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : ""}<div class="grow"><strong data-testid="profile-name">${esc(c.user.name || c.user.email)}</strong><div class="small muted">${esc(c.user.email)}</div></div></div>
       ${c.status === "no-family" || c.status === "choose" ? '<button type="button" class="btn primary" data-sync="setup" data-testid="profile-setup">Set up family sync</button>' : ""}`;
  modal("profile-dialog", `<form class="stack">
    <h2>Profile</h2>
    ${top}
    ${c.configured ? `<p class="small sync-status" data-testid="cloud-status-text" role="status">${esc(cloudStatusText(c))}</p>` : ""}
    ${members}
    ${names}
    ${cuisines}
    ${appliances}
    ${aiKey}
    <p class="small muted">A backup file is still handy: <button type="button" class="linkish" data-sync="export" data-testid="profile-export">Export backup</button></p>
    <div class="row between">
      ${c.user ? '<button type="button" class="btn ghost sm" data-sync="signout" data-testid="cloud-signout">Sign out of this phone</button>' : ""}
      <button type="button" class="btn ghost sm" data-sync="close">Close</button>
    </div>
  </form>`, async (act, dlg, b) => {
    const st = dlg.querySelector("[data-testid=cloud-status-text]");
    switch (act) {
      case "google": cloudSignIn(b); break;
      case "setup": dlg.close(); cloud.checkFamilyAgain(); break;
      case "names": {
        const f = dlg.querySelector("form").elements;
        const picks = (who) => [...dlg.querySelectorAll(`input[name=${who}Pref]:checked`)].map((i) => i.value);
        const prefs = cleanPrefs({ baby: { tags: picks("baby"), note: f.babyNote.value, avoid: f.babyAvoid.value }, kid: { tags: picks("kid"), note: f.kidNote.value, avoid: f.kidAvoid.value } });
        state.settings = { ...state.settings, kidName: f.kidName.value.trim(), babyName: f.babyName.value.trim(), prefs };
        ui.suggest = {};
        commit();
        toast(Object.keys(prefs).length ? "Saved. Suggestions now follow each child's needs." : "Names saved.");
        break;
      }
      case "appliances": {
        const f = dlg.querySelector("form").elements;
        const fryer = dlg.querySelector("input[name=airFryer]:checked")?.value || "";
        state.settings = { ...state.settings, airFryer: ["dual", "single"].includes(fryer) ? fryer : "", oven: f.oven.checked };
        ui.suggest = {};
        commit();
        toast("Appliances saved. Recipes will use them.");
        profileDialog();
        break;
      }
      case "cuisines": {
        const cuisines = [...dlg.querySelectorAll("input[name=cuisine]:checked")].map((i) => i.value);
        state.settings = { ...state.settings, cuisines };
        commit();
        dlg.close();
        toast(cuisines.length ? "Cuisines saved. Suggestions now lean toward them." : "Showing every cuisine.");
        break;
      }
      case "add": {
        const input = dlg.querySelector("[name=member]");
        try { await cloud.addMember(input.value); toast(`Added ${input.value.trim().toLowerCase()} to the family.`); profileDialog(); }
        catch (err) { st.textContent = "⚠️ " + err.message; }
        break;
      }
      case "remove":
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to remove"; break; }
        try { await cloud.removeMember(b.dataset.email); toast(`Removed ${b.dataset.email}.`); profileDialog(); }
        catch (err) { st.textContent = "⚠️ " + err.message; }
        break;
      case "export": downloadBackup(); break;
      case "signout": await cloud.signOutCloud(); dlg.close(); toast("Signed out. Your data is still on this phone."); break;
      case "aikey-save": {
        const k = dlg.querySelector("form").elements.aiKey.value.trim();
        const status = dlg.querySelector("[data-testid=ai-key-status]");
        if (!looksLikeKey(k)) { status.textContent = "⚠️ That doesn't look like a Claude API key. It starts with sk-ant-."; break; }
        setAiKey(k);
        dlg.close();
        toast("API key saved on this device.");
        ui.ai = "unknown"; renderHeader(); checkAi();
        break;
      }
      case "aikey-remove":
        setAiKey("");
        dlg.close();
        toast("API key removed from this device.");
        ui.ai = "unknown"; renderHeader(); checkAi();
        break;
      case "close": dlg.close(); break;
    }
  });
}

// Other phones' changes were merged into `state`: save them here and redraw, but not while
// someone is typing in the page (the redraw would wipe what they're typing).
let redrawWaiting = false;
function onRemoteChange() {
  save(state, { now: true });
  clearCaches();
  const typing = document.activeElement?.matches?.("#main input, #main textarea, #main select");
  if (!typing) { render(); return; }
  if (redrawWaiting) return;
  redrawWaiting = true;
  document.activeElement.addEventListener("blur", () => { redrawWaiting = false; setTimeout(render, 0); }, { once: true });
}

function startFamilySync() {
  cloud.startCloud({
    getState: () => state,
    onRemoteChange,
    onStatus: (c) => {
      if (c.user && $("[data-testid=cloud-login]")) hideLogin();   // signed in (also after a redirect sign-in)
      renderSyncButtons();
    },
    onNoFamily: (c, opts) => noFamilyDialog(c, opts),
    onChooseFamily: (c, list) => chooseFamilyDialog(c, list),
    // Start a family space clean: this phone's lists belong to another account's family.
    resetLocal: () => {
      const fresh = defaultState();
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, fresh);
    },
    // Two phones' lists can both have "ghee": combine same-name items after the first sync.
    tidyAfterFirstSync: (st) => {
      const before = JSON.stringify(st.shopping);
      st.shopping = mergeItems(st.shopping).map((i) => ({ ...i, id: i.id || uid() }));
      return JSON.stringify(st.shopping) !== before;
    },
    onFirstSync: ({ hadFamilyData, uploaded }) => {
      toast(hadFamilyData ? (uploaded ? "Synced: this phone's data was added to the family's." : "Synced with your family ✅") : "Family sync is on. This phone's data is now in the cloud ✅");
    },
  });
}

function setTab(tab) {
  ui.tab = tab;
  if (tab !== "shopping") document.body.classList.remove("in-store");
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + tab;
  try { history.replaceState(null, "", location.pathname + location.search + "#" + tab); } catch {}
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  renderHeader();
  const fn = { calendar: renderCalendar, recipes: renderRecipes, shopping: renderShopping, frozen: renderFrozen, reminders: renderReminders }[ui.tab];
  fn();
}

// ---------- calendar ----------
function calCell(c, wk) {
  const st = dayStatus(state, c.key);
  const pending = pend(c.key);
  const rems = remsOn(c.key).length;
  const cls = ["cal-cell", c.inMonth ? "" : "out", c.key === TODAY ? "today" : "", c.key === ui.selected ? "sel" : ""].join(" ");
  const label = `${prettyDate(c.key)}: ${st === "approved" ? "approved" : st === "pending" ? "waiting for approval" : "no plan"}${pending.length ? ", " + pending.length + " pending" : ""}`;
  return `<button type="button" class="${cls}" data-action="select-day" data-date="${c.key}" data-wk="${wk}" data-testid="cal-day-${c.key}" data-status="${st}" data-pending="${pending.length}" aria-label="${esc(label)}">
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
  if (cell) cell.outerHTML = calCell({ key, day: Number(key.slice(8)), inMonth: key.slice(0, 7) === ui.month.slice(0, 7) }, cell.dataset.wk);
  $("#cal-upcoming").innerHTML = renderUpcomingPending();
  $("#cal-day").innerHTML = renderDayPanel(ui.selected);
}

function renderCalendar() {
  const cells = monthGrid(ui.month);
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const grid = cells.map((c, i) => calCell(c, Math.floor(i / 7))).join("");
  const at = cells.findIndex((c) => c.key === ui.selected);
  const week = ui.calView === "week";

  // On a phone the chosen day comes straight after the month; the pending list and backup are folded away below it.
  $("#view-calendar").innerHTML = `
    <div class="cal-layout">
      <div class="card cal-month">
        <div class="cal-head">
          <h2 data-testid="cal-month">${esc(monthLabel(ui.month))}</h2>
          <div class="row">
            <button class="btn sm" data-action="goto-today" data-testid="cal-today">Today</button>
            <button class="btn sm round" data-action="month" data-delta="-1" aria-label="Previous ${week ? "week" : "month"}" data-testid="cal-prev">‹</button>
            <button class="btn sm round" data-action="month" data-delta="1" aria-label="Next ${week ? "week" : "month"}" data-testid="cal-next">›</button>
          </div>
        </div>
        <div class="cal-grid ${ui.calView}" data-testid="cal-grid" data-wk="${Math.max(0, Math.floor(at / 7))}">
          ${dows.map((d) => `<div class="cal-dow">${d.slice(0, 2)}</div>`).join("")}
          ${grid}
        </div>
        <button type="button" class="cal-view" data-action="cal-view" data-testid="cal-view" aria-expanded="${!week}">${week ? "Show the whole month" : "Show one week"}<span class="chev" aria-hidden="true"></span></button>
        <div class="week-plan" data-testid="week-plan">
          <button type="button" class="btn sm" data-action="fill-week" data-testid="fill-week"aria-label="Fill the week from the kitchen">📋 Fill from kitchen</button>
          <button type="button" class="btn sm primary" data-action="plan-chat" data-testid="plan-chat-open"aria-label="Plan the week with AI">💬 Plan with AI</button>
        </div>
        <button type="button" class="linkish small clear-week" data-action="clear-week" data-testid="clear-week">🗑️ Clear this week's meals</button>
        <div class="legend">
          <span><i class="dot approved"></i>Approved</span>
          <span><i class="dot pending"></i>To approve</span>
          <span><i class="dot empty"></i>No plan</span>
          <span><b class="badge">2</b>Pending</span>
        </div>
      </div>
      <div id="cal-day">${renderDayPanel(ui.selected)}</div>
      <div class="cal-more">
        <div id="cal-upcoming">${renderUpcomingPending()}</div>
        ${renderBackupCard()}
      </div>
    </div>`;
}

function renderUpcomingPending() {
  const rows = [];
  for (let i = -7; i <= 13; i++) {
    const k = addDays(TODAY, i);
    const p = pend(k);
    if (p.length) rows.push({ k, p });
  }
  const late = rows.filter(({ k }) => k < TODAY).length;
  return section({
    id: "sec-upcoming", icon: "🗓️", title: "Pending, next two weeks", testid: "upcoming-pending",
    meta: rows.length ? `${rows.length} date${rows.length > 1 ? "s" : ""}${late ? ` · ${late} overdue` : ""}` : "All clear",
    body: rows.length ? rows.map(({ k, p }) => `<div class="pend-row">
      <button class="btn ghost sm" data-action="select-day" data-date="${k}">${k < TODAY ? "⚠️ " : ""}${esc(prettyDate(k))}${k === TODAY ? " (today)" : ""}</button>
      <span class="small muted grow">${p.map((x) => esc(x.text)).join(" · ")}</span>
    </div>`).join("") : '<p class="muted small">Nothing pending in the next two weeks.</p>',
  });
}

function renderBackupCard() {
  return section({
    id: "sec-backup", icon: "💾", title: "Backup", meta: cloud.getCloud().ready ? "Synced with your family" : "Saved on this phone",
    body: `<p class="small muted">${cloud.getCloud().ready ? "Everything syncs with your family on its own. A backup file is a copy you keep yourself." : "Everything is saved on this device. Download a backup to move it to another phone or browser."}</p>
    <div class="row">
      <button class="btn sm" data-action="export" data-testid="export">Download backup</button>
      <label class="btn sm">Restore backup<input type="file" accept="application/json" data-action="import" hidden data-testid="import"></label>
    </div>`,
  });
}

function slotDatalist(who) {
  const list = [...state.savedRecipes, ...LIBRARY].filter((r) => r.forWhom === who || r.forWhom === "family" || (who === "family"));
  const seen = new Set();
  return list.filter((r) => !seen.has(r.title) && seen.add(r.title)).map((r) => `<option value="${esc(r.title)}">`).join("");
}

// What goes in the school snack box: cheese, or a ragi cookie.
const SNACK_BOX = /cheese|ragi cookie/i;
// A planned meal or recipe with ragi (finger millet) in its title or ingredients.
const hasRagi = (m) => {
  const r = m?.recipeId ? findRecipe(m.recipeId) || m : m;
  return /ragi|finger millet|nachni/i.test([r?.title, ...(r?.ingredients || []).map((i) => typeof i === "string" ? i : i?.name)].join(" "));
};

// Suggested meals for the empty slots of a date, built from what's in the kitchen.
// Picks are safety-checked for the slot, avoid repeating the day before, and rotate with `seed`.
function suggestionsFor(key) {
  const day = getDay(state, key) || emptyDay();
  const entry = ui.suggest[key] || (ui.suggest[key] = { seed: 0, offsets: {}, picks: null });
  if (entry.picks) return entry.picks;
  entry.chosen ||= {};
  entry.vegOptions = {};
  const cuisines = cuisinePicks();
  // A curry cooked the day before becomes one of today's meals (roti quesadilla, kathi roll, kari dosa).
  const leftovers = leftoversFrom(addDays(key, -1));
  entry.leftover = {};
  entry.rotation = {};
  const prev = getDay(state, addDays(key, -1));
  const avoid = new Set(Object.values(prev?.meals || {}).map((m) => m?.recipeId).filter(Boolean));
  // Everything planned in the 6 days before: the same lunch shouldn't come back every day of the week.
  const recentFor = (days) => new Set(Array.from({ length: days }, (_, i) => i + 1).flatMap((n) => Object.values(getDay(state, addDays(key, -n))?.meals || {}).map((m) => m?.recipeId)).filter(Boolean));
  const lastWeek = recentFor(6);
  const lately = recentFor(REGULAR_GAP_DAYS);
  const used = new Set(Object.values(day.meals || {}).map((m) => m?.recipeId).filter(Boolean));
  const picks = {};
  // Food past the use-by date typed in for it is gone by this day.
  const gone = new Set(goneBy(state.pantry, pantryDates(), { today: TODAY, onKey: key }));
  const pantry = state.pantry.filter((p) => !gone.has(p));
  for (const s of slotsFor(key)) {
    if (day.meals?.[s.id]?.title) continue;
    const meal = s.id.split("_")[1];
    const child = s.who === "family" ? "" : s.who;
    // The recipes the parent marked to use often for this person and this meal (Recipes tab, by age).
    const often = regularsFor(state.settings, s.who).filter((id) => { const r = findRecipe(id); return r && (r.mealType === meal || (meal === "lunchbox" && r.mealType === "lunch")); });
    const opt = { forWhom: s.who, schoolNutFree: nutFreeOn(), limit: 40, cuisines, frozen: frozenOnHand(), appliances: appliancesOwned(), staples: staplesOn(), useSoon: useSoonOn(key, picks), settings: state.settings, child, regulars: often };
    const seen = new Set();
    const safe = (r) => checkRecipe(r, { age: s.who === "baby" ? "baby" : "kid", lunchbox: s.id === "kid_lunchbox" || s.id === "kid_snack", schoolNutFree: nutFreeOn() }).safe && !prefProblem(r, child, state.settings);
    // The school lunch goes round the 4-year-old's list in order, skipping the ones the kitchen can't make.
    // Yesterday's curry makeover goes in another meal instead.
    if (s.id === "kid_lunchbox") {
      const ok = (id) => { const r = findRecipe(id); return !!r && safe(r); };
      const turn = lunchTurn(key, { days: state.days, today: TODAY, kitchen: [...pantry, ...frozenOnHand()], ok }).filter((id) => !used.has(id));
      if (turn.length) {
        picks[s.id] = turn[(entry.seed + (entry.offsets[s.id] || 0)) % turn.length];
        used.add(picks[s.id]);
        (entry.rotation ||= {})[s.id] = true;
        continue;
      }
    }
    // The family dinner comes from the kitchen: fresh vegetables first, at least VEG_CURRY_MIN
    // vegetable curries to go round with 🔀, never yesterday's leftovers or the freezer alone.
    if (s.who === "family") {
      const all = familyDinnerIdeas(pantry, { frozen: frozenOnHand(), staples: staplesOn(), cuisines, useSoon: opt.useSoon, settings: state.settings, appliances: appliancesOwned() });
      const ideas = all.filter(safe);
      const notUsed = ideas.filter((r) => !used.has(r.id));
      const tier = [notUsed.filter((r) => !lastWeek.has(r.id)), notUsed.filter((r) => !avoid.has(r.id)), ideas].find((t) => t.length) || [];
      const pool = withVegCurries(tier, { fill: all.fill });
      if (!pool.length) continue;
      // Each 🔀 turn shows a dinner not shown yet this time round (the ranking can shift as the
      // other slots change), and the same turn keeps its dinner when the panel redraws.
      const turn = entry.seed + (entry.offsets[s.id] || 0);
      const shown = ((entry.shown ||= {})[s.id] ||= {});
      const chosen = findRecipe(entry.chosen[s.id]);
      // Vegetables already shown this time round: each turn brings a new one.
      const before = new Set(Object.entries(shown).filter(([n]) => +n !== turn).map(([, id]) => findRecipe(id)).filter(Boolean).map(mainVegOf));
      // Down the ranked list, so no vegetable in the kitchen is skipped.
      let r = chosen && ideas.includes(chosen) ? chosen : pool.find((x) => x.id === shown[turn]) || pool.find((x) => !before.has(mainVegOf(x)));
      if (!r) {
        // Every vegetable has had its turn: start a new round, still not the one just shown.
        const last = findRecipe(shown[turn - 1]);
        for (const n of Object.keys(shown)) delete shown[n];
        r = pool.find((x) => !last || mainVegOf(x) !== mainVegOf(last)) || pool[0];
      }
      shown[turn] = r.id;
      picks[s.id] = r.id;
      used.add(r.id);
      // The other vegetable curries, each with a vegetable of its own, to pick one in a tap.
      entry.vegOptions[s.id] = oneEachVeg(tier.filter(isVegCurry)).filter((x) => mainVegOf(x) !== mainVegOf(r)).slice(0, VEG_CURRY_MIN).map((x) => x.id);
      continue;
    }
    // One leftover idea a day, in the first slot it fits. 🔀 on that slot moves on to the usual ideas.
    if (leftovers.length && !Object.keys(entry.leftover).length && !entry.offsets[s.id]) {
      const ideas = leftovers.flatMap((l) => leftoverRecipesFor(l.kind, { cuisines }).map((r) => ({ r, l })))
        .filter(({ r }) => r.forWhom === s.who && (r.mealType === meal || (meal === "lunchbox" && r.mealType === "lunch")) && !used.has(r.id) && !lastWeek.has(r.id) && safe(r));
      if (ideas.length) {
        const { r, l } = ideas[entry.seed % ideas.length];
        picks[s.id] = r.id;
        used.add(r.id);
        entry.leftover[s.id] = l.title;
        continue;
      }
    }
    // School-day mornings are rushed: breakfast is made the night before or needs no cooking.
    const busyMorning = meal === "breakfast" && isSchoolDay(key);
    // The 4-year-old eats the family breakfast too (overnight oats, peanut butter toast).
    const fits = (r) => r.forWhom === s.who || (s.id === "kid_breakfast" && r.forWhom === "family" && r.mealType === "breakfast");
    let candidates = suggestFromLibrary(pantry, { ...opt, mealType: meal, busyMorning })
      .concat(suggestFromLibrary(pantry, opt))
      .filter((r) => fits(r) && !r.leftover && !seen.has(r.id) && seen.add(r.id))
      .filter(safe)
      // Nothing that can't be ready that morning: no baking on a school day, and a weekend batch only while it keeps.
      .filter((r) => meal !== "breakfast" || fitsMorning(r, key, appliancesOwned()));
    if (busyMorning && candidates.some((r) => r.busyMorning)) candidates = candidates.filter((r) => r.busyMorning);
    // The school snack box is tiny: on school days it is cheese or a ragi cookie, and no ragi cookie when breakfast already had ragi.
    if (s.id === "kid_snack" && isSchoolDay(key)) {
      const breakfast = day.meals?.kid_breakfast?.title ? day.meals.kid_breakfast : findRecipe(picks.kid_breakfast);
      const box = candidates.filter((r) => r.snackBox && SNACK_BOX.test(r.title) && !(hasRagi(r) && hasRagi(breakfast)));
      if (box.length) candidates = box;
    }
    // Steer the 4-year-old's empty slots toward the daily goal: an egg at breakfast, milk in the lunchbox, nuts in the snack.
    let goal = null;
    if (s.who === "kid") {
      const want = { kid_breakfast: "egg", kid_lunchbox: "dairy", kid_snack: "nuts" }[s.id];
      const goals = kidGoals(key, picks);
      const missing = GOALS.filter((g) => !goals[g]);
      goal = missing.includes(want) ? want : missing.find((g) => candidates.some((r) => r.tags?.includes(g)));
    }
    const withGoal = (list) => (goal ? list.filter((r) => r.tags?.includes(goal)) : []);
    // Something not planned this week, else not yesterday, else anything; within each, the goal first.
    // A recipe used often may come back after REGULAR_GAP_DAYS instead of a week, and comes first.
    const notUsed = candidates.filter((r) => !used.has(r.id));
    const oftenSet = new Set(often);
    const fresh = (r) => !(oftenSet.has(r.id) ? lately : lastWeek).has(r.id);
    const tiers = [notUsed.filter(fresh), notUsed.filter((r) => !avoid.has(r.id)), candidates].map((t) => regularsFirst(t, often));
    const tier = tiers.find((t) => t.length) || [];
    const best = withGoal(tier).length ? withGoal(tier) : tier;
    const pool = (best.length ? best : candidates).slice(0, 6);
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

// ---------- planning a whole week ----------
// The days of the week on screen, from today on.
function weekDates() {
  const win = planWindow(ui.selected, TODAY);
  return win.dates.filter((k) => k <= win.weekEnd);
}

// Copies of the days about to change, so the change can be undone in one tap.
function snapshotDays(keys) {
  const days = Object.fromEntries(keys.map((k) => [k, state.days[k] ? structuredClone(state.days[k]) : null]));
  const savedIds = new Set(state.savedRecipes.map((r) => r.id));
  return () => {
    for (const [k, d] of Object.entries(days)) { if (d) state.days[k] = d; else delete state.days[k]; }
    state.savedRecipes = state.savedRecipes.filter((r) => savedIds.has(r.id));
    commit();
  };
}

// Takes out a date's planned meals that a child mustn't have: a food on their never-use list or
// a hard need from Profile (no egg, no dairy). Meals planned before the list was set, or on another
// phone, stay on the calendar otherwise, and filling only fills empty slots. Returns how many.
function dropUnsuitable(key) {
  const d = getDay(state, key);
  if (!d?.meals) return 0;
  let n = 0;
  for (const s of slotsFor(key)) {
    const m = d.meals[s.id];
    if (!m?.title || s.who === "family") continue;
    const r = (m.recipeId && findRecipe(m.recipeId)) || { title: m.title, ingredients: [] };
    if (!prefProblem({ ...r, title: m.title }, s.who, state.settings)) continue;
    delete d.meals[s.id];
    n++;
  }
  if (n) markEdited(d);
  return n;
}

// 🔀 on a planned meal: swaps it for the next kitchen idea for that slot, as 🔀 does on a
// suggestion. Each tap moves one idea further along; Undo puts the planned meal back.
function swapMeal(key, slot) {
  const d = ensureDay(key);
  const old = d.meals[slot];
  if (!old?.title) return;
  const undo = snapshotDays([key]);
  delete d.meals[slot];
  const e = ui.suggest[key] || (ui.suggest[key] = { seed: 0, offsets: {}, picks: null });
  if (e.chosen) delete e.chosen[slot];
  let r = null;
  for (let i = 0; i < 6 && !r; i++) {
    e.offsets[slot] = (e.offsets[slot] || 0) + 1;
    e.picks = null;
    const pick = findRecipe(suggestionsFor(key)[slot]);
    if (pick && pick.id !== old.recipeId && pick.title !== old.title) r = pick;
  }
  e.picks = null;
  if (!r) { d.meals[slot] = old; return toast("No other idea from the kitchen for this meal right now."); }
  d.meals[slot] = { recipeId: r.id, title: r.title, forWhom: r.forWhom };
  markEdited(d);
  commitDay(key);
  toast(`Swapped ${old.title} for ${r.title}.`, undo);
}

const mealCount = (n) => `${n} meal${n > 1 ? "s" : ""}`;

// Without AI: the kitchen suggestions for every empty meal of the week, a day at a time so each
// day sees the one before it (no repeats, yesterday's curry as a leftover makeover). Meals that
// break a child's needs are swapped for new ones first.
function fillWeek() {
  const keys = weekDates();
  const undo = snapshotDays(keys);
  let n = 0, swapped = 0;
  for (const k of keys) swapped += dropUnsuitable(k);
  for (const k of keys) {
    delete ui.suggest[k];
    n += applySuggestions(k);
  }
  commit();
  const swaps = swapped ? `Swapped out ${mealCount(swapped)} the children shouldn't have. ` : "";
  toast(n || swapped ? `${swaps}Added ${mealCount(n)} to ${keys.length} day${keys.length > 1 ? "s" : ""}. Approve each day when ready.` : "Every meal this week is already planned.", n || swapped ? undo : null);
}

// Takes every planned meal off the week on screen, from today on, to plan it again from scratch.
// To-dos, reminders, the kitchen and the recipe book stay as they are; Undo puts the meals back.
function clearWeek() {
  const keys = weekDates();
  const undo = snapshotDays(keys);
  let n = 0;
  for (const k of keys) {
    const d = getDay(state, k);
    const planned = Object.keys(d?.meals || {}).filter((slot) => d.meals[slot]?.title);
    if (!planned.length) continue;
    d.meals = {};
    markEdited(d);
    delete ui.suggest[k];
    n += planned.length;
  }
  if (!n) return toast("No meals planned this week yet.");
  commit();
  toast(`Cleared ${mealCount(n)} from this week. Tap 📋 Fill from kitchen to plan it again.`, undo);
}

const planCatalog = () => (planCatalog.text ||= catalogText(LIBRARY));

function chatRefs() {
  return new Map([...libraryRefs(LIBRARY), ...savedRefs(state.savedRecipes)]);
}

function chatContext(win, refs) {
  const back = new Map([...refs].map(([ref, r]) => [r.id, ref]));
  const cookable = readyToCook(state.pantry, { maxMissing: 0, schoolNutFree: nutFreeOn(), limit: 60, cuisines: cuisinePicks(), frozen: frozenOnHand(), staples: staplesOn(), useSoon: useSoonOn(TODAY), settings: state.settings })
    .map((x) => back.get(x.recipe.id)).filter(Boolean);
  return contextText({
    today: TODAY, window: win, days: state.days, refOf: (m) => back.get(m.recipeId) || "",
    pantry: state.pantry, frozen: frozenOnHand(), appliances: applianceRequest(state.settings), schoolNutFree: nutFreeOn(),
    cuisines: cuisinePicks().map((id) => CUISINES.find((x) => x.id === id).label), cookable,
    saved: [...savedRefs(state.savedRecipes)], expiry: expiryList(), staples: staplesOn(), needs: prefsPrompt(state.settings),
  });
}

const CHAT_IDEAS = ["Plan this week", "Use up what runs out first", "Weekend prep for school breakfasts", "No eggs this week", "Swap Tuesday's dinner", "Use what's in the freezer", "Plan next week"];

function chatMessageHtml(m, i) {
  if (m.role === "parent") return `<div class="chat-msg parent" data-testid="chat-parent">${esc(m.text)}</div>`;
  if (m.role === "error") return `<div class="chat-msg error" data-testid="chat-error">⚠️ ${esc(m.text)}</div>`;
  const label = (c) => `${esc(prettyDate(c.date))} · ${esc(slotLabel(SLOTS.find((s) => s.id === c.slot), state.settings))}`;
  return `<div class="chat-msg claude" data-testid="${m.role === "app" ? "chat-app" : "chat-claude"}">
    <p>${esc(m.text)}</p>
    ${m.applied?.length ? `<ul class="chat-changes" data-testid="chat-changes">${m.applied.map((c) => `<li>${art(c.recipe || {}, "xs", "✕")} ${label(c)}: <strong>${c.recipe ? esc(c.recipe.title) : "cleared"}</strong>${c.isNew ? ' <span class="pill">new</span>' : ""}</li>`).join("")}</ul>` : ""}
    ${m.skipped?.length ? `<p class="small" data-testid="chat-skipped" style="color:var(--warn)">Left out: ${m.skipped.map((c) => `${esc(c.title || c.slot)}${c.date ? ` (${esc(c.date)})` : ""}: ${esc(c.why)}`).join("; ")}</p>` : ""}
    ${m.applied?.length ? (m.undone ? '<p class="small muted">Undone.</p>' : `<button type="button" class="btn sm ghost" data-action="chat-undo" data-i="${i}" data-testid="chat-undo">↩️ Undo these changes</button>`) : ""}
  </div>`;
}

function renderChat(dlg = $("dialog[data-testid=plan-chat]")) {
  if (!dlg) return;
  const c = ui.chat;
  const log = dlg.querySelector("[data-testid=chat-log]");
  log.innerHTML = c.shown.length ? c.shown.map(chatMessageHtml).join("") + (c.busy ? '<div class="chat-msg claude busy" data-testid="chat-busy">Planning… this can take a minute or two.</div>' : "")
    : `<p class="small muted">Ask for a plan for the week, then change it as you like: “no eggs this week”, “swap Tuesday's dinner”, “something with the frozen peas”. The meals go straight onto the calendar, waiting for your approval. Safety rules for both children, the nut-free lunchbox and warm weekday breakfasts are always kept.</p>`;
  log.scrollTop = log.scrollHeight;
  dlg.querySelector("[data-testid=chat-send]").disabled = c.busy;
  dlg.querySelector("[data-testid=chat-reset]").hidden = !c.shown.length;
}

function planChatSheet() {
  if (!getAiKey()) {
    sheet("plan-chat", `<div class="stack">
      <div class="row between"><h2>💬 Plan the week with AI</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
      <p class="small">The planning chat uses your own Claude API key. Add one in Profile (it takes a couple of minutes), then come back here.</p>
      <p class="small muted">Without AI, <strong>📋 Fill the week from the kitchen</strong> on the calendar plans every empty meal from your recipe book.</p>
      <button type="button" class="btn primary big" data-action="open-ai-key" data-testid="chat-add-key">Add a Claude API key</button>
    </div>`);
    return;
  }
  const dlg = sheet("plan-chat", `<form data-form="plan-chat" class="stack chat">
    <div class="row between"><h2>💬 Plan the week with AI</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <div class="chat-log" data-testid="chat-log" aria-live="polite"></div>
    <div class="chips scroll-x">${CHAT_IDEAS.map((t) => `<button type="button" class="chip add" data-action="chat-idea" data-text="${esc(t)}" data-testid="chat-idea">${esc(t)}</button>`).join("")}</div>
    <div class="chat-input">
      <textarea name="text" rows="2" maxlength="1000" placeholder="e.g. Plan this week, no eggs on Monday" data-testid="chat-input" enterkeyhint="send" aria-label="Message"></textarea>
      <button class="btn primary" data-testid="chat-send">Send</button>
    </div>
    <button type="button" class="btn sm ghost" data-action="chat-reset" data-testid="chat-reset">Start a new chat</button>
  </form>`);
  renderChat(dlg);
  dlg.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
  });
}

async function sendChat(text) {
  const c = ui.chat;
  text = String(text || "").trim();
  if (!text || c.busy) return;
  // The app plans the empty meals of the week on screen from the recipe book first, the way
  // 📋 Fill from kitchen does, so Claude only makes the changes the parent asks for.
  const week = weekDates();
  const fillUndo = snapshotDays(week);
  const filled = [];
  let dropped = 0;
  for (const k of week) dropped += dropUnsuitable(k);
  for (const k of week) {
    const before = { ...(getDay(state, k)?.meals || {}) };
    if (!applySuggestions(k)) continue;
    for (const [slot, m] of Object.entries(state.days[k].meals)) if (!before[slot]?.title && m?.title) filled.push({ date: k, slot, recipe: findRecipe(m.recipeId) || { title: m.title } });
  }
  if (filled.length || dropped) commit();
  if (filled.length) {
    c.shown.push({ role: "app", text: `Filled ${filled.length} empty meal${filled.length > 1 ? "s" : ""} from your recipe book.`, applied: filled, undo: fillUndo });
  }
  const win = planWindow(ui.selected, TODAY);
  const refs = chatRefs();
  const turn = { role: "user", content: userTurn(chatContext(win, refs), c.note ? `${c.note} ${text}` : text) };
  c.shown.push({ role: "parent", text });
  c.busy = true;
  c.controller = new AbortController();
  // The answer streams in, so give up only when nothing new has arrived for a while (or at the cap).
  const ctl = c.controller;
  const cap = setTimeout(() => ctl.abort("timeout"), CHAT_MAX_MS);
  let timer = setTimeout(() => ctl.abort("timeout"), CHAT_IDLE_MS);
  const onProgress = (text) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort("timeout"), CHAT_IDLE_MS);
    const meals = (text.match(/"slot"/g) || []).length;
    const busy = document.querySelector("[data-testid=chat-busy]");
    if (busy && meals) busy.textContent = `Planning… ${meals} meal${meals === 1 ? "" : "s"} so far.`;
  };
  renderChat();
  try {
    const out = await browserPlanChat([...c.turns, turn], { catalog: planCatalog(), signal: c.controller.signal, onProgress });
    c.turns.push(turn, { role: "assistant", content: out.content });
    c.note = "";
    const { apply, skipped } = planChanges(out.changes, { dates: win.dates, refs, schoolNutFree: nutFreeOn(), settings: state.settings, appliances: appliancesOwned() });
    const undo = apply.length ? snapshotDays([...new Set(apply.map((x) => x.date))]) : null;
    for (const x of apply) {
      const d = ensureDay(x.date);
      if (x.recipe) {
        if (x.isNew && !state.savedRecipes.some((r) => r.id === x.recipe.id)) state.savedRecipes.push(x.recipe);
        d.meals[x.slot] = { recipeId: x.recipe.id, title: x.recipe.title, forWhom: x.recipe.forWhom };
      } else delete d.meals[x.slot];
      markEdited(d);
    }
    c.shown.push({ role: "claude", text: out.reply, applied: apply, skipped, undo });
    if (apply.length) commit();
  } catch (err) {
    const why = c.controller?.signal.aborted ? (c.controller.signal.reason === "timeout" ? "The AI took too long. Try again, or ask for fewer days." : "Stopped.") : err.message || "Something went wrong.";
    c.shown.push({ role: "error", text: why });
  } finally {
    clearTimeout(timer);
    clearTimeout(cap);
    c.busy = false;
    c.controller = null;
    renderChat();
  }
}

// "· 🍟 12 min" when the family can make it in the air fryer or oven.
function applianceNote(r) {
  const m = methodsFor(r, appliancesOwned());
  return m.length ? ` <span class="small" data-testid="appliance-note">· ${m.map((x) => `${x.icon} ${x.minutes ? esc(x.minutes) + " min" : esc(x.label)}`).join(" · ")}</span>` : "";
}

// Two-basket air fryer: the day's air fryer dishes (planned and suggested), paired to cook side by side.
function renderBasketPlan(key) {
  if (key < TODAY) return "";
  const day = getDay(state, key) || emptyDay();
  const picks = suggestionsFor(key);
  // Only dishes cooked at the same time share a load: the morning (breakfast and lunchbox), the snack, dinner.
  const when = { breakfast: "Morning", lunchbox: "Morning", lunch: "Lunch", snack: "Snack time", dinner: "Dinner" };
  const byTime = {};
  for (const s of slotsFor(key)) {
    const r = findRecipe(day.meals?.[s.id]?.recipeId || picks[s.id]);
    if (r) (byTime[when[s.id.split("_")[1]]] ||= []).push(r);
  }
  const pairs = Object.entries(byTime).flatMap(([time, list]) => basketPairs(list, state.settings).map((p) => ({ ...p, time })));
  if (!pairs.length) return "";
  const basket = (b, n) => `<li>Basket ${n}: <strong>${esc(b.recipe.title)}</strong>${b.minutes ? ` · ${esc(b.minutes)} min` : ""}${b.tempC ? ` at ${esc(b.tempC)}°C` : ""}</li>`;
  return `<div class="notice info small" data-testid="basket-plan">
    <strong>🍟 Use both air fryer baskets</strong>
    ${pairs.map((p) => `<div data-testid="basket-pair"><span>${esc(p.time)}:</span><ul style="margin:4px 0">${basket(p.baskets[0], 1)}${basket(p.baskets[1], 2)}</ul>
      <span class="muted">Press Sync (Smart Finish) so both come out together${p.minutes ? ` in about ${esc(p.minutes)} min` : ""}.</span></div>`).join("")}
  </div>`;
}

// Ingredients of a recipe that come from the freezer, because they aren't in the kitchen fresh.
function fromFreezer(recipe) {
  const cold = freezerSet(frozenOnHand());
  const fresh = new Set(state.pantry.map(normName));
  return [...new Set((recipe?.ingredients || []).map((i) => normName(i.name)).filter((n) => cold.has(n) && !fresh.has(n)))];
}

// The baby has a fruit every morning: one from the kitchen, or a ripe banana to buy.
// How a busy-morning breakfast fits the morning: warmed up, made the night before, or no cooking.
function busyLabel(r) {
  const kind = breakfastKind(r, appliancesOwned());
  const p = r.prepAhead;
  if (kind === "no-cook") return "⏱️ No cooking";
  if (kind === "morning") return `⚡ ${fastestMinutes(r, appliancesOwned()) || r.prepMinutes} min that morning`;
  const mins = p?.minutes ? ` (${p.minutes} min${kind === "weekend" ? (p.frozen ? ", freezes" : p.keepsDays ? `, keeps ${p.keepsDays} days` : "") : ""})` : "";
  if (kind === "weekend") return `🗓️ Weekend batch${mins}${r.reheat ? ", reheat in the microwave" : ""}`;
  return r.reheat ? `🔥 Made the night before${mins}, reheat in the microwave` : `🌙 Make the night before${mins}`;
}

// What to make ahead from this day: tonight, for tomorrow's planned breakfasts that are made the
// night before, and at the weekend, the batches for the school week's planned breakfasts.
function renderPrepAhead(key) {
  if (key < TODAY) return "";
  const breakfasts = (k) => slotsFor(k).filter((s) => s.id.endsWith("breakfast")).map((s) => getDay(state, k)?.meals?.[s.id]).filter((m) => m?.title)
    .map((m) => (m.recipeId && findRecipe(m.recipeId)) || findRecipeByTitle(m.title)).filter((r) => r?.busyMorning === "make-ahead");
  const lines = [];
  const tonight = [...new Map(breakfasts(addDays(key, 1)).filter((r) => breakfastKind(r) === "night").map((r) => [r.id, r])).values()];
  if (tonight.length) lines.push(`🌙 <strong>Tonight, for tomorrow's breakfast:</strong> ${tonight.map((r) => `<button type="button" class="linkish" data-action="view-recipe" data-id="${esc(r.id)}">${esc(r.title)}</button>${r.prepAhead?.minutes ? ` (${r.prepAhead.minutes} min)` : ""}`).join(", ")}`);
  if (!isSchoolDay(key)) {
    const batch = new Map();
    for (let d = 1; d <= 6; d++) {
      const k = addDays(key, d);
      if (!isSchoolDay(k)) { if (batch.size || fromKey(k).getDay() === 6) break; continue; }
      for (const r of breakfasts(k).filter((x) => breakfastKind(x) === "weekend")) (batch.get(r.id) || batch.set(r.id, { r, days: [] }).get(r.id)).days.push(fromKey(k).toLocaleDateString(undefined, { weekday: "short" }));
    }
    if (batch.size) lines.push(`🗓️ <strong>Weekend prep for the school week:</strong> ${[...batch.values()].map(({ r, days }) => `<button type="button" class="linkish" data-action="view-recipe" data-id="${esc(r.id)}">${esc(r.title)}</button> for ${esc(days.join(", "))}${r.prepAhead?.minutes ? ` (${r.prepAhead.minutes} min)` : ""}`).join("; ")}`);
  }
  return lines.length ? `<div class="notice info small" data-testid="prep-ahead">${lines.join("<br>")}</div>` : "";
}

// A breakfast's reheating line and its side dips, each dip opening its own recipe.
function morningExtras(r) {
  const dips = sideDipsFor(r);
  return `${r.reheat ? `<p class="small" style="margin:0" data-testid="reheat">🔥 <strong>In the morning:</strong> ${esc(r.reheat)}</p>` : ""}${dips.length ? `<p class="small" style="margin:0" data-testid="recipe-side-dips">🥣 <strong>Side dip:</strong> ${dips.map((d) => `<button type="button" class="linkish" data-action="view-recipe" data-id="${esc(d.id)}">${esc(d.title)}</button>`).join(" or ")}</p>` : ""}`;
}

function babyFruitNote(seed = 0, inline = false) {
  const f = babyFruitFor(state.pantry, seed);
  const name = String(state.settings?.babyName || "").trim() || "the baby";
  const text = `🍌 Plus a fruit for ${name}: ${f.how}${f.inKitchen ? "" : " (add bananas to the shopping list)"}`;
  return inline ? `<span class="small" data-testid="baby-fruit">${esc(text)}</span>` : `<div class="notice info small" data-testid="baby-fruit">${esc(text)}</div>`;
}

// Under the family dinner idea: the other vegetable curries the kitchen can make, one tap to pick.
function vegCurryChoices(key, slot) {
  const ids = ui.suggest[key]?.vegOptions?.[slot] || [];
  if (!ids.length) return "";
  return `<span class="small veg-curries" data-testid="veg-curry-options"><span class="muted">🥬 Or a vegetable curry:</span>${ids.map((id) => {
    const r = findRecipe(id);
    const need = shoppingNeeds(r);
    return `<button type="button" class="linkish" data-action="suggest-pick" data-slot="${slot}" data-id="${esc(id)}" data-testid="veg-curry-option" title="${need.length ? esc("Need " + need.map((i) => i.name).join(", ")) : "All in the kitchen"}">${esc(r.title)}</button>`;
  }).join("")}</span>`;
}

function renderSuggestions(key) {
  if (key < TODAY) return "";
  const picks = suggestionsFor(key);
  const rows = MEAL_GROUPS.flatMap((g) => slotsFor(key).filter((s) => s.who === g.who && picks[s.id]));
  if (!rows.length) return "";
  // Folded to one line of dish pictures; open it to see each idea, swap one, or see what's missing.
  const pics = [...new Set(rows.map((s) => foodArt(findRecipe(picks[s.id])).emoji))].join("");
  return `<div class="suggest" data-testid="day-suggestions">
    <details class="suggest-list" data-group="suggest" ${ui.openGroups.has("suggest") ? "open" : ""}>
    <summary><span class="grow"><strong>💡 ${rows.length} meal idea${rows.length > 1 ? "s" : ""} from your kitchen</strong><span class="sug-pics" aria-hidden="true">${pics}</span></span><span class="chev" aria-hidden="true"></span></summary>
    <div class="row between" style="margin-top:6px"><span class="small muted">Tap 🔀 for another idea</span>
      <button type="button" class="btn sm ghost" data-action="suggest-shuffle" data-testid="suggest-shuffle">🔀 Other ideas</button></div>
    ${rows.map((s) => {
      const r = findRecipe(picks[s.id]);
      const need = shoppingNeeds(r);
      const from = ui.suggest[key]?.leftover?.[s.id];
      const turn = ui.suggest[key]?.rotation?.[s.id];
      const cold = fromFreezer(r);
      return `<div class="suggest-row" data-testid="suggestion" data-slot="${s.id}">
        <span class="small muted">${esc(slotLabel(s, state.settings))}</span>
        <span class="grow">${from ? `<span class="small" data-testid="leftover-idea">♻️ Uses yesterday's ${esc(from)}</span><br>` : ""}${turn ? `<span class="small muted" data-testid="lunch-turn">🔁 Next on ${esc(state.settings.kidName || "the 4-year-old")}'s lunch list</span><br>` : ""}${r.busyMorning && isSchoolDay(key) ? `<span class="small muted" data-testid="busy-morning">${esc(busyLabel(r))}</span><br>` : ""}${art(r, "xs")} ${esc(r.title)}${r.familyFavorite ? " ⭐" : ""}${tagIcons(r) ? ` <span aria-hidden="true">${tagIcons(r)}</span>` : ""}${applianceNote(r)}${need.length ? ` <span class="small" style="color:var(--warn)">· need ${esc(need.map((i) => i.name).join(", "))}</span>` : ' <span class="small" style="color:var(--ok)">· all in the kitchen</span>'}${cold.length ? ` <span class="small" data-testid="from-freezer">· 🧊 ${esc(cold.join(", "))} from the freezer</span>` : ""}${sideDipsFor(r).length ? `<br><span class="small" data-testid="side-dip">🥣 With ${esc(sideDipsFor(r).map((d) => d.title.toLowerCase()).join(" or "))}</span>` : ""}${s.id === "baby_breakfast" && !recipeHasFruit(r) ? `<br>${babyFruitNote(ui.suggest[key]?.seed || 0, true)}` : ""}${vegCurryChoices(key, s.id)}</span>
        <button type="button" class="iconbtn" data-action="suggest-swap" data-slot="${s.id}" title="Another idea" aria-label="Another idea for ${esc(slotLabel(s, state.settings))}">🔀</button>
      </div>`;
    }).join("")}
    </details>
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
    <span class="slot-label">${esc(slotLabel(s, state.settings))}</span>
    <div class="slot-row">
      ${m?.title ? art({ title: m.title }, "sm") : '<span class="art sm empty" aria-hidden="true">＋</span>'}
      <input type="text" list="dl-${s.who}" value="${esc(m?.title || "")}" placeholder="Pick a recipe or type a dish" data-action="slot" data-slot="${s.id}" data-who="${s.who}" data-testid="slot-${s.id}" aria-label="${esc(slotLabel(s, state.settings))}">
      ${r ? `<button class="iconbtn" data-action="view-recipe" data-id="${esc(r.id)}" title="View recipe" aria-label="View recipe">📖</button>` : ""}
      ${m?.title && ui.selected >= TODAY ? `<button class="iconbtn" data-action="swap-meal" data-slot="${s.id}" data-testid="swap-meal" title="Another idea" aria-label="Another idea for ${esc(slotLabel(s, state.settings))}">🔀</button>` : ""}
      ${m?.title ? `<button class="iconbtn" data-action="clear-slot" data-slot="${s.id}" title="Clear" aria-label="Clear ${esc(slotLabel(s, state.settings))}">✕</button>` : ""}
    </div>
    ${issues[s.id] ? `<span class="small" style="color:var(--bad)" data-testid="slot-warning">⛔ ${esc(issues[s.id].messages[0])}</span>` : ""}
  </div>`;
}

function todoRow(t, { showDate = false } = {}) {
  const meta = [t.time ? `🕒 ${esc(t.time)}` : "", showDate ? esc(prettyDate(t.date)) : ""].filter(Boolean).join(" · ");
  return swipeRow({
    testid: "todo-item",
    cls: `todo ${t.done ? "done" : ""}`,
    data: `data-kind="todo" data-id="${esc(t.id)}"`,
    leftLabel: t.done ? "Not done" : "Done",
    check: `<input type="checkbox" class="big-check" data-action="todo-toggle" data-id="${esc(t.id)}" ${t.done ? "checked" : ""} aria-label="Done: ${esc(t.text)}">`,
    body: `<span class="txt name">${esc(t.text)}</span><span class="meta">${whoPill(t.who)}${meta ? ` <span>${meta}</span>` : ""}</span>`,
    more: `<button type="button" class="iconbtn lg" data-action="todo-more" data-id="${esc(t.id)}" aria-label="Edit ${esc(t.text)}" data-testid="todo-more">⋯</button>`,
  });
}

function todoSheet(t) {
  const quick = [[TODAY, "Today"], [addDays(TODAY, 1), "Tomorrow"]];
  sheet("todo-edit-sheet", `<form data-form="todo-edit" class="stack" data-id="${esc(t.id)}">
    <div class="row between"><h2>Edit to do</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <label class="field"><span>What needs doing</span><input type="text" name="text" required maxlength="120" value="${esc(t.text)}" placeholder="e.g. Pack the water bottle" data-testid="todo-input" enterkeyhint="done"></label>
    <div class="field"><span>For</span>${chipRadios("who", ["kid", "baby", "family"].map((v) => [v, whoLabel(v, state.settings, { age: true })]), t.who || "kid", "todo-who")}</div>
    <div class="field"><span>When</span>
      <div class="row">${quick.map(([k, l]) => `<button type="button" class="btn sm ${k === t.date ? "primary" : ""}" data-action="todo-sheet-date" data-date="${k}">${l}</button>`).join("")}
        <input type="date" name="date" value="${esc(t.date)}" required data-testid="todo-input-date" class="grow" aria-label="Date"></div>
    </div>
    <label class="field"><span>Time (optional)</span><input type="time" name="time" value="${esc(t.time || "")}"></label>
    <button class="btn primary big" data-testid="todo-save">Save</button>
    <button type="button" class="btn danger big" data-action="todo-del" data-id="${esc(t.id)}" data-testid="todo-delete">Delete</button>
  </form>`);
}

const WHO_OPTIONS = (sel = "kid") => ["kid", "baby", "family"].map((v) => [v, whoLabel(v, state.settings)])
  .map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");

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

  // The day's dishes as pictures in the corner of the header: what's planned, or else what's suggested.
  const picks = key >= TODAY ? suggestionsFor(key) : {};
  const dishes = slots.map((s) => day.meals?.[s.id]?.title ? { title: day.meals[s.id].title } : findRecipe(picks[s.id])).filter(Boolean);
  const pics = [...new Set(dishes.map((d) => foodArt(d).emoji))].slice(0, 3);
  const planned = slots.filter((s) => day.meals?.[s.id]?.title).length;
  const todosLeft = todos.filter((t) => !t.done).length;
  const remsLeft = rems.filter((r) => !r.doneOnDate).length;
  const sched = (day.schedule || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const count = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  return `<div class="card day-panel" data-testid="day-panel" data-date="${key}">
    <div class="day-hero ${st}">
      <div class="hero-text">
        <span class="hero-kicker">${key === TODAY ? "Today · " : ""}${isSchoolDay(key) ? '<span class="pill kid">School day</span>' : '<span class="pill">Weekend</span>'}</span>
        <h2>${esc(fromKey(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</h2>
        <div class="hero-stats">
          <span>🍽️ ${planned}/${slots.length} meals</span>
          ${todosLeft ? `<span>✅ ${count(todosLeft, "to do", "to dos")}</span>` : ""}
          ${remsLeft ? `<span>⏰ ${count(remsLeft, "reminder")}</span>` : ""}
        </div>
      </div>
      <span class="hero-art n${pics.length || 1}" aria-hidden="true">${(pics.length ? pics : ["🍛"]).map((e) => `<span>${e}</span>`).join("")}</span>
    </div>
    ${banner}
    ${safetyBox}
    ${pendList.length ? `<ul class="pending-list" data-testid="day-pending">${pendList.map((p) => `<li data-type="${p.type}">${{ approval: "⏳", plan: "📝", reminder: "⏰", todo: "✅" }[p.type]} ${esc(p.text)}${p.overdue ? ' <span class="pill bad">overdue</span>' : ""}</li>`).join("")}</ul>` : ""}

    <h3 class="day-h">🍽️ Meals</h3>
    ${renderPrepAhead(key)}
    ${renderSuggestions(key)}
    ${renderBasketPlan(key)}
    <div data-testid="day-meals">
    ${MEAL_GROUPS.map((g) => {
      const groupSlots = slots.filter((s) => s.who === g.who);
      const done = groupSlots.filter((s) => day.meals?.[s.id]?.title);
      const hasIssue = groupSlots.some((s) => issues[s.id]);
      const open = ui.openGroups.has(g.who) || hasIssue;
      return `<details class="meal-group ${g.who}" data-group="${g.who}" data-testid="meal-group-${g.who}" ${open ? "open" : ""}>
        <summary><span class="who-icon" aria-hidden="true">${g.icon}</span><span class="grow"><span class="group-head"><strong>${esc(whoLabel(g.who, state.settings, { age: true }))}</strong>
          <span class="small ${hasIssue ? "" : "muted"}" ${hasIssue ? 'style="color:var(--bad)"' : ""}>${hasIssue ? "⛔ check safety · " : ""}${done.length} of ${groupSlots.length} planned</span></span>
          ${done.length ? `<span class="menu" data-testid="group-menu">${done.map((s) => `<span>${esc(day.meals[s.id].title)}</span>`).join("")}</span>` : ""}</span></summary>
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
    ${renderKidGoals(key)}

    <div class="day-sections">
    ${section({
      id: "day-schedule", icon: "🕒", title: "Schedule", cls: "sub",
      meta: sched.length ? `${count(sched.length, "item")} · ${esc(sched.map((x) => x.time).filter(Boolean)[0] || "")}`.replace(/ · $/, "") : "Nothing yet",
      body: `<div data-testid="day-schedule">
      ${sched.map((x) => `<div class="sched-item"><time>${esc(x.time || "--:--")}</time><span class="grow">${esc(x.text)}</span><button class="iconbtn" data-action="del-sched" data-id="${esc(x.id)}" aria-label="Remove">✕</button></div>`).join("") || '<p class="small muted">No schedule yet.</p>'}
    </div>
    <form class="row" data-form="add-sched" style="margin-top:6px">
      <input type="time" name="time" style="width:120px" aria-label="Time" data-testid="sched-time">
      <input type="text" name="text" class="grow" placeholder="e.g. School drop-off, nap, swim class" aria-label="Schedule item" data-testid="sched-text" required>
      <button class="btn sm primary" data-testid="sched-add">Add</button>
    </form>
    ${isSchoolDay(key) ? `<p class="small muted" style="margin-top:6px"><button type="button" class="btn ghost sm" data-action="school-schedule">+ Add usual school-day times</button></p>` : ""}`,
    })}
    ${section({
      id: "day-todos", icon: "✅", title: "To do", cls: "sub",
      meta: todos.length ? `${todosLeft} left${todos.length - todosLeft ? ` · ${todos.length - todosLeft} done` : ""}` : "Nothing yet",
      body: `<div data-testid="day-todos">${todos.length ? todos.map((t) => todoRow(t)).join("") : '<p class="small muted">Nothing to do for the kids on this date.</p>'}</div>
    <form class="row" data-form="todo-add-day" style="margin-top:6px">
      <input type="text" name="text" class="grow" placeholder="e.g. Buy dresses, check school schedule" aria-label="New to-do" required data-testid="day-todo-input">
      <select name="who" style="width:120px" aria-label="For">${WHO_OPTIONS()}</select>
      <button class="btn sm primary" data-testid="day-todo-add">Add</button>
    </form>`,
    })}
    ${section({
      id: "day-reminders", icon: "⏰", title: "Reminders", cls: "sub",
      meta: rems.length ? `${remsLeft} to do${rems.length - remsLeft ? ` · ${rems.length - remsLeft} done` : ""}` : "None",
      body: `${rems.length ? rems.map((r) => `<label class="chk ${r.doneOnDate ? "done" : ""}"><input type="checkbox" data-action="rem-done" data-id="${esc(r.id)}" data-date="${key}" ${r.doneOnDate ? "checked" : ""}><span class="txt">${esc(r.time || "")} ${esc(r.title)}</span></label>`).join("") : '<p class="small muted">No reminders.</p>'}
    <button class="btn sm" data-action="new-reminder" data-date="${key}">+ Reminder on this date</button>`,
    })}
    </div>
  </div>`;
}

// ---------- recipes ----------
const STAPLES = ["rice", "moong dal", "toor dal", "urad dal", "ragi flour", "rava", "curd", "ghee", "milk", "egg", "banana", "apple", "carrot", "potato", "sweet potato", "tomato", "onion", "beans", "peas", "pumpkin", "spinach", "lemon", "idli/dosa batter", "vermicelli", "atta", "coconut", "curry leaves", "mustard seeds", "jeera", "turmeric", "tamarind",
  "paneer", "cheddar cheese", "butter", "bread", "flour tortilla", "corn tortilla", "black beans", "avocado", "rolled oats", "peanut butter", "almond powder"];
// Telugu names first, as the family says them; normName maps each to the English name the recipes use.
const TELUGU_VEG = ["Vankaya (brinjal)", "Bendakaya (okra)", "Sorakaya (bottle gourd)", "Beerakaya (ridge gourd)", "Dondakaya (ivy gourd)",
  "Potlakaya (snake gourd)", "Kakarakaya (bitter gourd)", "Munagakaya (drumstick)", "Aratikaya (raw banana)", "Chamadumpa (taro root)",
  "Gummadikaya (pumpkin)", "Dosakaya (cucumber)", "Bangaladumpa (potato)", "Chilagada dumpa (sweet potato)", "Chikkudukaya (broad beans)",
  "Goruchikkudu (cluster beans)", "Mamidikaya (raw mango)", "Mullangi (radish)", "Kandagadda (yam)", "Tamata (tomato)", "Ullipaya (onion)",
  "Pachi mirapakaya (green chilli)", "Allam (ginger)", "Vellulli (garlic)", "Cabbage", "Cauliflower", "Capsicum", "Pachi batani (peas)"];
const TELUGU_LEAVES = ["Palakura (spinach)", "Thotakura (amaranth leaves)", "Gongura (sorrel leaves)", "Menthikura (methi leaves)",
  "Kothimeera (coriander leaves)", "Pudina (mint leaves)", "Karivepaku (curry leaves)"];

const FRUITS = ["Arati pandu (banana)", "Mamidi pandu (mango)", "Boppayi (papaya)", "Sapota (chikoo)", "Jama pandu (guava)", "Danimma (pomegranate)",
  "Kamala pandu (orange)", "Draksha (grapes)", "Puchakaya (watermelon)", "Apple", "Pear", "Avocado", "Strawberries", "Blueberries", "Kiwi", "Peach", "Plum", "Pineapple"];

// The kitchen list in collapsed groups (vegetables, fruits, dips, bread, snacks, ...). Each group's
// heading shows how many there are and their names, so a glance is enough; open it to remove one.
function renderKitchenGroups() {
  const exp = new Map(expiryList().map((e) => [e.name, e]));
  return groupKitchen(state.pantry).map((g) => {
    const id = `kitchen-${g.id}`;
    return `<details class="kitchen-group" data-testid="kitchen-group" data-kitchen="${g.id}" data-group="${id}" ${ui.openGroups.has(id) ? "open" : ""}>
      <summary><span aria-hidden="true">${g.icon}</span> <strong>${esc(g.label)}</strong> <span class="count">${g.items.length}</span>
        <span class="preview small muted">${esc(g.items.join(", "))}</span></summary>
      <div class="chips">${g.items.map((p) => pantryChip(p, exp.get(p))).join("")}</div>
    </details>`;
  }).join("");
}

// One kitchen item: tap its name to set its use-by date. Food running out within a week shows when.
function pantryChip(p, e) {
  const soon = e && e.daysLeft <= USE_SOON_DAYS;
  const when = e && (e.daysLeft <= 7 || !e.estimated) ? `<span class="exp ${soon ? "soon" : ""}" data-testid="pantry-expiry">${e.daysLeft < 0 ? "past date" : esc(shortLeft(e.daysLeft))}${e.estimated ? "" : " 📅"}</span>` : "";
  return `<span class="chip ${soon ? "soon" : ""}" data-testid="pantry-item"><button type="button" class="chip-name" data-action="pantry-date" data-name="${esc(p)}" aria-label="${esc(p)}: set its use-by date" data-testid="pantry-date">${esc(p)}${when}</button><button data-action="pantry-del" data-name="${esc(p)}" aria-label="Remove ${esc(p)}">✕</button></span>`;
}
const shortLeft = (d) => (d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`);

// Food that runs out within USE_SOON_DAYS, soonest first, for the top of the kitchen.
function renderUseSoon() {
  const soon = expiryList().filter((e) => e.daysLeft <= USE_SOON_DAYS);
  if (!soon.length) return "";
  return `<div class="notice info small use-soon" data-testid="use-soon">⏳ <strong>Use soon:</strong> ${soon.map((e) => `<button type="button" class="linkish" data-action="pantry-date" data-name="${esc(e.name)}">${esc(e.name)}</button> (${e.daysLeft < 0 ? `past its date${e.estimated ? "?" : ""}` : esc(daysLeftLabel(e.daysLeft))})`).join(", ")}. Suggestions and the week plan cook these first.</div>`;
}

// The use-by date of one kitchen item: typed in, or the fridge estimate.
function pantryDateSheet(name) {
  const k = dateKeyOf(name);
  const entry = pantryDates()[k] || {};
  const days = shelfLifeDays(name);
  const est = expiryOf(name, { added: entry.added }, TODAY);
  const added = isDateKey(entry.added) ? entry.added : "";
  sheet("pantry-date-sheet", `<form data-form="pantry-date" class="stack" data-name="${esc(name)}">
    <div class="row between"><h2>${esc(name)}</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <p class="small muted" data-testid="pantry-date-estimate">${added ? `In the kitchen since ${esc(prettyDate(added))}. ` : ""}${days != null ? `Keeps about ${days} days in the fridge, so without a date it's used by ${esc(prettyDate(est.expires))}.` : "This keeps for months, so it isn't dated unless you set one."}</p>
    <label class="field"><span>Use by</span><input type="date" name="expires" value="${esc(isDateKey(entry.expires) ? entry.expires : "")}" data-testid="pantry-date-input"></label>
    <button class="btn primary big" data-testid="pantry-date-save">Save</button>
    ${isDateKey(entry.expires) ? `<button type="button" class="btn big" data-action="pantry-date-clear" data-name="${esc(name)}" data-testid="pantry-date-clear">Use the fridge estimate</button>` : ""}
  </form>`);
}

function quickAddGroup(label, items, have, testid) {
  const left = items.filter((s) => !have.has(normName(s)));
  return left.length ? `<details style="margin-top:8px" data-testid="${testid}" data-group="${testid}" ${ui.openGroups.has(testid) ? "open" : ""}><summary>${esc(label)}</summary><div class="chips" style="margin-top:8px">${left.map((s) => `<button class="chip add" data-action="pantry-quick" data-name="${esc(s)}">+ ${esc(s)}</button>`).join("")}</div></details>` : "";
}

function renderRecipes() {
  const pantrySet = new Set(state.pantry.map(normName));
  const filt = ui.savedFilter.trim().toLowerCase();
  const saved = state.savedRecipes.filter((r) => !filt || r.title.toLowerCase().includes(filt));
  const soonCount = expiryList().filter((e) => e.daysLeft <= USE_SOON_DAYS).length;

  // What's at home, the recipes by age and what the kitchen can make come first.
  $("#view-recipes").innerHTML = `
    ${section({ id: "sec-kitchen", icon: "🧺", title: "What's in the kitchen",
      open: !state.pantry.length,
      meta: state.pantry.length ? `${state.pantry.length} item${state.pantry.length > 1 ? "s" : ""}${soonCount ? ` · ⏳ ${soonCount} to use soon` : ""} · ${esc(state.pantry.slice(0, 4).join(", "))}${state.pantry.length > 4 ? "…" : ""}` : "Empty: add what you have",
      body: `
      ${renderUseSoon()}
      <div class="kitchen-groups" data-testid="pantry-list">
        ${renderKitchenGroups() || '<span class="muted small">Add what you have at home.</span>'}
      </div>
      <form class="pantry-form" data-form="pantry-add" style="margin-top:10px">
        <div class="row">
          <input type="text" name="items" class="grow" placeholder="Add items, comma separated (e.g. drumstick, paneer)" aria-label="Add pantry items" data-testid="pantry-input">
          <button class="btn primary" data-testid="pantry-add">Add</button>
        </div>
        <label class="field small"><span>Use by (optional)</span><input type="date" name="expires" min="${TODAY}" data-testid="pantry-expires"></label>
      </form>
      <p class="small muted">No date? It's estimated from how long the food keeps in the fridge. Tap an item to change its date. Freezer food comes last in suggestions.</p>
      <label class="chk full small" style="min-height:0"><input type="checkbox" data-action="assume-staples" ${assumeStaples() ? "checked" : ""} data-testid="assume-staples"> 🧂 Always at home: ${esc(staplesSummary(cuisinePicks()))}</label>
      ${quickAddGroup("Quick add common items", STAPLES, pantrySet, "quick-common")}
      ${quickAddGroup("Pandlu (fruits)", FRUITS, pantrySet, "quick-fruits")}
      ${quickAddGroup("Kuragayalu (Telugu vegetables)", TELUGU_VEG, pantrySet, "quick-telugu-veg")}
      ${quickAddGroup("Aakukuralu (leafy greens)", TELUGU_LEAVES, pantrySet, "quick-telugu-leaves")}` })}

    ${renderAgeSections()}
    ${renderReadyToCook()}
    ${renderTopPicks()}
    ${renderQuickBreakfasts()}
    ${renderLeftoverIdeas()}
    ${renderCookByVegetable()}

    ${section({ id: "sec-generate", icon: "✨", title: aiOnline() ? "Make new recipes with AI" : "Find recipes for a meal",
      meta: "Pick who it's for and the meal", open: ui.aiBusy || ui.results.length > 0,
      body: `
      <form data-form="generate" class="form-grid">
        <label class="field"><span>For</span>
          <select name="forWhom" data-testid="gen-for" data-action="gen-field">
            ${[["both", whoLabel("both", state.settings)], ["baby", whoLabel("baby", state.settings, { age: true })], ["kid", whoLabel("kid", state.settings, { age: true })], ["family", "Whole family"]].map(([v, l]) => `<option value="${v}" ${ui.gen.forWhom === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select></label>
        <label class="field"><span>Meal</span>
          <select name="mealType" data-testid="gen-meal" data-action="gen-field">
            ${[["", "Any"], ["breakfast", "Breakfast"], ["lunchbox", "School lunchbox"], ["lunch", "Lunch"], ["snack", "Snack"], ["dinner", "Dinner"]].map(([v, l]) => `<option value="${v}" ${ui.gen.mealType === v ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <label class="chk full" style="min-height:0"><input type="checkbox" name="quick" data-action="gen-field" ${ui.gen.quick ? "checked" : ""} data-testid="gen-quick"> ⚡ Quick: just one recipe, ready in ${QUICK_MINUTES} minutes${appliancesOwned().length ? ` (${appliancesOwned().map((k) => APPLIANCES[k].label.toLowerCase()).join(" and ")} count)` : ""}</label>
        <label class="chk full" style="min-height:0"><input type="checkbox" name="busy" data-action="gen-field" ${genBusy() ? "checked" : ""} data-testid="gen-busy"> 🌙 Busy morning: breakfasts made the night before or with no cooking first</label>
        <label class="chk full" style="min-height:0"><input type="checkbox" data-action="nut-free" ${nutFreeOn() ? "checked" : ""} data-testid="school-nut-free"> School is nut-free (no peanuts or tree nuts in the lunchbox or snack box)</label>
        <label class="field full"><span>Anything else? (optional)</span>
          <input type="text" name="notes" maxlength="300" value="${esc(ui.gen.notes)}" placeholder="e.g. baby just started eggs, no onion today" data-testid="gen-notes" data-action="gen-field"></label>
        <div class="full row">
          <button class="btn primary" data-testid="generate-recipes" ${ui.aiBusy ? "disabled" : ""}>${ui.gen.quick ? (aiOnline() ? "⚡ Get a quick recipe" : "Find a quick recipe") : aiOnline() ? "✨ Get recipes" : "Find recipes"}</button>
          ${ui.aiBusy ? `<span class="spinner" aria-hidden="true"></span><span class="small muted">Asking the AI… this can take up to a minute</span><button type="button" class="btn sm" data-action="cancel-ai" data-testid="cancel-ai">Cancel</button>` : ""}
        </div>
      </form>
      <p class="small muted" style="margin-top:8px">Every recipe is checked for age safety: no honey, salt, sugar or whole nuts for the baby, soft textures only, chopped (not whole) nuts for the 4-year-old, and nut-free lunchboxes when the school is nut-free.</p>` })}

    <div data-testid="recipe-results">
      ${ui.aiNotice ? `<div class="notice" data-testid="ai-notice">${esc(ui.aiNotice)}</div>` : ""}
      ${ui.results.length && ui.gen.mealType === "breakfast" && ["baby", "both"].includes(ui.gen.forWhom) ? babyFruitNote() : ""}
      ${ui.rejected.length ? `<div class="notice info small" data-testid="rejected-notice">Removed ${ui.rejected.length} AI suggestion${ui.rejected.length > 1 ? "s" : ""} that failed the age-safety check: ${ui.rejected.map((r) => esc(r.title) + " (" + esc(r.errors.map((e) => e.rule).join(", ")) + ")").join("; ")}</div>` : ""}
      <div class="recipe-grid">${ui.results.map((r) => recipeCard(r)).join("")}</div>
    </div>

    ${section({ id: "sec-saved", icon: "⭐", title: `Saved recipes (${state.savedRecipes.length})`,
      meta: state.savedRecipes.length ? esc(state.savedRecipes.slice(0, 3).map((r) => r.title).join(", ")) : "Save recipes you like", open: !!filt,
      body: `
      ${state.savedRecipes.length ? `<input type="search" placeholder="Search saved" value="${esc(ui.savedFilter)}" data-action="saved-filter" aria-label="Search saved recipes">` : ""}
      <div class="recipe-grid" data-testid="saved-recipes" style="margin-top:8px">${saved.map((r) => recipeCard(r, { saved: true })).join("") || '<p class="muted small">Save recipes you like and they will work even when offline.</p>'}</div>` })}`;
}

// Recipes by age: the book's recipes for the baby, the 4-year-old and the family, by meal. ☆ marks
// a recipe to use often, and the meal planner then picks it first for that person's meals.
const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", lunchbox: "School lunchbox", snack: "Snack", dinner: "Dinner" };
const AGE_ICONS = { baby: "👶", kid: "👧", family: "🍛" };
const AGE_SHOWN = 8;

function renderAgeSections() {
  const who = ui.age.who;
  const byMeal = ageSection(LIBRARY, who, state.settings);
  const meals = SECTION_MEALS[who].filter((m) => byMeal[m].length);
  const meal = meals.includes(ui.age.meal) ? ui.age.meal : "";
  const list = meal ? byMeal[meal] : meals.flatMap((m) => byMeal[m]);
  const often = regularsFor(state.settings, who).filter((id) => LIBRARY.some((r) => r.id === id));
  // With every meal shown, the ones used often lead whatever the meal.
  const shown = (meal ? list : regularsFirst(list, often));
  const rows = ui.age.all ? shown : shown.slice(0, AGE_SHOWN);
  const row = (r) => {
    const on = often.includes(r.id);
    return `<div class="age-row" data-testid="age-recipe" data-recipe-id="${esc(r.id)}" data-often="${on}">
      <button type="button" class="ready-item" data-action="view-recipe" data-id="${esc(r.id)}">
        ${art(r, "sm")}<span class="grow"><strong>${esc(r.title)}</strong>${r.familyFavorite ? " ⭐" : ""}${tagIcons(r) ? ` <span aria-hidden="true">${tagIcons(r)}</span>` : ""}
          <span class="small muted">${esc(MEAL_LABELS[r.mealType] || r.mealType)}${r.prepMinutes ? ` · ${esc(r.prepMinutes)} min` : ""}${on ? ' · <span style="color:var(--ok)">used often in the planner</span>' : ""}</span></span></button>
      <button type="button" class="iconbtn often${on ? " on" : ""}" aria-pressed="${on}" data-action="toggle-often" data-who="${who}" data-id="${esc(r.id)}" data-testid="toggle-often"
        title="${on ? "Stop using often" : "Use often in the meal planner"}" aria-label="${on ? "Stop using often" : "Use often in the meal planner"}: ${esc(r.title)}">${on ? "★" : "☆"}</button>
    </div>`;
  };
  const counts = AGE_SECTIONS.map((w) => regularsFor(state.settings, w).length);
  return section({ id: "sec-by-age", icon: "🧒", title: "Recipes by age", testid: "recipes-by-age",
    meta: counts.some(Boolean) ? AGE_SECTIONS.map((w, i) => counts[i] ? `${AGE_ICONS[w]} ${counts[i]} used often` : "").filter(Boolean).join(" · ") : "Baby, 4-year-old and family recipes. ☆ the ones to use often",
    body: `
    <div class="seg" role="group" aria-label="Whose recipes" style="margin-top:8px" data-testid="age-who">${AGE_SECTIONS.map((w) =>
      `<button type="button" aria-pressed="${w === who}" data-action="age-who" data-who="${w}">${AGE_ICONS[w]} ${esc(w === "family" ? "Family" : whoLabel(w, state.settings, { age: true }))}</button>`).join("")}</div>
    <div class="chips" style="margin-top:8px" data-testid="age-meal">${[["", "All"], ...meals.map((m) => [m, MEAL_LABELS[m]])].map(([m, l]) =>
      `<button type="button" class="chip add veg${m === meal ? " on" : ""}" aria-pressed="${m === meal}" data-action="age-meal" data-meal="${m}">${esc(l)} <span class="muted">${m ? byMeal[m].length : meals.reduce((n, x) => n + byMeal[x].length, 0)}</span></button>`).join("")}</div>
    <p class="small muted" style="margin:8px 0">${often.length
      ? `★ ${often.length} used often: the meal planner picks ${often.length > 1 ? "these" : "this"} first for ${esc(who === "family" ? "the family" : whoLabel(who, state.settings))} and can bring ${often.length > 1 ? "them" : "it"} back after ${REGULAR_GAP_DAYS} days.`
      : `Tap ☆ on the recipes you make all the time. The meal planner picks them first for ${esc(who === "family" ? "the family" : whoLabel(who, state.settings))}'s meals.`}</p>
    <div class="ready-list" data-testid="age-list">${rows.map(row).join("")}</div>
    ${shown.length > AGE_SHOWN ? `<div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-action="age-all" data-testid="age-all">${ui.age.all ? "Show fewer" : `Show all ${shown.length}`}</button></div>` : ""}` });
}

// Cook by vegetable: tap one or more vegetables and see the book's fries and curries made with them.
const COOK_VEG = [...TELUGU_VEG, ...TELUGU_LEAVES].filter((v) => !["onion", "garlic", "ginger", "green chilli", "curry leaves", "coriander leaves", "mint leaves"].includes(normName(v)));

function renderCookByVegetable() {
  const picked = new Set(ui.cookVeg.map(normName));
  const res = cookByVegetables(ui.cookVeg, { maxMinutes: QUICK_MINUTES, onlyQuick: ui.cookQuick, appliances: appliancesOwned() });
  const kitchen = new Set(state.pantry.map(normName));
  const row = (x) => {
    const r = x.recipe;
    const need = state.pantry.length ? missingForRecipe(r, state.pantry).filter((n) => !picked.has(n)) : [];
    return `<button type="button" class="ready-item" data-action="view-recipe" data-id="${esc(r.id)}" data-testid="cook-recipe" data-dish="${x.dish}">
      ${art(r, "sm")}<span class="grow"><strong>${esc(r.title)}</strong>${r.familyFavorite ? " ⭐" : ""}
        <span class="small muted">${r.prepMinutes ? `${x.quick ? "⚡ " : ""}${esc(r.prepMinutes)} min` : ""}${applianceNote(r)}${x.all ? "" : ` · has ${esc(x.has.join(", "))}`}${need.length ? ` · need ${esc(need.join(", "))}` : ""}</span></span>
      <span aria-hidden="true">›</span></button>`;
  };
  const list = (label, items, dish) => `<h3>${label} <span class="small muted">(${items.length})</span></h3>
    ${items.length ? `<div class="ready-list" data-testid="cook-${dish}">${items.slice(0, 8).map(row).join("")}</div>`
      : `<p class="small muted" data-testid="cook-${dish}-none">No ${dish} with ${ui.cookVeg.length > 1 ? "these" : "this"} in the recipe book${ui.cookQuick ? ` in ${QUICK_MINUTES} minutes. Untick ⚡ to see slower ones` : ""}.</p>`}`;
  return section({ id: "sec-cook-veg", icon: "🥬", title: "Cook by vegetable", testid: "cook-by-veg", open: ui.cookVeg.length > 0,
    meta: ui.cookVeg.length ? esc(ui.cookVeg.join(", ")) : "Tap a vegetable, get a fry or a curry",
    body: `
    <div class="chips" style="margin-top:8px" data-testid="cook-veg-chips">${COOK_VEG.map((v) => {
      const on = picked.has(normName(v));
      return `<button type="button" class="chip add veg${on ? " on" : ""}" aria-pressed="${on}" data-action="cook-veg" data-name="${esc(v)}" data-testid="cook-veg">${on ? "✓ " : ""}${esc(v)}${kitchen.has(normName(v)) ? " 🏠" : ""}</button>`;
    }).join("")}</div>
    <label class="chk full" style="min-height:0;margin-top:8px"><input type="checkbox" data-action="cook-quick" ${ui.cookQuick ? "checked" : ""} data-testid="cook-quick"> ⚡ Only ready in ${QUICK_MINUTES} minutes</label>
    ${ui.cookVeg.length ? `<div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-action="cook-veg-clear">Clear</button></div>
      ${list("🍳 Fry (vepudu)", res.fry, "fry")}
      ${list("🍲 Curry (kura, pulusu, pappu)", res.curry, "curry")}` : ""}` });
}

// Easy breakfasts from the kitchen, by when the work happens: that morning (MORNING_MINUTES at most,
// or no cooking), the night before (easy, EASY_NIGHT_MINUTES at most) or a weekend batch for the
// school week. Nothing that needs baking that morning. Food running out first; each child's needs
// from Profile are kept. With AI on, a button asks Claude for more ideas from the same kitchen.
const BREAKFAST_GROUPS = [
  { kinds: ["no-cook", "morning"], id: "morning", label: `☀️ Ready that morning, ${MORNING_MINUTES} min or less` },
  { kinds: ["night"], id: "night", label: `🌙 Easy the night before, ${EASY_NIGHT_MINUTES} min or less` },
  { kinds: ["weekend"], id: "weekend", label: "🗓️ Make on the weekend for the school week" },
];
function renderQuickBreakfasts() {
  const opt = { schoolNutFree: nutFreeOn(), cuisines: cuisinePicks(), frozen: frozenOnHand(), staples: staplesOn(), useSoon: useSoonOn(TODAY), appliances: appliancesOwned(), settings: state.settings };
  const all = quickBreakfasts(state.pantry, { ...opt, limit: 40 });
  const baby = quickBreakfasts(state.pantry, { ...opt, forWhom: "baby", limit: 3 });
  const soon = useSoonOn(TODAY);
  const row = (x) => {
    const r = x.recipe;
    const uses = r.ingredients.map((i) => i.name).filter((n) => soon.get(normName(n)) >= 0.7);
    const when = x.kind === "night" || x.kind === "weekend" ? busyLabel(r) : x.kind === "no-cook" ? "⏱️ No cooking" : `⚡ ${x.minutes} min`;
    return `<button type="button" class="ready-item" data-action="view-recipe" data-id="${esc(r.id)}" data-testid="quick-breakfast" data-kind="${x.kind}">
      ${art(r, "sm")}<span class="grow"><strong>${esc(r.title)}</strong>${r.familyFavorite ? " ⭐" : ""} <span aria-hidden="true">${tagIcons(r)}</span>
        <span class="small muted">${esc(when)} · ${esc(whoLabel(r.forWhom, state.settings))}${x.missing.length ? ` · need ${esc(x.missing.join(", "))}` : " · all at home"}${uses.length ? ` · <span style="color:var(--warn)">uses ${esc(uses.join(", "))} before it runs out</span>` : ""}</span></span>
      <span aria-hidden="true">›</span></button>`;
  };
  const groups = BREAKFAST_GROUPS.map((g) => ({ ...g, items: all.filter((x) => g.kinds.includes(x.kind)).slice(0, 4) })).filter((g) => g.items.length);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const ai = aiOnline()
    ? `<button type="button" class="btn sm" data-action="ai-breakfasts" data-testid="ai-breakfasts" ${ui.aiBusy ? "disabled" : ""}>✨ More breakfast ideas with AI</button>`
    : `<p class="small muted">For more ideas from your kitchen, <button type="button" class="linkish" data-action="open-ai-key">add a Claude API key</button>.</p>`;
  return section({ id: "sec-quick-breakfast", icon: "⚡", title: "Easy breakfasts", testid: "quick-breakfasts",
    meta: count ? `${count} from your kitchen: that morning, the night before or the weekend` : "That morning, the night before or the weekend",
    body: `
    ${groups.length ? groups.map((g) => `<h3>${g.label}</h3><div class="ready-list" data-testid="quick-breakfast-${g.id}">${g.items.map(row).join("")}</div>`).join("") : `<p class="small muted" data-testid="quick-breakfast-none">No easy breakfast in the recipe book fits what's in the kitchen. Add eggs, bread, rava or batter and they show up here.</p>`}
    ${baby.length ? `<h3>${esc(whoLabel("baby", state.settings))}</h3><div class="ready-list" data-testid="quick-breakfast-baby">${baby.map(row).join("")}</div>` : ""}
    <div class="row" style="margin-top:8px">${ai}</div>` });
}

// Recipes from the Markdown recipe book that the pantry can make now, or with one item to buy.
function renderReadyToCook() {
  const book = RECIPE_BOOK_STATUS;
  const trouble = book.failed.length || book.problems.length ? `<div class="notice info small" data-testid="recipe-book-problems">
      ${book.failed.length ? `Couldn't read ${book.failed.map((f) => esc(f.file)).join(", ")} from the recipe book. ` : ""}
      ${book.problems.length ? `${book.problems.length} recipe${book.problems.length > 1 ? "s" : ""} in the recipe book need fixing: ${book.problems.slice(0, 5).map((p) => `${esc(p.file)}${p.line ? " line " + p.line : ""} “${esc(p.title)}”: ${esc(p.message)}`).join("; ")}` : ""}
    </div>` : "";
  const opt = { schoolNutFree: nutFreeOn(), cuisines: cuisinePicks(), frozen: frozenOnHand(), staples: staplesOn(), useSoon: useSoonOn(TODAY), settings: state.settings };
  const now = readyToCook(state.pantry, { ...opt, limit: 8 });
  const nearly = readyToCook(state.pantry, { ...opt, maxMissing: 1, limit: 30 }).filter((x) => x.missing.length === 1).slice(0, 8);
  const row = (x, testid = "ready-recipe") => `<button type="button" class="ready-item" data-action="view-recipe" data-id="${esc(x.recipe.id)}" data-testid="${testid}">
      ${art(x.recipe, "sm")}<span class="grow"><strong>${esc(x.recipe.title)}</strong>${x.recipe.familyFavorite ? " ⭐" : ""} <span aria-hidden="true">${tagIcons(x.recipe)}</span>
        <span class="small muted">${esc(whoLabel(x.recipe.forWhom, state.settings))} · ${esc(x.recipe.cuisine || x.recipe.mealType)}${x.missing.length ? ` · need ${esc(x.missing.join(", "))}` : ""}${x.fromFreezer?.length ? ` · 🧊 from the freezer: ${esc(x.fromFreezer.join(", "))}` : ""}</span></span>
      <span aria-hidden="true">›</span></button>`;
  return section({ id: "sec-ready", icon: "🍳", title: "Ready to cook from your kitchen", testid: "ready-to-cook",
    meta: `${now.length} ready now${nearly.length ? ` · ${nearly.length} need one thing` : ""}`, open: !!trouble,
    body: `
    ${trouble}
    ${now.length ? `<div class="ready-list">${now.map((x) => row(x)).join("")}</div>` : `<p class="small muted">${state.pantry.length ? "Nothing in the recipe book can be made with only what's in the kitchen yet." : "Add what you have in the kitchen and recipes you can make right away show up here."}</p>`}
    ${nearly.length ? `<h3>Just one thing to buy</h3><div class="ready-list" data-testid="nearly-ready">${nearly.map((x) => row(x)).join("")}</div>` : ""}
    <p class="small muted" style="margin-top:8px">${LIBRARY.length} recipes in the family recipe book (the <code>recipes/</code> folder in the repository).</p>` });
}

// Top picks: easy recipes with the kitchen's vegetables, from the cuisines picked in Profile.
function renderTopPicks() {
  const opt = { schoolNutFree: nutFreeOn(), cuisines: cuisinePicks(), frozen: frozenOnHand(), staples: staplesOn(), useSoon: useSoonOn(TODAY), settings: state.settings };
  const picks = topPicks(state.pantry, { ...opt, isVegetable: isMainVeg, limit: ui.morePicks ? 15 : 5 });
  const names = cuisinePicks().map((id) => CUISINES.find((x) => x.id === id).label.replace(/ \(.*\)/, ""));
  // Top picks are picture cards in a row you swipe sideways, like a recipe app's "for you" shelf.
  const pick = (x) => {
    const r = x.recipe;
    const a = foodArt(r);
    return `<button type="button" class="pick-card" data-action="view-recipe" data-id="${esc(r.id)}" data-testid="top-pick">
      <span class="pick-art tone-${a.tone}" aria-hidden="true">${a.emoji}${r.familyFavorite ? '<i class="fav">⭐</i>' : ""}${r.prepMinutes ? `<i class="time">${esc(r.prepMinutes)} min</i>` : ""}</span>
      <strong>${esc(r.title)}</strong>
      <span class="small muted">${esc(whoLabel(r.forWhom, state.settings))}${x.missing.length ? ` · need ${esc(x.missing.join(", "))}` : " · all in the kitchen"}</span>
    </button>`;
  };
  return picks.length ? `<div class="card picks" data-testid="top-picks">
    <div class="row between"><h2>🌟 Top picks for you</h2>${ui.morePicks || picks.length < 5 ? "" : '<button type="button" class="btn sm ghost" data-action="more-picks" data-testid="more-picks">Show more</button>'}</div>
    <p class="small muted">Easy recipes with the vegetables in your kitchen${names.length ? `, from ${esc(names.join(", "))}` : ""}. ${names.length ? "Change cuisines" : "Pick your cuisines"} in <button type="button" class="linkish" data-action="open-profile">👤 Profile</button>.</p>
    <div class="pick-row">${picks.map(pick).join("")}</div>
  </div>` : "";
}

// Leftover makeovers: when yesterday's or today's plan has a curry, what it can turn into.
// Otherwise a short list of the book's makeovers, for leftovers that weren't planned.
// Folded either way, so it doesn't push the rest of the tab down.
function renderLeftoverIdeas() {
  const cuisines = cuisinePicks();
  const recent = [...leftoversFrom(addDays(TODAY, -1)), ...leftoversFrom(TODAY)];
  const fromPlan = recent.map((l) => ({ l, list: leftoverRecipesFor(l.kind, { cuisines }) })).filter((x) => x.list.length);
  const item = (r) => `<button type="button" class="ready-item" data-action="view-recipe" data-id="${esc(r.id)}" data-testid="leftover-recipe">
      ${art(r, "sm")}<span class="grow"><strong>${esc(r.title)}</strong> <span aria-hidden="true">${tagIcons(r)}</span>
        <span class="small muted">${esc(whoLabel(r.forWhom, state.settings))} · ${esc(r.cuisine || r.mealType)}${r.prepMinutes ? " · " + esc(r.prepMinutes) + " min" : ""}</span></span>
      <span aria-hidden="true">›</span></button>`;
  if (fromPlan.length) {
    return section({ id: "sec-leftovers", icon: "♻️", title: "Leftover makeovers", testid: "leftover-ideas",
      meta: `${esc(fromPlan.map(({ l }) => l.title).join(", "))} can become something new`,
      body: `
      ${fromPlan.map(({ l, list }) => `<p class="small">${esc(l.title)} can become:</p><div class="ready-list">${list.slice(0, 4).map(item).join("")}</div>`).join("")}
      <p class="small muted" style="margin-top:8px">Put leftovers in the fridge within 2 hours, use them the next day, and reheat until steaming hot.</p>` });
  }
  const all = LIBRARY.filter((r) => r.leftover).sort((a, b) => inCuisines(b, cuisines) - inCuisines(a, cuisines)).slice(0, 4);
  if (!all.length) return "";
  return section({ id: "sec-leftovers", icon: "♻️", title: "Got leftover curry?", testid: "leftover-ideas", meta: "Roti quesadillas, kathi rolls, kari dosa and more",
    body: `<div class="ready-list">${all.map(item).join("")}</div>` });
}

// Estimated nutrition for one serving, worked out from the ingredients. For the baby's and the
// 4-year-old's recipes it also shows how much of that child's day one serving covers.
const fmtNutrient = (n, x) => `${x}${n.unit === "kcal" ? " kcal" : " " + n.unit}`;
function nutritionPanel(r) {
  if (!r.ingredients?.length) return "";
  const { servings, perServing, missing, counted } = estimateNutrition(r);
  // Too little of the recipe is known (an AI recipe with unusual ingredients) to be worth showing.
  if (!perServing.kcal || missing.length > counted) return "";
  const need = DAILY_NEEDS[r.forWhom];
  const share = dailyShare(perServing, r.forWhom);
  const named = String((r.forWhom === "baby" ? state.settings?.babyName : state.settings?.kidName) || "").trim();
  const childName = named || `the ${need?.label}`;
  const pick = (k) => NUTRIENTS.find((n) => n.key === k);
  const headline = `${fmtNutrient(pick("kcal"), perServing.kcal)} · ${fmtNutrient(pick("protein"), perServing.protein)} protein · ${fmtNutrient(pick("iron"), perServing.iron)} iron`;
  const rows = NUTRIENTS.map((n) => `<tr><th scope="row">${esc(n.label)}</th><td>${esc(fmtNutrient(n, perServing[n.key]))}</td>${need ? `<td>${share[n.key] != null ? esc(share[n.key]) + "%" : ""}</td>` : ""}</tr>`).join("");
  const serving = servings > 1 ? `one of ${servings} servings${r.servingNote ? ` (${esc(r.servingNote)})` : ""}` : "one serving";
  return `<details class="nutrition" data-testid="recipe-nutrition"><summary>Nutrition <span class="muted" data-testid="nutrition-headline">≈ ${esc(headline)}</span></summary>
    <table class="nutrition-table"><thead><tr><th scope="col">Per serving</th><th scope="col">About</th>${need ? `<th scope="col">Of ${esc(childName)}'s day</th>` : ""}</tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted">Estimated from the ingredients for ${serving}, not measured.${r.forWhom === "baby" ? " Breast milk or formula still gives the baby most of the day's needs." : ""}${missing.length ? ` Not counted: ${esc(missing.join(", "))}.` : ""}</p>
  </details>`;
}

function recipeCard(r, { saved = false } = {}) {
  const safety = checkForAudience(r, { schoolNutFree: nutFreeOn() });
  const missing = new Set(shoppingNeeds(r).map((i) => normName(i.name)));
  const hasNuts = r.nutFree === false || r.ingredients.some((i) => isNutIngredient(i.name));
  const isSaved = state.savedRecipes.some((s) => s.id === r.id || s.title === r.title);
  const issues = [...safety.errors, ...safety.warnings];
  const methods = methodsFor(r, appliancesOwned());
  const a = foodArt(r);
  return `<article class="card recipe" data-testid="recipe-card" data-recipe-id="${esc(r.id)}" data-safe="${safety.safe}">
    <div class="recipe-art tone-${a.tone}" aria-hidden="true"><span>${a.emoji}</span>${r.prepMinutes ? `<i>⏱️ ${esc(r.prepMinutes)} min</i>` : ""}</div>
    <div class="row between"><h3>${esc(r.title)}</h3><span>${r.familyFavorite ? '<span class="pill warn" data-testid="family-favorite">⭐ Family favorite</span> ' : ""}${whoPill(r.forWhom)}</span></div>
    ${hasNuts && !nutFreeOn() ? `<div class="small muted" data-testid="contains-nuts">🥜 Contains nuts${r.nutFreeSwap ? ". Nut-free swap: " + esc(r.nutFreeSwap) : ""}</div>` : ""}
    <div class="small muted">${r.cuisine ? esc(r.cuisine) + " · " : ""}${esc(r.mealType || "")}${r.prepMinutes ? " · " + esc(r.prepMinutes) + " min" : ""}${r.busyMorning && r.mealType !== "side" ? ` · <span data-testid="busy-morning-tag">${esc(busyLabel(r))}</span>` : ""}${r.texture ? " · " + esc(r.texture) : ""}${r.source === "ai" ? " · ✨ AI" : r.source === "library" ? " · Family recipe book" : ""}</div>
    ${methods.length ? `<div class="appliance-methods" data-testid="appliance-methods">${methods.map((m) => `<p class="small" data-appliance="${m.key}"><strong>${m.icon} ${esc(m.label)}${m.key === "airFryer" && state.settings.airFryer === "dual" ? " (two baskets)" : ""}:</strong> ${esc(m.text)}</p>`).join("")}</div>` : ""}
    ${r.tags?.length ? `<div class="small" data-testid="recipe-tags">${r.tags.map((t) => esc(TAG_LABELS[t])).join(" · ")}</div>` : ""}
    <div class="safety ${safety.safe && !safety.warnings.length ? "ok" : safety.safe ? "warn" : "warn"}" data-testid="safety-badge">
      ${safety.safe ? (safety.warnings.length ? "⚠️ Safe with care" : "✅ Age-safe") : "⛔ Not safe as written"}
      ${issues.length ? `<ul>${issues.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul>` : ""}
    </div>
    ${morningExtras(r)}
    ${nutritionPanel(r)}
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

// Weekdays are busy mornings unless the parent unticks it.
const genBusy = () => ui.gen.busy ?? isSchoolDay(TODAY);
const BUSY_NOTE = "Busy weekday morning: nothing baked or cooked for long that morning. The family likes a warm breakfast made the night before (easy, 20 minutes or less) and reheated in the microwave (upma, idlis, egg wraps), or a weekend batch that keeps (burritos, parathas, egg muffins), with an easy side dip; otherwise no cooking (bread with peanut butter or avocado).";

// What the recipe AI is told about the kitchen: what runs out soon and the staples always at home.
function kitchenRequest() {
  return {
    ingredients: state.pantry,
    useSoon: expiryList().filter((e) => e.daysLeft <= 4).map((e) => `${e.name} (${e.daysLeft < 0 ? "use now" : `runs out ${daysLeftLabel(e.daysLeft)}`})`),
    staples: staplesOn(),
    childNeeds: prefsPrompt(state.settings),
    schoolNutFree: nutFreeOn(),
    appliances: applianceRequest(state.settings),
  };
}
const cuisineNote = () => (cuisinePicks().length ? `The family mostly cooks ${cuisinePicks().map((id) => CUISINES.find((x) => x.id === id).label).join(", ")}.` : "");

async function generate(form) {
  ui.gen = { forWhom: form.forWhom.value, mealType: form.mealType.value, notes: form.notes.value, quick: form.quick.checked, busy: form.busy.checked };
  const busyMorning = ui.gen.busy && ui.gen.mealType === "breakfast";
  await askRecipes({
    ...kitchenRequest(),
    forWhom: form.forWhom.value,
    mealType: form.mealType.value,
    notes: [form.notes.value.trim(), busyMorning ? BUSY_NOTE : "", cuisineNote()].filter(Boolean).join(" ").slice(0, 300),
    count: ui.gen.quick ? 1 : 4,
    quick: ui.gen.quick,
  }, { busyMorning });
}

// "✨ More breakfast ideas with AI" in Quick breakfasts: three quick, easy family breakfasts the
// 4-year-old eats too, from the kitchen, cooking first what runs out. Shown with the AI results.
async function aiBreakfasts() {
  ui.gen = { ...ui.gen, forWhom: "family", mealType: "breakfast", quick: false };
  await askRecipes({
    ...kitchenRequest(),
    forWhom: "family",
    mealType: "breakfast",
    notes: [`Easy breakfasts the 4-year-old eats too (mild, nothing whole), with few ingredients and short steps. Each must be either ready in ${MORNING_MINUTES} minutes that morning, or easy prep the night before (${EASY_NIGHT_MINUTES} minutes or less) that's reheated or eaten cold; anything baked or slower only as a weekend batch that keeps. Say which in the notes.`, cuisineNote()].filter(Boolean).join(" ").slice(0, 400),
    count: 3,
    quick: false,
  }, { busyMorning: false, maxMinutes: QUICK_MINUTES });
  $("[data-testid=recipe-results]")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function askRecipes(body, { busyMorning = false, maxMinutes = 0 } = {}) {
  ui.aiNotice = "";
  ui.rejected = [];
  const fallback = (why) => {
    ui.results = suggestFromLibrary(state.pantry, { forWhom: body.forWhom, mealType: body.mealType, limit: body.quick ? 1 : 6, schoolNutFree: body.schoolNutFree, maxMinutes: body.quick ? QUICK_MINUTES : maxMinutes, cuisines: cuisinePicks(), frozen: frozenOnHand(), appliances: appliancesOwned(), busyMorning, staples: staplesOn(), useSoon: useSoonOn(TODAY), settings: state.settings, child: ["baby", "kid"].includes(body.forWhom) ? body.forWhom : "" });
    ui.aiNotice = ui.results.length ? `${why} Showing recipes from the built-in family recipe book that best match your kitchen.`
      : `${why} The built-in family recipe book has nothing for ${body.forWhom === "family" ? "the whole family" : whoLabel(body.forWhom, state.settings)}${body.mealType ? ` at ${body.mealType}` : ""} yet. Try another meal, or add a recipe to the recipes/ folder.`;
  };
  if (!aiOnline()) {
    fallback(ui.ai === "unknown" ? "The recipe AI is still being checked." : "AI recipes are off. To turn them on, add a Claude API key in 👤 Profile.");
    render();
    return;
  }
  ui.aiBusy = true;
  ui.aiController = new AbortController();
  const timer = setTimeout(() => ui.aiController?.abort("timeout"), ui.ai === "key" ? KEY_AI_TIMEOUT_MS : AI_TIMEOUT_MS);
  render();
  const started = performance.now();
  try {
    let res, data;
    if (ui.ai === "key") {
      try {
        data = await browserRecipes(body, { signal: ui.aiController.signal });
        res = { ok: true };
      } catch (err) {
        if (ui.aiController?.signal.aborted) throw err;
        res = { ok: false };
        data = { error: err.message };
      }
    } else {
      res = await fetch("api/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ui.aiController.signal,
      });
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
      fallback((data.error || "The recipe AI is unavailable.") + "");
    } else {
      // The AI is told each child's needs; anything that still breaks a hard one (no egg, no dairy, gas) is left out.
      const all = data.recipes || [];
      ui.results = all.filter((r) => !prefProblem(r, r.forWhom, state.settings));
      ui.rejected = [...(data.rejected || []), ...all.filter((r) => prefProblem(r, r.forWhom, state.settings)).map((r) => ({ title: r.title, errors: [{ rule: `${whoLabel(r.forWhom, state.settings)}: ${prefProblem(r, r.forWhom, state.settings)}` }] }))];
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
    .map((i) => ({ id: uid(), name: i.name, label: String(i.name).trim(), quantity: i.quantity ?? null, unit: normUnit(i.unit), store: i.store || "", bought: false, source: i.source || source, keys: i.key ? [i.key] : [] }));
  state.shopping = mergeItems([...state.shopping, ...fresh]).map((i) => ({ ...i, id: i.id || uid() }));
  return fresh.length;
}

function planDialog(recipe) {
  const dlg = document.createElement("dialog");
  const slots = SLOTS.filter((s) => recipe.forWhom === "family" ? true : s.who === recipe.forWhom || s.who === "family");
  dlg.innerHTML = `<form method="dialog" class="stack">
    <h2>Plan “${esc(recipe.title)}”</h2>
    <label class="field"><span>Date</span><input type="date" name="date" value="${ui.selected >= TODAY ? ui.selected : TODAY}" required data-testid="plan-date"></label>
    <label class="field"><span>Meal</span><select name="slot" data-testid="plan-slot">${slots.map((s) => `<option value="${s.id}">${esc(slotLabel(s, state.settings))}</option>`).join("")}</select></label>
    <div class="row"><button class="btn primary" value="ok" data-testid="plan-confirm">Add to plan</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "ok") {
      const f = dlg.querySelector("form");
      const date = f.date.value;
      if (isDateKey(date)) {
        if (!state.savedRecipes.some((s) => s.id === recipe.id) && recipe.source !== "library") state.savedRecipes.push(recipe);
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
const AISLE_ICONS = {
  "Vegetables": "🥬", "Fruits": "🍎", "Rice, dals & flours": "🌾", "Dairy & eggs": "🥚", "Spices & tempering": "🧂",
  "Oil, nuts & dry fruits": "🥜", "Baby care": "🍼", "School & household": "🧻", "Other": "🛍️",
};
const UNITS = ["pcs", "g", "kg", "ml", "l", "packet", "bunch", "dozen"];
// One-tap items offered in the add sheet when they aren't already on the list.
const SHOP_STAPLES = ["milk", "egg", "curd", "banana", "bread", "paneer", "spinach", "tomato", "onion", "almond", "diapers", "wipes"];

// Quantity as people say it: "4" not "4 pcs", and nothing for a single piece.
function shopQty(i) {
  if (i.unit === "pcs" || !i.unit) return i.quantity == null || i.quantity === 1 ? "" : `× ${i.quantity}`;
  return formatQty(i);
}

function shopRow(i) {
  const meta = [shopQty(i), i.store].filter(Boolean).map(esc).join(" · ");
  return swipeRow({
    testid: "shop-item",
    cls: `shop-item ${i.bought ? "bought" : ""}`,
    data: `data-kind="shop" data-id="${esc(i.id)}" data-name="${esc(i.name)}"`,
    leftLabel: i.bought ? "Put back" : "Got it",
    check: `<input type="checkbox" class="big-check" data-action="shop-toggle" data-id="${esc(i.id)}" ${i.bought ? "checked" : ""} aria-label="Got ${esc(i.name)}">`,
    pic: art(i.name, "row", AISLE_ICONS[aisleFor(i.name)]),
    body: `<span class="name">${esc(i.label || i.name)}</span>${meta ? `<span class="meta" data-testid="shop-qty-label">${meta}</span>` : ""}`,
    // 🗑 takes off something added by mistake; ticking it instead moves it to the kitchen.
    more: `<button type="button" class="iconbtn lg" data-action="shop-del" data-id="${esc(i.id)}" aria-label="Delete ${esc(i.name)}" title="Delete (added by mistake)" data-testid="shop-delete">🗑</button>
      <button type="button" class="iconbtn lg" data-action="shop-more" data-id="${esc(i.id)}" aria-label="Details for ${esc(i.name)}" data-testid="shop-more">⋯</button>`,
  });
}

function renderShopping() {
  const inStore = (i) => ui.shopStore === "all" || (i.store || "") === ui.shopStore;
  const items = state.shopping.filter(inStore);
  const toBuy = items.filter((i) => !i.bought);
  const inCart = items.filter((i) => i.bought);
  const groups = groupByAisle(toBuy);
  const left = state.shopping.filter((i) => !i.bought).length;
  const pct = items.length ? Math.round((inCart.length / items.length) * 100) : 0;

  document.body.classList.toggle("in-store", ui.storeMode);
  $("#view-shopping").innerHTML = `
    <div class="card shop-head ${ui.storeMode ? "store-mode" : ""}">
      <div class="row between">
        <h2>${ui.storeMode ? "At the store" : "Shopping list"} <span class="pill" data-testid="shop-left">${left} to buy</span></h2>
        <button class="btn ${ui.storeMode ? "primary" : ""}" data-action="store-mode" aria-pressed="${ui.storeMode}" data-testid="store-mode">${ui.storeMode ? "✓ Done shopping" : "🛒 I'm at the store"}</button>
      </div>
      ${items.length && (ui.storeMode || inCart.length) ? `<div class="progress big" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <p class="small muted" style="margin:4px 0 0" data-testid="shop-progress">${inCart.length} of ${items.length} in the cart${ui.storeMode ? " · tap an item when it's in the cart" : ""}</p>` : ""}
      ${ui.storeMode ? "" : `<form class="quick-add" data-form="shop-quick-add" data-testid="shop-quick-form">
        <input type="text" name="name" placeholder="Add an item, e.g. milk" aria-label="Add an item" data-testid="shop-quick-add" autocomplete="off" enterkeyhint="done" required>
        <button class="btn primary" aria-label="Add">Add</button>
      </form>`}
      <div class="seg scroll-x" role="group" aria-label="Store filter" data-testid="store-filter">
        <button data-action="shop-store" data-store="all" aria-pressed="${ui.shopStore === "all"}">All stores</button>
        ${state.stores.map((s) => `<button data-action="shop-store" data-store="${esc(s)}" aria-pressed="${ui.shopStore === s}">${esc(s)}</button>`).join("")}
      </div>
    </div>
    <div data-testid="shop-list" class="${ui.storeMode ? "store-mode" : ""}">
      ${groups.length ? `<div class="card aisles">${groups.map(([aisle, list]) => `<section class="aisle" data-testid="aisle">
        <h3><span class="aisle-icon" aria-hidden="true">${AISLE_ICONS[aisle] || "🛍️"}</span>${esc(aisle)}<span class="aisle-count">${list.length}</span></h3>
        ${list.map(shopRow).join("")}
      </section>`).join("")}</div>` : ""}
      ${!toBuy.length ? `<div class="card empty-state" data-testid="shop-empty">${items.length ? `🎉 Everything is in the cart.${ui.storeMode ? '<button class="btn primary big" style="display:flex;width:100%;margin-top:12px" data-action="store-mode" data-testid="store-done">✓ Done shopping</button>' : ""}` : "The list is empty. Tap <strong>+ Add item</strong>, or pull items from your meal plan."}</div>` : ""}
      ${inCart.length ? `<details class="card cart" data-testid="shop-cart" data-cart ${ui.cartOpen ? "open" : ""}>
        <summary><span class="aisle-icon" aria-hidden="true">🛒</span>In the cart <span class="aisle-count">${inCart.length}</span></summary>
        ${inCart.sort((a, b) => a.name.localeCompare(b.name)).map(shopRow).join("")}
        ${ui.storeMode ? "" : `<button class="btn danger" style="margin-top:8px" data-action="clear-bought" data-testid="clear-bought">Clear the cart</button>`}
      </details>` : ""}
      ${items.length ? '<p class="small muted swipe-hint">Tip: tick or swipe right when you have it. Added by mistake? Tap 🗑 or swipe left to delete.</p>' : ""}
    </div>
    ${ui.storeMode ? "" : section({ id: "sec-fill", icon: "📋", title: "Fill the list", meta: "From the meal plan, copy as text, stores", body: `
      <div class="row">
        <button class="btn" data-action="plan-to-shopping" data-testid="plan-to-shopping">From next 7 days of meals</button>
        <button class="btn" data-action="copy-list" data-testid="copy-list">Copy list as text</button>
      </div>
      <details class="shop-extra" style="margin-top:10px"><summary>Stores</summary>
        <div class="chips" style="margin-top:8px">${state.stores.map((s) => `<span class="chip">${esc(s)}<button data-action="store-del" data-store="${esc(s)}" aria-label="Remove ${esc(s)}">✕</button></span>`).join("")}</div>
        <form data-form="store-add" class="row" style="margin-top:8px"><input type="text" name="store" class="grow" placeholder="Add a store" required><button class="btn sm">Add</button></form>
      </details>` })}
    <button class="fab" data-action="shop-fab" data-testid="shop-fab" aria-label="Add item with amount and store"><span aria-hidden="true">＋</span> Add item</button>`;
}

function shopAddSheet() {
  const onList = new Set(state.shopping.filter((i) => !i.bought).map((i) => normName(i.name)));
  const again = [...new Set([...state.shopping.filter((i) => i.bought).map((i) => i.name), ...SHOP_STAPLES])].filter((n) => !onList.has(normName(n))).slice(0, 12);
  const store = ui.shopStore === "all" ? "" : ui.shopStore;
  sheet("shop-sheet", `<form data-form="shop-add" class="stack">
    <div class="row between"><h2>Add to the list</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <input type="text" name="name" placeholder="Item (e.g. toor dal)" required aria-label="Item" data-testid="shop-name" class="big-input" autocomplete="off" enterkeyhint="done">
    ${again.length ? `<div class="field"><span>Tap to add</span><div class="chips scroll-x" data-testid="shop-quick-list">${again.map((n) => `<button type="button" class="chip add big" data-action="shop-quick" data-name="${esc(n)}" data-testid="shop-quick">+ ${esc(n)}</button>`).join("")}</div></div>` : ""}
    <div class="field"><span>How much</span>
      <div class="stepper">
        <button type="button" class="btn big" data-action="qty-step" data-delta="-1" aria-label="Less">−</button>
        <input type="number" name="qty" min="0" step="any" placeholder="Qty" inputmode="decimal" aria-label="Quantity" data-testid="shop-qty">
        <button type="button" class="btn big" data-action="qty-step" data-delta="1" aria-label="More">+</button>
      </div>
    </div>
    <div class="field"><span>Unit</span>${chipRadios("unit", UNITS.map((u) => [u, u]), "", "shop-unit")}</div>
    <div class="field"><span>Store</span>${chipRadios("store", [["", "Any store"], ...state.stores.map((s) => [s, s])], store, "shop-store")}</div>
    <button class="btn primary big" data-testid="shop-add">Add to list</button>
  </form>`);
  $("[data-testid=shop-name]")?.focus();
}

function shopItemSheet(it) {
  const units = UNITS.includes(it.unit) || !it.unit ? UNITS : [...UNITS, it.unit];
  sheet("shop-item-sheet", `<form data-form="shop-edit" class="stack" data-id="${esc(it.id)}">
    <div class="row between"><h2>${AISLE_ICONS[aisleFor(it.name)] || "🛍️"} ${esc(it.label || it.name)}</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    ${it.sources?.length ? `<p class="small muted" style="margin:0">For: ${esc(it.sources.join(", "))}</p>` : ""}
    <label class="field"><span>Name</span><input type="text" name="name" required value="${esc(it.label || it.name)}" data-testid="shop-edit-name"></label>
    <div class="field"><span>How much</span>
      <div class="stepper">
        <button type="button" class="btn big" data-action="qty-step" data-delta="-1" aria-label="Less">−</button>
        <input type="number" name="qty" min="0" step="any" value="${it.quantity ?? ""}" inputmode="decimal" aria-label="Quantity" data-testid="shop-edit-qty">
        <button type="button" class="btn big" data-action="qty-step" data-delta="1" aria-label="More">+</button>
      </div>
    </div>
    <div class="field"><span>Unit</span>${chipRadios("unit", units.map((u) => [u, u]), it.unit || "", "shop-edit-unit")}</div>
    <div class="field"><span>Store</span>${chipRadios("store", [["", "Any store"], ...state.stores.map((s) => [s, s])], it.store || "", "shop-edit-store")}</div>
    <button class="btn primary big" data-testid="shop-edit-save">Save</button>
    <div class="row">
      <button type="button" class="btn big grow" data-action="shop-sheet-toggle" data-id="${esc(it.id)}">${it.bought ? "↩ Put back on the list" : "✓ Got it"}</button>
      <button type="button" class="btn danger big grow" data-action="shop-del" data-id="${esc(it.id)}" data-testid="shop-edit-delete">Delete</button>
    </div>
  </form>`);
}

// Ticks or unticks an item. Bought food goes straight into the kitchen so meal suggestions
// can use it; unticking takes back only what the tick added. Returns the message to show.
function setBought(it, bought) {
  it.bought = bought;
  const name = it.label || it.name;
  if (bought && aisleFor(it.name) !== "Baby care" && aisleFor(it.name) !== "School & household" && !state.pantry.some((p) => normName(p) === normName(it.name))) {
    state.pantry.push(it.name);
    noteAdded(it.name);
    it.addedToPantry = true;
    clearCaches();
    return `Got ${name} · added to your kitchen`;
  }
  if (!bought && it.addedToPantry) {
    state.pantry = state.pantry.filter((p) => normName(p) !== normName(it.name));
    forgetDates(it.name);
    delete it.addedToPantry;
    clearCaches();
    return `${name} is back on the list and out of your kitchen`;
  }
  return bought ? `Got ${name}` : `${name} is back on the list`;
}

function toggleShopItem(id, bought) {
  const it = state.shopping.find((i) => i.id === id);
  if (!it) return;
  const msg = setBought(it, bought);
  save(state);
  // Let the tick show, then slide the row away into (or out of) the cart.
  const row = $(`.swipe[data-kind=shop][data-id="${CSS.escape(id)}"]`);
  row?.classList.toggle("bought", bought);
  row?.classList.add("leaving");
  clearTimeout(toggleShopItem.timer);
  rowChangedAt = Date.now();
  toggleShopItem.timer = setTimeout(() => { if (ui.tab === "shopping") renderShopping(); }, 260);
  // Look the item up again: a change from another phone may have replaced the object since.
  toast(msg, () => { const cur = state.shopping.find((i) => i.id === id); if (!cur) return; setBought(cur, !bought); save(state); if (ui.tab === "shopping") renderShopping(); });
}

function deleteShopItem(id) {
  const idx = state.shopping.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [it] = state.shopping.splice(idx, 1);
  commit();
  toast(`Deleted ${it.label || it.name}`, () => { if (!state.shopping.some((i) => i.id === it.id)) state.shopping.splice(idx, 0, it); commit(); });
}

function deleteTodo(id) {
  const idx = state.todos.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [t] = state.todos.splice(idx, 1);
  const done = () => { if (ui.tab === "calendar") commitDay(t.date); else commit(); };
  done();
  toast(`Deleted “${t.text}”`, () => { if (!state.todos.some((x) => x.id === t.id)) state.todos.splice(idx, 0, t); done(); });
}

function toggleTodo(id, doneNow) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  t.done = doneNow;
  if (ui.tab === "calendar") { commitDay(t.date); return; }
  commit();
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

// ---------- frozen ----------
const FROZEN_UNITS = ["packs", "boxes", "bags", "portions", "pcs"];
const FROZEN_IDEAS = ["Chapatis", "Parathas", "Idli batter", "Dosa batter", "Green peas", "Grated coconut", "Ginger garlic paste", "Mixed vegetables", "Sambar", "Dal", "Chicken", "Fish", "Baby purée cubes", "Ice cream"];
const FROZEN_OLD_DAYS = 90;   // past about three months, frozen food is worth using up first

function frozenAge(i) {
  const n = isDateKey(i.date) ? daysBetween(i.date, TODAY) : null;
  if (n == null) return "";
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

function frozenQty(i) {
  if (i.qty == null || i.qty === "") return "";
  const one = { packs: "pack", boxes: "box", bags: "bag", portions: "portion" };
  return i.unit ? `${i.qty} ${Number(i.qty) === 1 ? one[i.unit] || i.unit : i.unit}` : `× ${i.qty}`;
}

function frozenRow(i) {
  const old = isDateKey(i.date) && daysBetween(i.date, TODAY) >= FROZEN_OLD_DAYS;
  const age = frozenAge(i);
  const meta = [frozenQty(i), age ? `frozen ${age}` : "", i.note].filter(Boolean).map(esc).join(" · ");
  return swipeRow({
    testid: "frozen-item",
    cls: `frozen-item ${old ? "old" : ""}`,
    data: `data-kind="frozen" data-id="${esc(i.id)}" data-name="${esc(i.name)}"`,
    leftLabel: "Used one",
    check: `<input type="checkbox" class="big-check" data-action="frozen-use" data-id="${esc(i.id)}" aria-label="Used one ${esc(i.name)}">`,
    pic: art(i.name, "row", "🧊"),
    body: `<span class="name">${esc(i.name)}${old ? ' <span class="pill warn" data-testid="frozen-old">Use soon</span>' : ""}</span>${meta ? `<span class="meta" data-testid="frozen-meta">${meta}</span>` : ""}`,
    more: `<button type="button" class="iconbtn lg" data-action="frozen-more" data-id="${esc(i.id)}" aria-label="Edit ${esc(i.name)}" data-testid="frozen-more">⋯</button>`,
  });
}

function renderFrozen() {
  // Oldest first, so what has been in the freezer longest gets used first.
  const items = [...state.frozen].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || a.name.localeCompare(b.name));
  $("#view-frozen").innerHTML = `
    <div class="card">
      <div class="row between"><h2 style="margin:0">🧊 In the freezer</h2><span class="pill" data-testid="frozen-count">${items.length} item${items.length === 1 ? "" : "s"}</span></div>
      <div data-testid="frozen-list" style="margin-top:6px">${items.length ? items.map(frozenRow).join("") : '<p class="empty-state" data-testid="frozen-empty">Nothing in the freezer yet. Tap <strong>+ Add frozen item</strong> when you put something in.</p>'}</div>
      ${items.length ? '<p class="small muted swipe-hint">Tip: tap or swipe right when you take one out, swipe left to delete. Oldest is at the top.</p>' : ""}
    </div>
    <button class="fab" data-action="frozen-fab" data-testid="frozen-fab" aria-label="Add frozen item"><span aria-hidden="true">＋</span> Add frozen item</button>`;
}

function frozenSheet(it = null) {
  const have = new Set(state.frozen.map((i) => normName(i.name)));
  const ideas = it ? [] : FROZEN_IDEAS.filter((n) => !have.has(normName(n)));
  const units = !it?.unit || FROZEN_UNITS.includes(it.unit) ? FROZEN_UNITS : [...FROZEN_UNITS, it.unit];
  sheet(it ? "frozen-edit-sheet" : "frozen-sheet", `<form data-form="${it ? "frozen-edit" : "frozen-add"}" class="stack" ${it ? `data-id="${esc(it.id)}"` : ""}>
    <div class="row between"><h2>${it ? `🧊 ${esc(it.name)}` : "Add to the freezer"}</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <input type="text" name="name" placeholder="What (e.g. parathas)" required maxlength="80" value="${esc(it?.name || "")}" aria-label="What" data-testid="frozen-name" class="big-input" autocomplete="off" enterkeyhint="done">
    ${ideas.length ? `<div class="field"><span>Tap to fill in</span><div class="chips scroll-x" data-testid="frozen-ideas">${ideas.map((n) => `<button type="button" class="chip add big" data-action="frozen-idea" data-name="${esc(n)}" data-testid="frozen-idea">${esc(n)}</button>`).join("")}</div></div>` : ""}
    <div class="field"><span>How many</span>
      <div class="stepper">
        <button type="button" class="btn big" data-action="qty-step" data-delta="-1" aria-label="Less">−</button>
        <input type="number" name="qty" min="0" step="any" value="${it ? it.qty ?? "" : 1}" inputmode="decimal" aria-label="How many" data-testid="frozen-qty">
        <button type="button" class="btn big" data-action="qty-step" data-delta="1" aria-label="More">+</button>
      </div>
    </div>
    <div class="field"><span>Unit</span>${chipRadios("unit", units.map((u) => [u, u]), it ? it.unit || "" : "packs", "frozen-unit")}</div>
    <label class="field"><span>Frozen on</span><input type="date" name="date" value="${esc(it?.date || TODAY)}" max="${TODAY}" data-testid="frozen-date"></label>
    <label class="field"><span>Note (optional)</span><input type="text" name="note" maxlength="100" value="${esc(it?.note || "")}" placeholder="e.g. for the baby, top shelf" data-testid="frozen-note"></label>
    <button class="btn primary big" data-testid="${it ? "frozen-save" : "frozen-add"}">${it ? "Save" : "Add to freezer"}</button>
    ${it ? `<button type="button" class="btn danger big" data-action="frozen-del" data-id="${esc(it.id)}" data-testid="frozen-delete">Delete</button>` : ""}
  </form>`);
  if (!it) $("[data-testid=frozen-name]")?.focus();
}

// Takes one out of the freezer; the last one takes the item off the list. Can be undone.
function useFrozen(id) {
  const idx = state.frozen.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const it = state.frozen[idx];
  const before = { ...it };
  const qty = Number(it.qty);
  if (qty > 1) it.qty = qty - 1;
  else { state.frozen.splice(idx, 1); rowChangedAt = Date.now(); }   // the rows below move up: don't let the tap land on the next one
  commit();
  const left = qty > 1 ? `${frozenQty(it)} left` : "none left";
  toast(`Used ${before.name} · ${left}`, () => {
    const at = state.frozen.findIndex((i) => i.id === id);
    if (at >= 0) state.frozen[at] = before; else state.frozen.splice(idx, 0, before);
    commit();
  });
}

function deleteFrozen(id) {
  const idx = state.frozen.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [it] = state.frozen.splice(idx, 1);
  commit();
  toast(`Deleted ${it.name}`, () => { if (!state.frozen.some((i) => i.id === it.id)) state.frozen.splice(idx, 0, it); commit(); });
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
    ${section({ id: "sec-rem-new", icon: "➕", title: "New reminder", meta: "School events, vaccines, birthdays", open: !upcoming.length && !overdue.length, body: `
      <form data-form="rem-add" class="form-grid">
        <label class="field full"><span>What</span><input type="text" name="title" required maxlength="120" placeholder="e.g. School annual day, 9-month vaccine, PTM" data-testid="rem-title"></label>
        <label class="field"><span>Date</span><input type="date" name="date" required value="${esc(prefillDate || TODAY)}" data-testid="rem-date"></label>
        <label class="field"><span>Time</span><input type="time" name="time" data-testid="rem-time"></label>
        <label class="field"><span>Type</span><select name="category">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label class="field"><span>Repeat</span><select name="repeat" data-testid="rem-repeat"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">School days (Mon to Fri)</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label class="field full"><span>Notes</span><input type="text" name="notes" maxlength="200" placeholder="Optional"></label>
        <div class="full"><button class="btn primary" data-testid="rem-add">Add reminder</button></div>
      </form>` })}
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
  if (e.target.closest("#ai-chip")) {
    if (ui.ai === "off" || ui.ai === "unreachable") return profileDialog({ focusKey: true });
    ui.ai = "unknown"; renderHeader(); return checkAi();
  }
  if (e.target.closest("#cloud")) return profileDialog();
  if (e.target.closest("#profile")) return profileDialog();
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
        const sel = $(`[data-testid=cal-day-${ui.selected}]`);
        sel?.classList.add("sel");
        if (sel) $("[data-testid=cal-grid]").dataset.wk = sel.dataset.wk;
        $("#cal-day").innerHTML = renderDayPanel(ui.selected);
      }
      break;
    }
    case "month":
      // In the week view the arrows step a week at a time and the day moves with them.
      if (ui.calView === "week") ui.month = ui.selected = addDays(ui.selected, 7 * Number(el.dataset.delta));
      else ui.month = addMonths(ui.month, Number(el.dataset.delta));
      render();
      break;
    case "cal-view": setCalView(ui.calView === "week" ? "month" : "week"); ui.month = ui.selected; render(); break;
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
    case "swap-meal": swapMeal(ui.selected, el.dataset.slot); break;
    case "clear-slot": { const d = day(); delete d.meals[el.dataset.slot]; markEdited(d); commitDay(); break; }
    case "view-recipe": { const r = findRecipe(el.dataset.id); if (r) recipeDialog(r); break; }
    case "more-picks": ui.morePicks = true; render(); break;
    case "open-profile": profileDialog(); break;
    case "fill-week": fillWeek(); break;
    case "clear-week": clearWeek(); break;
    case "plan-chat": planChatSheet(); break;
    case "open-ai-key": $("dialog[data-testid=plan-chat]")?.close(); profileDialog({ focusKey: true }); break;
    case "chat-idea": { const t = $("dialog[data-testid=plan-chat] textarea"); if (t) { t.value = el.dataset.text; t.focus(); } break; }
    case "chat-undo": {
      const m = ui.chat.shown[Number(el.dataset.i)];
      if (m?.undo && !m.undone) { m.undo(); m.undone = true; m.undo = null; ui.chat.note = "(I undid the changes from one of your answers; the current plan above shows what is planned now.)"; renderChat(); toast("Changes undone."); }
      break;
    }
    case "chat-reset": ui.chat.controller?.abort(); ui.chat = { shown: [], turns: [], busy: false, controller: null }; renderChat(); break;
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
      if (e) { e.seed++; e.picks = null; e.chosen = {}; }
      renderDay();
      break;
    }
    case "suggest-swap": {
      const e = ui.suggest[ui.selected];
      if (e) { e.offsets[el.dataset.slot] = (e.offsets[el.dataset.slot] || 0) + 1; e.picks = null; if (e.chosen) delete e.chosen[el.dataset.slot]; }
      renderDay();
      break;
    }
    case "suggest-pick": {
      const e = ui.suggest[ui.selected];
      if (e) { (e.chosen ||= {})[el.dataset.slot] = el.dataset.id; e.picks = null; }
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
    case "todo-del": el.closest("dialog")?.close(); deleteTodo(el.dataset.id); break;
    case "frozen-fab": frozenSheet(); break;
    case "frozen-more": { const it = state.frozen.find((i) => i.id === el.dataset.id); if (it) frozenSheet(it); break; }
    case "frozen-del": el.closest("dialog")?.close(); deleteFrozen(el.dataset.id); break;
    case "frozen-idea": {
      const f = el.closest("form");
      f.name.value = el.dataset.name;
      f.qty.focus();
      break;
    }
    case "todo-more": { const t = state.todos.find((x) => x.id === el.dataset.id); if (t) todoSheet(t); break; }
    case "todo-sheet-date": {
      const f = el.closest("form");
      f.date.value = el.dataset.date;
      for (const b of f.querySelectorAll("[data-action=todo-sheet-date]")) b.classList.toggle("primary", b === el);
      break;
    }
    case "new-reminder": setTab("reminders"); renderReminders(el.dataset.date); $("[data-testid=rem-title]")?.focus(); break;
    case "export": downloadBackup(); break;

    case "pantry-del": state.pantry = state.pantry.filter((p) => p !== el.dataset.name); forgetDates(el.dataset.name); commit(); break;
    case "pantry-date": pantryDateSheet(el.dataset.name); break;
    case "pantry-date-clear": {
      const k = dateKeyOf(el.dataset.name);
      state.pantryDates = { ...pantryDates(), [k]: { ...(pantryDates()[k] || { added: TODAY }), expires: "" } };
      el.closest("dialog")?.close();
      commit();
      toast(`${el.dataset.name}: using the fridge estimate`);
      break;
    }
    case "ai-breakfasts": aiBreakfasts(); break;
    case "cook-veg": {
      const n = normName(el.dataset.name);
      ui.cookVeg = ui.cookVeg.some((v) => normName(v) === n) ? ui.cookVeg.filter((v) => normName(v) !== n) : [...ui.cookVeg, el.dataset.name];
      render();
      break;
    }
    case "cook-veg-clear": ui.cookVeg = []; render(); break;
    case "age-who": ui.age = { who: el.dataset.who, meal: "", all: false }; render(); break;
    case "age-meal": ui.age = { ...ui.age, meal: el.dataset.meal, all: false }; render(); break;
    case "age-all": ui.age = { ...ui.age, all: !ui.age.all }; render(); break;
    case "toggle-often": {
      const { who, id } = el.dataset;
      const r = findRecipe(id);
      const on = !isRegular(state.settings, who, id);
      state.settings.regulars = toggleRegular(state.settings, who, id);
      // The day panel's suggestions are cached: drop them so the change shows up straight away.
      ui.suggest = {};
      commit();
      toast(on ? `★ ${r?.title || "Recipe"} will come up often in the meal planner` : `${r?.title || "Recipe"} is no longer used often`);
      break;
    }
    case "pantry-quick": if (!state.pantry.some((p) => normName(p) === normName(el.dataset.name))) { state.pantry.push(el.dataset.name); noteAdded(el.dataset.name); } commit(); break;
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

    case "store-mode": setStoreMode(!ui.storeMode); break;
    case "shop-fab": shopAddSheet(); break;
    case "shop-more": { const it = state.shopping.find((i) => i.id === el.dataset.id); if (it) shopItemSheet(it); break; }
    case "shop-sheet-toggle": {
      const it = state.shopping.find((i) => i.id === el.dataset.id);
      el.closest("dialog")?.close();
      if (it) toggleShopItem(it.id, !it.bought);
      break;
    }
    case "shop-quick": {
      addToShopping([{ name: el.dataset.name }], "manual");
      commit();
      el.remove();
      toast(`Added ${el.dataset.name}`);
      break;
    }
    case "qty-step": {
      const inp = el.parentElement.querySelector("input[name=qty]");
      const n = Math.max(0, (Number(inp.value) || 0) + Number(el.dataset.delta));
      inp.value = n || "";
      break;
    }
    case "shop-store": ui.shopStore = el.dataset.store; render(); break;
    case "shop-del": el.closest("dialog")?.close(); deleteShopItem(el.dataset.id); break;
    case "plan-to-shopping": {
      const needs = plannedRecipes(TODAY, 7).flatMap(({ date, slot, recipe }) => shoppingNeeds(recipe).map((i) => ({ ...i, source: prettyDate(date), key: `${date}|${slot}|${recipe.id}|${normName(i.name)}` })));
      if (!needs.length) { toast("Nothing missing for the next 7 days of planned meals."); break; }
      const added = addToShopping(needs);
      commit();
      toast(added ? `Added ${added} ingredient${added > 1 ? "s" : ""} from the meal plan.` : "Everything for the next 7 days is already on the list.");
      break;
    }
    case "clear-bought": {
      const cleared = state.shopping.filter((i) => i.bought);
      const n = cleared.length;
      state.shopping = state.shopping.filter((i) => !i.bought);
      commit();
      // Put back only what was cleared, so items another phone added meanwhile stay.
      toast(`Cleared ${n} item${n === 1 ? "" : "s"} from the cart`, () => {
        state.shopping = [...state.shopping, ...cleared.filter((c) => !state.shopping.some((i) => i.id === c.id))];
        commit();
      });
      break;
    }
    case "copy-list": {
      const text = groupByAisle(state.shopping.filter((i) => !i.bought)).map(([aisle, list]) => `${aisle}\n${list.map((i) => `- ${i.name}${formatQty(i) ? " (" + formatQty(i) + ")" : ""}`).join("\n")}`).join("\n\n");
      navigator.clipboard?.writeText(text).then(() => toast("Copied. Paste it into WhatsApp or notes."), () => toast("Couldn't copy on this browser."));
      break;
    }
    case "store-del": state.stores = state.stores.filter((s) => s !== el.dataset.store); if (ui.shopStore === el.dataset.store) ui.shopStore = "all"; commit(); break;

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
    case "todo-toggle": toggleTodo(el.dataset.id, el.checked); break;
    case "frozen-use": useFrozen(el.dataset.id); break;
    case "rem-done": {
      const r = state.reminders.find((x) => x.id === el.dataset.id);
      if (!r) return;
      r.done = r.done || {};
      if (el.checked) r.done[el.dataset.date] = true; else delete r.done[el.dataset.date];
      if (ui.tab === "calendar") commitDay(el.dataset.date); else commit();
      break;
    }
    case "shop-toggle": toggleShopItem(el.dataset.id, el.checked); break;
    case "assume-staples":
      state.settings = { ...state.settings, assumeStaples: el.checked };
      commit();
      toast(el.checked ? "Staples count as at home in suggestions." : "Staples count only when they're on the kitchen list.");
      break;
    case "nut-free":
      state.settings = { ...state.settings, schoolNutFree: el.checked };
      ui.results = ui.results.filter((r) => !el.checked || checkForAudience(r, { schoolNutFree: true }).safe || !isSchoolFood(r));
      commit();
      toast(el.checked ? "Nut-free school: lunchbox nuts are blocked and kept off the shopping list." : "Nuts allowed in the lunchbox.");
      break;
    case "import": {
      const file = el.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          replaceState(importJson(text));
          save(state, { now: true });
          cloud.pushSoon();
          toast(cloud.getCloud().ready ? "Backup restored and synced to the family." : "Backup restored.");
        } catch (err) {
          toast(err.message || "That file couldn't be read.");
        }
      });
      break;
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.dataset?.action === "gen-field") {
    ui.gen[e.target.name] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (e.target.type === "checkbox") render();   // the button says "quick recipe"
  }
  if (e.target.dataset?.action === "cook-quick") { ui.cookQuick = e.target.checked; render(); }
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
      const expires = f.expires?.value || "";
      for (const it of items) {
        if (!state.pantry.some((p) => normName(p) === normName(it))) state.pantry.push(it.toLowerCase());
        noteAdded(state.pantry.find((p) => normName(p) === normName(it)), expires);
      }
      commit();
      $("[data-testid=pantry-input]")?.focus();
      break;
    }
    case "pantry-date": {
      const name = form.dataset.name;
      const k = dateKeyOf(name);
      const expires = isDateKey(f.expires.value) ? f.expires.value : "";
      state.pantryDates = { ...pantryDates(), [k]: { added: pantryDates()[k]?.added || TODAY, expires } };
      form.closest("dialog")?.close();
      commit();
      toast(expires ? `${name}: use by ${prettyDate(expires)}` : `${name}: using the fridge estimate`);
      break;
    }
    case "generate": generate(f); break;
    case "plan-chat": { const t = f.text.value; f.text.value = ""; sendChat(t); break; }
    case "shop-quick-add": {
      // The bar on top of the list: type a name, press Enter, done. Quantity and store live in the ⋯ sheet.
      const name = f.name.value.trim();
      if (!name) return;
      addToShopping([{ name, quantity: null, unit: "", store: ui.shopStore === "all" ? "" : ui.shopStore }], "manual");
      commit();
      toast(`Added ${name}`);
      $("[data-testid=shop-quick-add]")?.focus();
      break;
    }
    case "shop-add": {
      const name = f.name.value.trim();
      if (!name) return;
      const qty = f.qty.value === "" ? null : Number(f.qty.value);
      addToShopping([{ name, quantity: qty, unit: f.unit.value, store: f.store.value }], "manual");
      commit();
      // The sheet stays open for the next item.
      f.name.value = "";
      f.qty.value = "";
      for (const r of form.querySelectorAll("input[name=unit]")) r.checked = false;
      toast(`Added ${name}`);
      $("[data-testid=shop-name]")?.focus();
      break;
    }
    case "shop-edit": {
      const it = state.shopping.find((i) => i.id === form.dataset.id);
      const name = f.name.value.trim();
      if (!it || !name) return;
      Object.assign(it, { name, label: name, quantity: f.qty.value === "" ? null : Number(f.qty.value), unit: normUnit(f.unit.value), store: f.store.value });
      delete it.aisle;
      state.shopping = mergeItems(state.shopping).map((i) => ({ ...i, id: i.id || uid() }));
      form.closest("dialog")?.close();
      commit();
      toast(`Saved ${name}`);
      break;
    }
    case "todo-edit": {
      const t = state.todos.find((x) => x.id === form.dataset.id);
      const text = f.text.value.trim();
      if (!t || !text || !isDateKey(f.date.value)) return;
      Object.assign(t, { text, who: f.who.value, date: f.date.value, time: f.time.value });
      form.closest("dialog")?.close();
      commit();
      break;
    }
    case "store-add": {
      const s = f.store.value.trim();
      if (s && !state.stores.includes(s)) state.stores.push(s);
      commit();
      break;
    }
    case "todo-add-day": {
      const text = f.text.value.trim();
      const date = ui.selected;
      if (!text || !isDateKey(date)) return;
      state.todos.push({ id: uid(), text, who: f.who.value, date, time: f.time?.value || "", done: false });
      commitDay(date);
      $("[data-testid=day-todo-input]")?.focus();
      break;
    }
    case "frozen-add":
    case "frozen-edit": {
      const name = f.name.value.trim();
      if (!name) return;
      const fields = { name, qty: f.qty.value === "" ? null : Number(f.qty.value), unit: f.unit.value, date: isDateKey(f.date.value) ? f.date.value : TODAY, note: f.note.value.trim() };
      if (kind === "frozen-add") state.frozen.push({ id: uid(), ...fields });
      else {
        const it = state.frozen.find((i) => i.id === form.dataset.id);
        if (!it) return;
        Object.assign(it, fields);
      }
      form.closest("dialog")?.close();
      commit();
      toast(kind === "frozen-add" ? `Added ${name} to the freezer` : `Saved ${name}`);
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
  remember(g, !d.open);
}, true);
document.addEventListener("toggle", (e) => {
  const g = e.target?.dataset?.group;
  if (g) remember(g, e.target.open);
}, true);
function remember(g, open) {
  if (open) { ui.openGroups.add(g); ui.closedGroups.delete(g); } else { ui.openGroups.delete(g); ui.closedGroups.add(g); }
}

document.addEventListener("toggle", (e) => { if (e.target?.dataset && "cart" in e.target.dataset) ui.cartOpen = e.target.open; }, true);

$("#toast").addEventListener("click", (e) => {
  if (!e.target.closest(".toast-undo")) return;
  const undo = toast.undo;
  toast.undo = null;
  $("#toast").classList.remove("show");
  undo?.();
});

// Swipe a shopping or to-do row: right ticks it, left deletes it (both can be undone from the toast).
// Vertical drags scroll the page as usual; a swipe never also counts as a tap.
const SWIPE_AT = 90;
let swipe = null;
let swipedAt = 0;
let rowChangedAt = 0;
// Swallow the click the browser may send after the finger lifts from a swipe, and a quick
// second tap just after a tick, when the next row has slid up under the thumb.
document.addEventListener("click", (e) => {
  const now = Date.now();
  if ((now - swipedAt < 400 || now - rowChangedAt < 300) && e.target.closest?.(".swipe")) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener("pointerdown", (e) => {
  const fg = e.target.closest?.(".swipe-fg");
  // Starts at the very left edge belong to the phone's own Back swipe.
  if (!fg || e.button > 0 || e.target.closest("button") || e.clientX < 20) return;
  swipe = { row: fg.parentElement, fg, x: e.clientX, y: e.clientY, dx: 0, active: false };
});
document.addEventListener("pointermove", (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 12) return;
    swipe.active = true;
    swipe.row.classList.add("swiping");
  }
  swipe.dx = dx;
  swipe.fg.style.transform = `translateX(${dx}px)`;
  swipe.row.classList.toggle("go-l", dx > SWIPE_AT);
  swipe.row.classList.toggle("go-r", dx < -SWIPE_AT);
});
function endSwipe() {
  if (!swipe) return;
  const { row, fg, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  row.classList.remove("swiping", "go-l", "go-r");
  fg.style.transform = "";
  swipedAt = Date.now();
  const { kind, id } = row.dataset;
  if (dx > SWIPE_AT) {
    if (kind === "shop") toggleShopItem(id, !row.classList.contains("bought"));
    else if (kind === "frozen") useFrozen(id);
    else toggleTodo(id, !row.classList.contains("done"));
  } else if (dx < -SWIPE_AT) {
    if (kind === "shop") deleteShopItem(id);
    else if (kind === "frozen") deleteFrozen(id);
    else deleteTodo(id);
  }
}
document.addEventListener("pointerup", endSwipe);
document.addEventListener("pointercancel", () => { if (swipe) { swipe.fg.style.transform = ""; swipe.row.classList.remove("swiping", "go-l", "go-r"); swipe = null; } });

// Store mode is a history step, so the phone's Back gesture leaves it instead of the app.
function setStoreMode(on) {
  ui.storeMode = on;
  keepScreenOn(on);
  if (on) history.pushState({ store: true }, "");
  else if (history.state?.store) { ignorePop = true; history.back(); }
  render();
}
window.addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; return; }
  const open = document.querySelector("dialog.sheet[open]");
  if (open) open.close();
  else if (ui.storeMode) setStoreMode(false);
});

// In store mode the phone screen stays on, so the list doesn't lock between aisles.
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}

window.addEventListener("pagehide", () => { save(state, { now: true }); cloud.syncNow(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { save(state, { now: true }); cloud.syncNow(); wakeLock = null; }
  else { refreshToday(); if (ui.storeMode && ui.tab === "shopping") keepScreenOn(true); }
});
// Another tab or window of the planner saved: take its data instead of overwriting it with ours later.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  cancelPendingSave();
  replaceState(load());
  toast("Updated with changes from another tab.");
});
// A failed write (storage full, private mode) would otherwise lose every change without a word.
onSaveError((err) => { $("#save-warning").hidden = !err; });
window.addEventListener("online", checkAi);
window.addEventListener("offline", () => { ui.ai = "unreachable"; renderHeader(); });

// ---------- start ----------
const initialTab = location.hash.replace("#", "");
if (stampUndated()) save(state, { now: true });   // a quiet save: it doesn't count as an edit for family sync
setTab(["calendar", "recipes", "shopping", "frozen", "reminders"].includes(initialTab) ? initialTab : "calendar");
onChange(() => { renderSyncButtons(); cloud.pushSoon(); });
startFamilySync();
maybeShowLogin();
checkAi();
checkDueReminders();
// Ask the browser not to clear this site's storage on its own (Safari deletes it after 7 days without a visit otherwise).
navigator.storage?.persist?.().catch(() => {});
setInterval(() => { refreshToday(); checkDueReminders(); }, 30000);

// Exposed for tests and debugging in the console.
window.__mealPlanner = { state, ui, TODAY, cloud };
