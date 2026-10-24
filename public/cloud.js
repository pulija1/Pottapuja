// Family sync with Firebase: Google sign-in, one shared family space, and the app data kept in
// Cloud Firestore so every phone in the family sees the same lists. The app keeps working on
// the phone's own copy with no signal; edits made meanwhile go up once it is back online.
//
// Every write is a transaction that reads the cloud's current value and merges this phone's
// edit into it, so two phones changing the same list, day or item at the same moment (or one
// of them offline) both keep their changes.
// The Firebase SDK is loaded only when firebase-config.js has a project in it.

import { firebaseConfig } from "./firebase-config.js";
import { encode, decodeInto, merge, firstMerge, pending, resolve, clone, cleanDoc, normEmail, validEmail } from "./shared/cloud-sync.js";

const SDK_VERSION = "13.0.0";
const KEY = "familyMealPlanner.cloud";
const PUSH_DELAY_MS = 400;
const RETRY_MS = 15000;

let fb = null;            // { app, auth, db, A: auth module, F: firestore module }
let hooks = {};
let user = null;
let family = null;        // { id, name, emails, ownerEmail, owner }
let remote = {};          // the family's data as the last Firestore snapshot had it
let base = {};            // the data as it was at this phone's last sync: tells local edits from remote ones
let ready = false;        // the first sync with the family's data is done
let familyId = null;
let firstMode = "add";    // first sync: "add" this phone's data to the family's, or take only the "family" data
let unsubItems = null, unsubFamily = null;
let status = "off";       // off | loading | unavailable | signed-out | no-family | choose | connecting | synced | saving | offline | error
let lastError = "";
let pushing = null;       // the write in flight (a promise), if any
let pushAgain = false;
let session = 0;          // bumped when the family connection stops, so late write results are ignored
let pushTimer = null, retryTimer = null;
let authKnown;
const authSettled = new Promise((r) => { authKnown = r; });

export const cloudConfigured = () => !!(firebaseConfig && firebaseConfig.projectId && firebaseConfig.apiKey);

