// How the app data is laid out in Firestore, and how changes from other phones are merged in.
// Pure functions with no Firebase in them, so they run in node tests too.
//
// The data is split into a few documents. Each document is a flat map of item key -> the item
// as JSON text: the shopping list is one document with a field per item, the to-dos and the
// days are one document per month, and so on. Two phones changing different items at the same
// time (ticking two shopping items in the store) never overwrite each other, because only the
// changed fields are written.

export const LISTS = ["shopping", "todos", "reminders", "savedRecipes"];
export const META = ["pantry", "stores", "settings"];   // "notified" stays per phone, so every phone still alerts

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

const month = (date) => (/^\d{4}-\d{2}/.test(String(date || "")) ? String(date).slice(0, 7) : "none");

export function docFor(section, key, item) {
  if (section === "todos") return `todos-${month(item?.date)}`;
  if (section === "days") return `days-${month(key)}`;
  if (section === "savedRecipes") return `recipes-${hash(key) % 8}`;
  return section;   // shopping, reminders, meta
}

export function sectionOf(docId) {
  const head = String(docId).split("-")[0];
  if (head === "recipes") return "savedRecipes";
  return [...LISTS, "days", "meta"].includes(head) ? head : null;
}

// state -> { docId: { key: json } }. Items without an id get one, so they can be synced.
export function encode(state) {
  const out = {};
  const put = (doc, key, value) => { (out[doc] ||= {})[key] = JSON.stringify(value); };
  for (const sec of LISTS) {
    for (const item of state[sec] || []) {
      if (!item || typeof item !== "object") continue;
      if (!item.id) item.id = "k" + hash(JSON.stringify(item)).toString(36);
      put(docFor(sec, item.id, item), String(item.id), item);
    }
  }
  for (const [date, day] of Object.entries(state.days || {})) put(docFor("days", date), date, day);
  for (const k of META) if (state[k] !== undefined) put("meta", k, state[k]);
  return out;
}

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const blank = (x) => x === undefined || x === null || x === "";

// The shape each kind of item must have; anything else from the cloud is skipped, never shown.
const VALID = {
  shopping: (i) => typeof i.name === "string",
  todos: (t) => typeof t.text === "string" && typeof t.date === "string",
  reminders: (r) => typeof r.title === "string" && typeof r.date === "string",
  savedRecipes: (r) => typeof r.title === "string",
};

