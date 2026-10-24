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

// Writes the merged data back into `state`, keeping the local order of list items that are
// still there and adding new ones at the end. Returns true when anything changed.
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
      if (v === undefined) continue;
      if (sec === "days") { if (v && typeof v === "object") days[key] = v; }
      else if (sec === "meta") { if (META.includes(key)) meta[key] = v; }
      else if (v && typeof v === "object") lists[sec].set(key, v);
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
  for (const k of META) {
    if (k in meta) state[k] = meta[k];
  }
  return JSON.stringify(encode(state)) !== before;
}

// Three-way merge, field by field: a field this phone changed since it last synced keeps this
// phone's value; every other field takes what is in the cloud (including deletions).
export function merge(local, base, remote) {
  const out = {};
  for (const d of new Set([...Object.keys(local), ...Object.keys(base), ...Object.keys(remote)])) {
    const l = local[d] || {}, b = base[d] || {}, r = remote[d] || {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(b), ...Object.keys(r)])) {
      const v = l[k] !== b[k] ? l[k] : r[k];
      if (v !== undefined) (out[d] ||= {})[k] = v;
    }
  }
  return out;
}

// The first sync of a phone with the family's data. A phone that was never used takes the
// family's data as it is. A phone with its own data keeps everything: items the cloud doesn't
// have are added, the kitchen and store lists are combined, and for the same item or day the
// family's version wins. An empty family space simply gets this phone's data.
export function firstMerge(local, remote, { used = true } = {}) {
  const remoteEmpty = !Object.values(remote).some((f) => f && Object.keys(f).length);
  if (remoteEmpty) return clone(local);
  if (!used) return clone(remote);
  const out = clone(remote);
  for (const [d, fields] of Object.entries(local)) {
    for (const [k, v] of Object.entries(fields)) {
      if (!out[d]?.[k]) { (out[d] ||= {})[k] = v; continue; }
      if (d === "meta" && (k === "pantry" || k === "stores")) {
        const a = parse(out[d][k]), b = parse(v);
        if (Array.isArray(a) && Array.isArray(b)) {
          const seen = new Set(a.map((x) => String(x).toLowerCase()));
          out[d][k] = JSON.stringify([...a, ...b.filter((x) => !seen.has(String(x).toLowerCase()))]);
        }
      }
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