function readLocal() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
function writeLocal(patch) {
  const next = { ...readLocal(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}

// What this phone last synced with each family it was in, so leaving and re-joining a family
// is an ordinary merge and doesn't bring back things the family deleted in the meantime.
function savedBase(fid) {
  const s = readLocal();
  return s.bases?.[fid] || (s.familyId === fid && s.base) || null;
}
function saveBase(fid, b) {
  if (!fid) return;
  writeLocal({ bases: { ...(readLocal().bases || {}), [fid]: b }, base: undefined });
}

export const cloudSkipped = () => !!readLocal().skipped;
export const setCloudSkipped = (v) => writeLocal({ skipped: !!v });

function setStatus(next, err = "") {
  if (!navigator.onLine && ["synced", "saving", "connecting"].includes(next)) next = "offline";
  status = next;
  lastError = err;
  hooks.onStatus?.(getCloud());
}

export function getCloud() {
  return {
    configured: cloudConfigured(),
    status,
    error: lastError,
    ready,
    user: user ? { email: normEmail(user.email), name: user.displayName || "", photo: user.photoURL || "", uid: user.uid } : null,
    family: family ? { ...family, emails: [...(family.emails || [])] } : null,
    // The data on this phone was last synced by a different Google account (a shared phone).
    otherAccountData: !!user && !!readLocal().lastUid && readLocal().lastUid !== user.uid,
  };
}

// Resolves once Firebase has said whether someone is signed in on this phone (or can't load).
export const cloudAuthSettled = () => authSettled;

async function loadSdk() {
  const cfg = { ...firebaseConfig };
  const sdk = cfg.sdkBase || `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
  const emulator = cfg.emulator;
  delete cfg.sdkBase;
  delete cfg.emulator;
  const [appM, A, F] = await Promise.all([import(sdk + "firebase-app.js"), import(sdk + "firebase-auth.js"), import(sdk + "firebase-firestore.js")]);
  const app = appM.initializeApp(cfg);
  const auth = A.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    db = F.getFirestore(app);   // private browsing without IndexedDB: memory cache only
  }
  if (emulator) {
    A.connectAuthEmulator(auth, emulator.auth, { disableWarnings: true });
    F.connectFirestoreEmulator(db, emulator.host, emulator.port);
  }
  return { app, auth, db, A, F, emulator: !!emulator };
}

// hooks: getState() -> the app state; onRemoteChange() after other phones' changes were merged
// into it; onStatus(cloud) whenever the sync state changes; onNoFamily(cloud) when the signed-in
// account isn't in a family space yet; onFirstSync(info) after this phone's data was merged.
export async function startCloud(h) {
  hooks = h;
  if (!cloudConfigured()) { authKnown(); return; }
  setStatus("loading");
  try {
    fb = await loadSdk();
  } catch (e) {
    console.warn("Firebase didn't load", e);
    setStatus("unavailable", "Family sync couldn't load. Check the internet connection and reload.");
    authKnown();
    return;
  }
  fb.A.onAuthStateChanged(fb.auth, (u) => { onUser(u).finally(authKnown); });
  window.addEventListener("online", () => { if (ready) push(); });
  window.addEventListener("offline", () => { if (ready) setStatus("offline"); });
}

function stopListening() {
  session++;
  pushing = null;
  pushAgain = false;
  clearTimeout(pushTimer); clearTimeout(retryTimer);
  unsubItems?.(); unsubFamily?.();
  unsubItems = unsubFamily = null;
  family = null;
  familyId = null;
  ready = false;
  remote = {};
}

async function onUser(u) {
  stopListening();
  user = u;
  if (!u) { setStatus("signed-out"); return; }
  const saved = readLocal();
  const fid = saved.uid === u.uid ? saved.familyId : null;
  if (fid) connect(fid);
  else await offerFamilies();
}

// Family spaces that list this account. Anyone can put any email in their own space, so the
// app never joins one (or uploads anything to it) until the person has seen who started it
// and said yes.
async function findFamilies() {
  const { F, db } = fb;
  const q = F.query(F.collection(db, "families"), F.where("emails", "array-contains", normEmail(user.email)), F.limit(5));
  const snap = await F.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name || "Family space", ownerEmail: d.data().ownerEmail || "", emails: d.data().emails || [] }));
}

async function offerFamilies() {
  setStatus("connecting");
  let list;
  try {
    list = await findFamilies();
  } catch (e) {
    setStatus("error", friendly(e));
    return 0;
  }
  if (!list.length) { setStatus("no-family"); hooks.onNoFamily?.(getCloud()); return 0; }
  // Signing back in to a family this account already synced on this phone: carry on with it.
  const saved = readLocal();
  const again = saved.lastUid === user.uid && list.find((f) => f.id === saved.lastFamily && savedBase(f.id));
  if (again) { connect(again.id); return list.length; }
  setStatus("choose");
  const last = saved.lastFamily;
  hooks.onChooseFamily?.(getCloud(), list.map((f) => ({ ...f, knownHere: !!savedBase(f.id), otherFamilyData: !!last && last !== f.id })));
  return list.length;
}

// After the person picked a family space. `useFamilyData` replaces this phone's data with the
// family's instead of adding this phone's data to it.
export function joinFamily(fid, { useFamilyData = false } = {}) {
  connect(fid, { mode: useFamilyData ? "family" : "add" });
}

function connect(fid, { mode = "add" } = {}) {
  const { F, db } = fb;
  // Carry on from where this phone left off only if its data still comes from this family
  // (signed back in, or added back after being removed); otherwise it's a first sync.
  const prev = mode === "family" || readLocal().lastFamily !== fid ? null : savedBase(fid);
  base = prev || {};
  ready = !!prev;
  firstMode = mode;
  familyId = fid;
  remote = {};
  writeLocal({ uid: user.uid, familyId: fid });
  setStatus("connecting");
  const famRef = F.doc(db, "families", fid);
  unsubFamily = F.onSnapshot(famRef, (snap) => {
    if (!snap.exists()) return lost();
    family = { id: fid, ...snap.data() };
    hooks.onStatus?.(getCloud());
  }, (e) => (e.code === "permission-denied" ? lost() : setStatus("error", friendly(e))));
  let wasFromCache = true;
  unsubItems = F.onSnapshot(F.collection(famRef, "items"), { includeMetadataChanges: true }, (snap) => {
    const changes = snap.docChanges();
    for (const ch of changes) {
      if (ch.type === "removed") delete remote[ch.doc.id];
      else remote[ch.doc.id] = cleanDoc(ch.doc.data());
    }
    const fromCache = snap.metadata.fromCache;
    if (!ready) {
      // The first time, wait for the server's copy so nothing is merged with a stale cache.
      if (fromCache) return;
      wasFromCache = false;
      return firstSync(fid);
    }
    if (changes.length) takeRemote();
    // Back in touch with the server (or edits waiting from before): send them.
    if (!fromCache && (wasFromCache || hasPending())) push();
    wasFromCache = fromCache;
    if (!pushing) setStatus(fromCache ? (navigator.onLine ? "connecting" : "offline") : hasPending() ? "saving" : "synced");
  }, (e) => (e.code === "permission-denied" ? lost() : setStatus("error", friendly(e))));
}

// This account was taken out of the family space (or it was deleted): stop syncing, keep the data.
function lost() {
  stopListening();
  writeLocal({ familyId: null });
  base = {};
  setStatus("no-family");
  hooks.onNoFamily?.(getCloud(), { removed: true });
}

function firstSync(fid) {
  const state = hooks.getState();
  const hadFamilyData = Object.values(remote).some((f) => Object.keys(f).length);
  // Starting a new space without this phone's data (it belongs to another account): start clean.
  if (firstMode === "family" && !hadFamilyData) hooks.resetLocal?.();
  const local = encode(state);
  const merged = firstMerge(local, remote, { used: firstMode === "add" && !!state.updatedAt });
  let changed = decodeInto(state, merged);
  if (hooks.tidyAfterFirstSync?.(state)) changed = true;   // e.g. "ghee 1 kg" + "ghee 500 g" from two phones
  base = clone(remote);
  ready = true;
  saveBase(fid, base);
  writeLocal({ uid: user.uid, familyId: fid, lastFamily: fid, lastUid: user.uid });
  const uploaded = hasPending();
  if (changed) hooks.onRemoteChange?.();
  push();
  hooks.onFirstSync?.({ hadFamilyData, uploaded });
}

function hasPending() {
  return Object.keys(pending(encode(hooks.getState()), base)).length > 0;
}

// Other phones' changes arrived: merge them into this phone's data. This phone's own edits
// that aren't in the cloud yet are kept (they go up with the next write).
function takeRemote() {
  const state = hooks.getState();
  const local = encode(state);
  const merged = merge(local, base, remote);
  base = clone(remote);
  saveBase(familyId, base);
  if (JSON.stringify(merged) !== JSON.stringify(local) && decodeInto(state, merged)) hooks.onRemoteChange?.();
}

// Sends this phone's edits now (also used when the page is hidden or closed).
export function syncNow() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (ready && fb) push();
}

// Called after every edit; batches quick edits into one write.
export function pushSoon() {
  if (!ready) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, PUSH_DELAY_MS);
}

// Writes this phone's edits in one transaction: for each changed field it reads what the cloud
// has now and merges (see resolve), so nothing another phone wrote in the meantime is lost.
// Offline, nothing is sent; the edits wait on the phone (with `base`) until it is back online.
function push() {
  if (!ready || !fb) return;
  if (pushing) { pushAgain = true; return; }
  const state = hooks.getState();
  const changes = pending(encode(state), base);
  const docs = Object.keys(changes);
  if (!docs.length) { setStatus("synced"); return; }
  if (!navigator.onLine) { setStatus("offline"); return; }
  clearTimeout(retryTimer);
  const { F, db } = fb;
  const items = F.collection(db, "families", familyId, "items");
  const started = clone(base);
  const mine = session;
  setStatus("saving");
  pushing = F.runTransaction(db, async (tx) => {
    const refs = docs.map((d) => F.doc(items, d));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));   // all reads before any write
    const written = {};
    snaps.forEach((snap, i) => {
      const d = docs[i];
      const server = snap.exists() ? cleanDoc(snap.data()) : {};
      const after = { ...server };
      const update = {};
      written[d] = {};
      for (const [k, mineVal] of Object.entries(changes[d])) {
        const v = resolve(started[d]?.[k], mineVal, server[k]);
        written[d][k] = v;
        update[k] = v === undefined ? F.deleteField() : v;
        if (v === undefined) delete after[k]; else after[k] = v;
      }
      if (!Object.keys(after).length) tx.delete(refs[i]);
      else tx.set(refs[i], update, { merge: true });
    });
    return written;
  }).then((written) => {
    if (mine !== session) return;
    // The cloud now has these values: they are the new starting point. Where the merge changed
    // a value this phone hasn't touched again since, show the merged value here too.
    const now = encode(state);
    const next = clone(now);
    for (const [d, fields] of Object.entries(written)) {
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) { if (base[d]) delete base[d][k]; }
        else (base[d] ||= {})[k] = v;
        if (now[d]?.[k] === changes[d][k] && v !== changes[d][k]) {
          if (v === undefined) delete next[d]?.[k]; else (next[d] ||= {})[k] = v;
        }
      }
    }
    saveBase(familyId, base);
    if (JSON.stringify(next) !== JSON.stringify(now) && decodeInto(state, next)) hooks.onRemoteChange?.();
    setStatus(hasPending() ? "saving" : "synced");
  }, (e) => {
    if (mine !== session) return;
    console.warn("Sync write failed", e);
    if (!navigator.onLine || e?.code === "unavailable") setStatus("offline");
    else setStatus("error", friendly(e));
    retryTimer = setTimeout(push, RETRY_MS);
  }).finally(() => {
    if (mine !== session) return;
    pushing = null;
    if (pushAgain) { pushAgain = false; push(); }
  });
}

function friendly(e) {
  const code = e?.code || "";
  if (code === "permission-denied") return "This account isn't allowed to open that family space.";
  if (code === "unavailable") return "Couldn't reach the cloud. Changes are saved on this phone and will sync later.";
  if (code === "resource-exhausted") return "The free daily sync limit was reached. Changes are saved on this phone and will sync tomorrow.";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Sign-in was closed before it finished.";
  if (code === "auth/unauthorized-domain") return "This website isn't allowed to sign in yet. Add it under Authentication > Settings > Authorized domains in the Firebase console.";
  if (code === "auth/network-request-failed") return "Couldn't reach Google. Check the internet connection and try again.";
  return e?.message || "Something went wrong with family sync.";
}

export async function signIn() {
  if (!fb) throw new Error("Family sync hasn't loaded yet. Check the internet connection and reload.");
  const { A, auth } = fb;
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === "auth/popup-blocked" || e?.code === "auth/operation-not-supported-in-this-environment") return A.signInWithRedirect(auth, provider);
    throw new Error(friendly(e));
  }
}

// Emulator only: sign in as any Google account without a popup, for tests.
export async function signInForTest(email, name = "") {
  if (!fb) throw new Error("Family sync hasn't loaded yet");
  if (!fb.emulator) throw new Error("Only available with the Firebase emulator");
  const { A, auth } = fb;
  const cred = A.GoogleAuthProvider.credential(JSON.stringify({ sub: "test-" + normEmail(email), email: normEmail(email), email_verified: true, name }));
  await A.signInWithCredential(auth, cred);
}

export async function signOutCloud() {
  if (!fb) return;
  // Give edits not yet sent a moment to reach the family. Offline they stay on this phone, and
  // go up if the same account signs in again.
  syncNow();
  for (let i = 0; i < 2 && pushing; i++) await Promise.race([pushing, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  stopListening();
  writeLocal({ uid: null, familyId: null });
  base = {};
  await fb.A.signOut(fb.auth);
}

// `fresh` starts the space empty instead of with this phone's data.
export async function startFamily({ name = "Our family", fresh = false } = {}) {
  const { F, db } = fb;
  const email = normEmail(user.email);
  const ref = await F.addDoc(F.collection(db, "families"), { name, owner: user.uid, ownerEmail: email, emails: [email], createdAt: F.serverTimestamp() });
  connect(ref.id, { mode: fresh ? "family" : "add" });
}

// Looks again for a family space that someone added this account to. Returns how many were found.
export async function checkFamilyAgain() {
  if (!user) return 0;
  return offerFamilies();
}

export async function addMember(email) {
  const e = normEmail(email);
  if (!validEmail(e)) throw new Error("Enter an email address, for example name@gmail.com.");
  if (family?.emails?.includes(e)) throw new Error(`${e} is already in the family.`);
  if ((family?.emails?.length || 0) >= 10) throw new Error("A family space can have up to 10 people.");
  const { F, db } = fb;
  await F.updateDoc(F.doc(db, "families", family.id), { emails: F.arrayUnion(e) }).catch((err) => { throw new Error(friendly(err)); });
}

export async function removeMember(email) {
  const e = normEmail(email);
  if (e === family?.ownerEmail) throw new Error("The person who started the family space can't be removed.");
  const { F, db } = fb;
  await F.updateDoc(F.doc(db, "families", family.id), { emails: F.arrayRemove(e) }).catch((err) => { throw new Error(friendly(err)); });
}
