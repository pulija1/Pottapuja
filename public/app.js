import { load, save, exportJson, importJson, onChange, defaultState } from "./store.js";
import * as cloud from "./cloud.js";
import { getAiKey, setAiKey, looksLikeKey, browserRecipes } from "./ai-browser.js";
import { todayKey, addDays, addMonths, monthGrid, monthLabel, prettyDate, fromKey, isDateKey, isSchoolDay, occurrences } from "./shared/dates.js";
import { checkRecipe, checkForAudience, isNutIngredient, isSchoolFood } from "./shared/safety.js";
import { LIBRARY, suggestFromLibrary } from "./shared/recipes.js";
import { mergeItems, groupByAisle, formatQty, missingFromPantry, normName, normUnit, aisleFor } from "./shared/shopping.js";
import { SLOTS, emptyDay, getDay, dayHasPlan, markEdited, approveDay, unapproveDay, slotsFor, todosOn, MEAL_GROUPS, whoLabel, slotLabel, TODO_IDEAS, remindersOn, pendingFor, dayStatus } from "./shared/plan.js";

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
  cartOpen: false,       // the "In the cart" section on the shopping list is expanded
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
function swipeRow({ testid, cls = "", data = "", check, body, more, leftLabel, rightLabel = "Delete" }) {
  return `<div class="swipe ${cls}" data-testid="${testid}" ${data}>
    <div class="swipe-bg" aria-hidden="true"><span class="swipe-l">✓ ${esc(leftLabel)}</span><span class="swipe-r">${esc(rightLabel)} 🗑</span></div>
    <div class="swipe-fg">
      <label class="tap-main">${check}<span class="tap-text">${body}</span></label>
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
      out[s.id] = { label: slotLabel(s, state.settings), messages: [...new Set(msgs)] };
    }
  }
  return out;
}

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
  const aiKey = `<details ${focusKey ? "open" : ""} data-testid="ai-key-section"><summary class="small">Claude API key (AI recipes)${hasKey ? " · added" : ""}</summary>
      <p class="small muted">Kept only in this browser. It is never synced to the family or put in backups. Get a key at console.anthropic.com under API Keys, and set a monthly spend limit there.</p>
      <label class="field"><span>API key</span><input name="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? "Saved. Paste a new key to replace it" : "sk-ant-…"}" data-testid="ai-key"></label>
      <p class="small" data-testid="ai-key-status" role="status"></p>
      <div class="row"><button type="button" class="btn sm" data-sync="aikey-save" data-testid="ai-key-save">Save key</button>${hasKey ? '<button type="button" class="btn sm ghost" data-sync="aikey-remove" data-testid="ai-key-remove">Remove key</button>' : ""}</div>
    </details>`;
  const names = `<details ${state.settings.kidName ? "" : "open"} data-testid="family-names"><summary class="small">Children's names</summary>
      <p class="small muted">Saved with the family's data, not in the app's public code.</p>
      <label class="field"><span>4-year-old</span><input name="kidName" value="${esc(state.settings.kidName || "")}" maxlength="30" data-testid="kid-name"></label>
      <label class="field"><span>8-month-old</span><input name="babyName" value="${esc(state.settings.babyName || "")}" maxlength="30" data-testid="baby-name"></label>
      <button type="button" class="btn sm" data-sync="names" data-testid="save-names">Save names</button>
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
        state.settings = { ...state.settings, kidName: f.kidName.value.trim(), babyName: f.babyName.value.trim() };
        commit();
        toast("Names saved.");
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
    <p class="small muted">${cloud.getCloud().ready ? "Everything syncs with your family on its own. A backup file is a copy you keep yourself." : "Everything is saved on this device. Download a backup to move it to another phone or browser."}</p>
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
        <span class="small muted">${esc(slotLabel(s, state.settings))}</span>
        <span class="grow">${esc(r.title)}${r.familyFavorite ? " ⭐" : ""}${need.length ? ` <span class="small" style="color:var(--warn)">· need ${esc(need.map((i) => i.name).join(", "))}</span>` : ' <span class="small" style="color:var(--ok)">· all in the kitchen</span>'}</span>
        <button type="button" class="iconbtn" data-action="suggest-swap" data-slot="${s.id}" title="Another idea" aria-label="Another idea for ${esc(slotLabel(s, state.settings))}">🔀</button>
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
    <span class="slot-label">${esc(slotLabel(s, state.settings))}</span>
    <div class="slot-row">
      <input type="text" list="dl-${s.who}" value="${esc(m?.title || "")}" placeholder="Pick a recipe or type a dish" data-action="slot" data-slot="${s.id}" data-who="${s.who}" data-testid="slot-${s.id}" aria-label="${esc(slotLabel(s, state.settings))}">
      ${r ? `<button class="iconbtn" data-action="view-recipe" data-id="${esc(r.id)}" title="View recipe" aria-label="View recipe">📖</button>` : ""}
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

function todoSheet(t = null) {
  const date = t?.date || ui.todoDate;
  const quick = [[TODAY, "Today"], [addDays(TODAY, 1), "Tomorrow"]];
  sheet(t ? "todo-edit-sheet" : "todo-sheet", `<form data-form="${t ? "todo-edit" : "todo-add"}" class="stack" ${t ? `data-id="${esc(t.id)}"` : ""}>
    <div class="row between"><h2>${t ? "Edit to do" : "Add a to do"}</h2><button type="button" class="iconbtn lg" data-sheet-close aria-label="Close">✕</button></div>
    <label class="field"><span>What needs doing</span><input type="text" name="text" required maxlength="120" value="${esc(t?.text || "")}" placeholder="e.g. Pack the water bottle" data-testid="todo-input" enterkeyhint="done"></label>
    <div class="field"><span>For</span>${chipRadios("who", ["kid", "baby", "family"].map((v) => [v, whoLabel(v, state.settings, { age: true })]), t?.who || "kid", "todo-who")}</div>
    <div class="field"><span>When</span>
      <div class="row">${quick.map(([k, l]) => `<button type="button" class="btn sm ${k === date ? "primary" : ""}" data-action="todo-sheet-date" data-date="${k}">${l}</button>`).join("")}
        <input type="date" name="date" value="${esc(date)}" required data-testid="todo-input-date" class="grow" aria-label="Date"></div>
    </div>
    <label class="field"><span>Time (optional)</span><input type="time" name="time" value="${esc(t?.time || "")}"></label>
    <button class="btn primary big" data-testid="${t ? "todo-save" : "todo-add"}">${t ? "Save" : "Add to do"}</button>
    ${t ? `<button type="button" class="btn danger big" data-action="todo-del" data-id="${esc(t.id)}" data-testid="todo-delete">Delete</button>` : ""}
  </form>`);
  if (!t) $("[data-testid=todo-input]")?.focus();
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
        <summary><span class="grow"><strong>${g.icon} ${esc(whoLabel(g.who, state.settings, { age: true }))}</strong></span>
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
            ${[["both", whoLabel("both", state.settings)], ["baby", whoLabel("baby", state.settings, { age: true })], ["kid", whoLabel("kid", state.settings, { age: true })], ["family", "Whole family"]].map(([v, l]) => `<option value="${v}" ${ui.gen.forWhom === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
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
    fallback(ui.ai === "unknown" ? "The recipe AI is still being checked." : "AI recipes are off. To turn them on, add a Claude API key in 👤 Profile.");
    render();
    return;
  }
  ui.aiBusy = true;
  ui.aiController = new AbortController();
  const timer = setTimeout(() => ui.aiController?.abort("timeout"), AI_TIMEOUT_MS);
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
    body: `<span class="name">${esc(i.label || i.name)}</span>${meta ? `<span class="meta" data-testid="shop-qty-label">${meta}</span>` : ""}`,
    more: `<button type="button" class="iconbtn lg" data-action="shop-more" data-id="${esc(i.id)}" aria-label="Details for ${esc(i.name)}" data-testid="shop-more">⋯</button>`,
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
      ${items.length ? `<div class="progress big" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <p class="small muted" style="margin:4px 0 0" data-testid="shop-progress">${inCart.length} of ${items.length} in the cart${ui.storeMode ? " · tap an item when it's in the cart" : ""}</p>` : ""}
      <div class="seg scroll-x" role="group" aria-label="Store filter" data-testid="store-filter">
        <button data-action="shop-store" data-store="all" aria-pressed="${ui.shopStore === "all"}">All stores</button>
        ${state.stores.map((s) => `<button data-action="shop-store" data-store="${esc(s)}" aria-pressed="${ui.shopStore === s}">${esc(s)}</button>`).join("")}
      </div>
    </div>
    <div data-testid="shop-list" class="${ui.storeMode ? "store-mode" : ""}">
      ${groups.map(([aisle, list]) => `<section class="aisle card" data-testid="aisle">
        <h3><span class="aisle-icon" aria-hidden="true">${AISLE_ICONS[aisle] || "🛍️"}</span>${esc(aisle)}<span class="aisle-count">${list.length}</span></h3>
        ${list.map(shopRow).join("")}
      </section>`).join("")}
      ${!toBuy.length ? `<div class="card empty-state" data-testid="shop-empty">${items.length ? `🎉 Everything is in the cart.${ui.storeMode ? '<button class="btn primary big" style="display:flex;width:100%;margin-top:12px" data-action="store-mode" data-testid="store-done">✓ Done shopping</button>' : ""}` : "The list is empty. Tap <strong>+ Add item</strong>, or pull items from your meal plan."}</div>` : ""}
      ${inCart.length ? `<details class="card cart" data-testid="shop-cart" data-cart ${ui.cartOpen ? "open" : ""}>
        <summary><span class="aisle-icon" aria-hidden="true">🛒</span>In the cart <span class="aisle-count">${inCart.length}</span></summary>
        ${inCart.sort((a, b) => a.name.localeCompare(b.name)).map(shopRow).join("")}
        ${ui.storeMode ? "" : `<button class="btn danger" style="margin-top:8px" data-action="clear-bought" data-testid="clear-bought">Clear the cart</button>`}
      </details>` : ""}
      ${items.length ? '<p class="small muted swipe-hint">Tip: swipe an item right when you have it, or left to delete.</p>' : ""}
    </div>
    ${ui.storeMode ? "" : `<div class="card">
      <h2>Fill the list</h2>
      <div class="row">
        <button class="btn" data-action="plan-to-shopping" data-testid="plan-to-shopping">From next 7 days of meals</button>
        <button class="btn" data-action="copy-list" data-testid="copy-list">Copy list as text</button>
      </div>
      <details class="shop-extra" style="margin-top:10px"><summary>Stores</summary>
        <div class="chips" style="margin-top:8px">${state.stores.map((s) => `<span class="chip">${esc(s)}<button data-action="store-del" data-store="${esc(s)}" aria-label="Remove ${esc(s)}">✕</button></span>`).join("")}</div>
        <form data-form="store-add" class="row" style="margin-top:8px"><input type="text" name="store" class="grow" placeholder="Add a store" required><button class="btn sm">Add</button></form>
      </details>
    </div>`}
    <button class="fab" data-action="shop-fab" data-testid="shop-fab" aria-label="Add item"><span aria-hidden="true">＋</span> Add item</button>`;
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
    it.addedToPantry = true;
    clearCaches();
    return `Got ${name} · added to your kitchen`;
  }
  if (!bought && it.addedToPantry) {
    state.pantry = state.pantry.filter((p) => normName(p) !== normName(it.name));
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
  if (ui.tab !== "todo") { commit(); return; }
  // On the To do tab, tick the row in place instead of rebuilding a long list.
  save(state);
  pendCache.delete(t.date);
  for (const row of document.querySelectorAll(`.swipe[data-kind=todo][data-id="${CSS.escape(id)}"]`)) {
    row.classList.toggle("done", doneNow);
    const box = row.querySelector("input[type=checkbox]");
    if (box) box.checked = doneNow;
    const l = row.querySelector(".swipe-l");
    if (l) l.textContent = doneNow ? "✓ Not done" : "✓ Done";
  }
  const list = todosOn(state, ui.todoDate);
  const left = list.filter((x) => !x.done).length;
  const pill = $("[data-testid=todo-left]");
  if (pill) { pill.textContent = left ? `${left} left` : "All done"; pill.className = `pill ${left ? "warn" : "ok"}`; }
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
      <div data-testid="todo-list" style="margin-top:6px">${list.length ? list.map((t) => todoRow(t)).join("") : '<p class="empty-state">Nothing planned for the kids on this day. Tap <strong>+ Add to do</strong> or an idea below.</p>'}</div>
      <h3>Quick ideas for ${esc(dayName.toLowerCase() === "today" || dayName.toLowerCase() === "tomorrow" ? dayName.toLowerCase() : prettyDate(key))}</h3>
      <div class="chips">${TODO_IDEAS.map((i) => `<button class="chip add big" data-action="todo-idea" data-text="${esc(i.text)}" data-who="${i.who}" data-testid="todo-idea">+ ${esc(i.text)}</button>`).join("")}</div>
    </div>
    ${allMissed.length ? `<div class="card" data-testid="todo-missed"><h2>⚠️ Not done yet</h2>${missed.map((t) => todoRow(t, { showDate: true })).join("")}
      ${older ? `<button class="btn ghost sm" data-action="todo-older" data-testid="todo-older">Show ${older} older</button>` : ""}</div>` : ""}
    <div class="card" data-testid="todo-upcoming"><h2>Coming up this week</h2>
      ${soon.length ? soon.map((t) => todoRow(t, { showDate: true })).join("") : '<p class="small muted">Nothing else in the next 7 days.</p>'}
    </div>
    <button class="fab" data-action="todo-fab" data-testid="todo-fab" aria-label="Add to do"><span aria-hidden="true">＋</span> Add to do</button>`;
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
    case "todo-del": el.closest("dialog")?.close(); deleteTodo(el.dataset.id); break;
    case "todo-fab": todoSheet(); break;
    case "todo-more": { const t = state.todos.find((x) => x.id === el.dataset.id); if (t) todoSheet(t); break; }
    case "todo-sheet-date": {
      const f = el.closest("form");
      f.date.value = el.dataset.date;
      for (const b of f.querySelectorAll("[data-action=todo-sheet-date]")) b.classList.toggle("primary", b === el);
      break;
    }
    case "new-reminder": setTab("reminders"); renderReminders(el.dataset.date); $("[data-testid=rem-title]")?.focus(); break;
    case "export": downloadBackup(); break;

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
    case "todo-toggle": toggleTodo(el.dataset.id, el.checked); break;
    case "rem-done": {
      const r = state.reminders.find((x) => x.id === el.dataset.id);
      if (!r) return;
      r.done = r.done || {};
      if (el.checked) r.done[el.dataset.date] = true; else delete r.done[el.dataset.date];
      if (ui.tab === "calendar") commitDay(el.dataset.date); else commit();
      break;
    }
    case "shop-toggle": toggleShopItem(el.dataset.id, el.checked); break;
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
    case "todo-add":
    case "todo-add-day": {
      const text = f.text.value.trim();
      const date = kind === "todo-add" ? f.date.value : ui.selected;
      if (!text || !isDateKey(date)) return;
      state.todos.push({ id: uid(), text, who: f.who.value, date, time: f.time?.value || "", done: false });
      if (kind === "todo-add") { ui.todoDate = date; form.closest("dialog")?.close(); toast(`Added for ${prettyDate(date)}.`); }
      if (kind === "todo-add-day") { commitDay(date); $("[data-testid=day-todo-input]")?.focus(); } else commit();
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
    else toggleTodo(id, !row.classList.contains("done"));
  } else if (dx < -SWIPE_AT) {
    if (kind === "shop") deleteShopItem(id); else deleteTodo(id);
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
window.addEventListener("online", checkAi);
window.addEventListener("offline", () => { ui.ai = "unreachable"; renderHeader(); });

// ---------- start ----------
const initialTab = location.hash.replace("#", "");
setTab(["calendar", "recipes", "shopping", "todo", "reminders"].includes(initialTab) ? initialTab : "calendar");
onChange(() => { renderSyncButtons(); cloud.pushSoon(); });
startFamilySync();
maybeShowLogin();
checkAi();
checkDueReminders();
setInterval(() => { refreshToday(); checkDueReminders(); }, 30000);

// Exposed for tests and debugging in the console.
window.__mealPlanner = { state, ui, TODAY, cloud };