// Writes the merged data back into `state`, keeping the local order of list items that are
// still there and adding new ones at the end. Malformed values are skipped. Returns true when
// anything changed.
export function decodeInto(state, docs) {
  const lists = Object.fromEntries(LISTS.map((s) => [s, new Map()]));
  const days = {};
  const meta = {};
  for (const [docId, fields] of Object.entries(docs)) {
    const sec = sectionOf(docId);
    if (!sec || !fields) continue;
    for (const [key, text] of Object.entries(fields)) {
      if (typeof text !== "string") continue;
      const v = parse(text);
      if (sec === "days") {
        if (!isObj(v) || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        days[key] = { ...v, meals: isObj(v.meals) ? v.meals : {}, schedule: Array.isArray(v.schedule) ? v.schedule.filter(isObj) : [] };
      } else if (sec === "meta") {
        if (key === "settings" && isObj(v)) meta.settings = v;
        else if ((key === "pantry" || key === "stores") && Array.isArray(v)) meta[key] = v.filter((x) => typeof x === "string");
      } else if (isObj(v) && VALID[sec](v)) lists[sec].set(key, v);
    }
  }
  const before = JSON.stringify(encode(state));
  for (const sec of LISTS) {
    const map = lists[sec];
    const kept = [];
    for (const item of state[sec] || []) {
      const k = String(item?.id);
      if (map.has(k)) { kept.push(map.get(k)); map.delete(k); }
    }
    state[sec] = [...kept, ...[...map.keys()].sort().map((k) => map.get(k))];
  }
  state.days = days;
  if (meta.settings) state.settings = { ...state.settings, ...meta.settings };
  for (const k of ["pantry", "stores"]) if (meta[k]) state[k] = meta[k];
  return JSON.stringify(encode(state)) !== before;
}

const idList = (a) => Array.isArray(a) && a.every((x) => isObj(x) && x.id != null);
const plainList = (a) => Array.isArray(a) && a.every((x) => x === null || typeof x !== "object");
const setKey = (x) => (typeof x === "string" ? x.trim().toLowerCase() : JSON.stringify(x));

// Merges two edits of one value against what both started from (`b`, undefined when unknown):
// inside objects key by key, lists of items with ids item by item, lists of words (the kitchen,
// the stores) as sets. Only a real clash on one value is decided, by `prefer`, and an empty
// value never beats a filled-in one.
export function merge3(b, l, r, prefer = "local") {
  if (same(l, r)) return l;
  if (b !== undefined) {
    if (same(l, b)) return r;
    if (same(r, b)) return l;
  }
  if (isObj(l) && isObj(r)) {
    const bo = isObj(b) ? b : {};
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const v = merge3(b === undefined ? undefined : bo[k], l[k], r[k], prefer);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (idList(l) && idList(r)) {
    const bm = new Map(idList(b) ? b.map((x) => [String(x.id), x]) : []);
    const lm = new Map(l.map((x) => [String(x.id), x]));
    const rm = new Map(r.map((x) => [String(x.id), x]));
    const out = [];
    for (const id of new Set([...lm.keys(), ...rm.keys()])) {
      const v = merge3(b === undefined ? undefined : bm.get(id), lm.get(id), rm.get(id), prefer);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (plainList(l) && plainList(r)) {
    const bs = new Set(Array.isArray(b) ? b.map(setKey) : []);
    const ls = new Set(l.map(setKey)), rs = new Set(r.map(setKey));
    const seen = new Set();
    const keep = (x) => { const k = setKey(x); if (seen.has(k)) return false; seen.add(k); return true; };
    return [
      ...l.filter((x) => !(bs.has(setKey(x)) && !rs.has(setKey(x)))),
      ...r.filter((x) => !ls.has(setKey(x)) && !bs.has(setKey(x))),
    ].filter(keep);
  }
  if (blank(l) !== blank(r)) return blank(l) ? r : l;
  return prefer === "local" ? l : r;
}

export function mergeText(b, l, r, prefer) {
  const pl = parse(l), pr = parse(r);
  if (pl === undefined) return r;
  if (pr === undefined) return l;
  return JSON.stringify(merge3(b === undefined ? undefined : parse(b), pl, pr, prefer));
}

// Three-way merge, field by field: a field only this phone changed since it last synced keeps
// this phone's value, a field only the cloud changed takes the cloud's (including deletions),
// and a field both changed is merged inside (see merge3).
export function merge(local, base, remote) {
  const out = {};
  for (const d of new Set([...Object.keys(local), ...Object.keys(base), ...Object.keys(remote)])) {
    const l = local[d] || {}, b = base[d] || {}, r = remote[d] || {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(b), ...Object.keys(r)])) {
      let v;
      if (l[k] === b[k]) v = r[k];
      else if (r[k] === b[k] || r[k] === l[k] || l[k] === undefined || r[k] === undefined) v = l[k];
      else v = mergeText(b[k], l[k], r[k], "local");
      if (v !== undefined) (out[d] ||= {})[k] = v;
    }
  }
  return out;
}

// The first sync of a phone with a family's data. `used: false` takes the family's data as it
// is (a phone that was never used, or one whose data came from another family). Otherwise
// everything is kept: items and days only one side has are added, the same day or settings are
// merged inside (both phones' meals, a name filled in on either phone), the kitchen and store
// lists are combined, and only a real clash goes the family's way. An empty family space
// simply gets this phone's data.
export function firstMerge(local, remote, { used = true } = {}) {
  const remoteEmpty = !Object.values(remote).some((f) => f && Object.keys(f).length);
  if (remoteEmpty) return clone(local);
  if (!used) return clone(remote);
  const out = clone(remote);
  for (const [d, fields] of Object.entries(local)) {
    for (const [k, v] of Object.entries(fields)) {
      (out[d] ||= {})[k] = out[d][k] === undefined ? v : mergeText(undefined, v, out[d][k], "remote");
    }
  }
  return out;
}

// What to write to make the cloud match `next`: { docId: { key: json | null } } where null
// deletes the field, plus the documents that end up empty.
export function diff(next, base) {
  const writes = {};
  const empty = [];
  for (const d of new Set([...Object.keys(next), ...Object.keys(base)])) {
    const n = next[d] || {}, b = base[d] || {};
    const w = {};
    for (const k of new Set([...Object.keys(n), ...Object.keys(b)])) {
      if (n[k] !== b[k]) w[k] = n[k] === undefined ? null : n[k];
    }
    if (!Object.keys(w).length) continue;
    if (!Object.keys(n).length) empty.push(d);
    else writes[d] = w;
  }
  return { writes, empty };
}

// This phone's edits not yet in the cloud: { docId: { key: json | undefined (deleted) } }.
export function pending(local, base) {
  const out = {};
  for (const d of new Set([...Object.keys(local), ...Object.keys(base)])) {
    const l = local[d] || {}, b = base[d] || {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(b)])) {
      if (l[k] !== b[k]) (out[d] ||= {})[k] = l[k];
    }
  }
  return out;
}

// One field of a write: this phone's value merged with what the cloud has now (`server`), given
// what both started from (`base`). Run inside a transaction, so two phones' writes can't cross.
export function resolve(base, mine, server) {
  if (server === base || server === mine) return mine;
  if (mine === undefined || server === undefined) return mine;
  return mergeText(base, mine, server, "local");
}

export function clone(docs) {
  return Object.fromEntries(Object.entries(docs).map(([d, f]) => [d, { ...f }]));
}

// Keeps only string fields, the shape this app writes, from a Firestore document.
export function cleanDoc(data) {
  return Object.fromEntries(Object.entries(data || {}).filter(([, v]) => typeof v === "string"));
}

export function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e));
}
