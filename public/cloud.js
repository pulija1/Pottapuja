// Family sync with Firebase: Google sign-in, one shared family space, and the app data kept in
// Cloud Firestore so every phone in the family sees the same lists. Firestore keeps a copy on
// the phone, so the app works with no signal and catches up once it is back online.
// The Firebase SDK is loaded only when firebase-config.js has a project in it.

import { firebaseConfig } from "./firebase-config.js";
import { encode, decodeInto, merge, firstMerge, diff, clone, cleanDoc, normEmail, validEmail } from "./shared/cloud-sync.js";

const SDK_VERSION = "13.0.0";
const KEY = "familyMealPlanner.cloud";
const PUSH_DELAY_MS = 400;

let fb = null;            // { app, auth, db, A: auth module, F: firestore module }
let hooks = {};
let user = null;
let family = null;        // { id, name, emails, ownerEmail, owner }
let remote = {};          // the family's data as Firestore has it (with this phone's writes applied)
let base = {};            // the data as it was at this phone's last sync: tells local edits from remote ones
let ready = false;        // the first sync with the family's data is done
let unsubItems = null, unsubFamily = null;
let status = "off";       // off | loading | unavailable | signed-out | no-family | connecting | synced | saving | offline | error
let lastError = "";
let pendingWrites = 0;
let pushTimer = null;
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

export const cloudSkipped = () => !!readLocal().skipped;
export const setCloudSkipped = (v) => writeLocal({ skipped: !!v });

function setStatus(next, err = "") {
  if (next === "synced" && !navigator.onLine) next = "offline";
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
  window.addEventListener("online", () => { if (ready) setStatus(pendingWrites ? "saving" : "synced"); });
  window.addEventListener("offline", () => { if (ready) setStatus("offline"); });
}

function stopListening() {
  unsubItems?.(); unsubFamily?.();
  unsubItems = unsubFamily = null;
  family = null;
  ready = false;
  remote = {};
}

async function onUser(u) {
  stopListening();
  user = u;
  if (!u) { setStatus("signed-out"); return; }
  const saved = readLocal();
  let fid = saved.uid === u.uid ? saved.familyId : null;
  if (!fid) {
    setStatus("connecting");
    try {
      fid = await findFamily();
    } catch (e) {
      setStatus("error", friendly(e));
      return;
    }
  }
  if (!fid) { setStatus("no-family"); hooks.onNoFamily?.(getCloud()); return; }
  connect(fid);
}

async function findFamily() {
  const { F, db } = fb;
  const q = F.query(F.collection(db, "families"), F.where("emails", "array-contains", normEmail(user.email)), F.limit(1));
  const snap = await F.getDocs(q);
  return snap.empty ? null : snap.docs[0].id;
}

function connect(fid) {
  const { F, db } = fb;
  const saved = readLocal();
  const known = saved.uid === user.uid && saved.familyId === fid;
  base = known ? saved.base || {} : {};
  ready = known;
  remote = {};
  setStatus("connecting");
  const famRef = F.doc(db, "families", fid);
  unsubFamily = F.onSnapshot(famRef, (snap) => {
    if (!snap.exists()) return lost();
    family = { id: fid, ...snap.data() };
    hooks.onStatus?.(getCloud());
  }, (e) => (e.code === "permission-denied" ? lost() : setStatus("error", friendly(e))));
  unsubItems = F.onSnapshot(F.collection(famRef, "items"), { includeMetadataChanges: true }, (snap) => {
    const changes = snap.docChanges();
    for (const ch of changes) {
      if (ch.type === "removed") delete remote[ch.doc.id];
      else remote[ch.doc.id] = cleanDoc(ch.doc.data());
    }
    if (!ready) {
      // The first time, wait for the server's copy so nothing is merged with a stale cache.
      if (snap.metadata.fromCache) return;
      return firstSync(fid);
    }
    if (changes.length) syncNow();
    setStatus(snap.metadata.hasPendingWrites || pendingWrites ? "saving" : snap.metadata.fromCache ? (navigator.onLine ? "connecting" : "offline") : "synced");
  }, (e) => (e.code === "permission-denied" ? lost() : setStatus("error", friendly(e))));
}

// This account was taken out of the family space (or it was deleted): stop syncing, keep the data.
function lost() {
  stopListening();
  writeLocal({ familyId: null, base: {} });
  base = {};
  setStatus("no-family");
  hooks.onNoFamily?.(getCloud(), { removed: true });
}

function firstSync(fid) {
  const state = hooks.getState();
  const local = encode(state);
  const hadFamilyData = Object.values(remote).some((f) => Object.keys(f).length);
  const merged = firstMerge(local, remote, { used: !!state.updatedAt });
  const changed = decodeInto(state, merged);
  base = clone(remote);
  ready = true;
  writeLocal({ uid: user.uid, familyId: fid, base });
  push(merged);
  if (changed) hooks.onRemoteChange?.();
  setStatus(pendingWrites ? "saving" : "synced");
  hooks.onFirstSync?.({ hadFamilyData, uploaded: Object.keys(diff(merged, remote).writes).length > 0 });
}

// Merges this phone's edits with the family's latest data and writes what changed.
export function syncNow() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!ready || !fb) return;
  const state = hooks.getState();
  const local = encode(state);
  const merged = merge(local, base, remote);
  base = clone(remote);
  const changed = JSON.stringify(merged) !== JSON.stringify(local) && decodeInto(state, merged);
  push(merged);
  if (changed) hooks.onRemoteChange?.();
}

// Called after every edit; batches quick edits into one write.
export function pushSoon() {
  if (!ready) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, PUSH_DELAY_MS);
}

function push(next) {
  const { writes, empty } = diff(next, base);
  base = clone(next);
  writeLocal({ base });
  if (!Object.keys(writes).length && !empty.length) return;
  const { F, db } = fb;
  const items = F.collection(db, "families", family?.id || readLocal().familyId, "items");
  const batch = F.writeBatch(db);
  for (const [d, fields] of Object.entries(writes)) {
    batch.set(F.doc(items, d), Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === null ? F.deleteField() : v])), { merge: true });
  }
  for (const d of empty) batch.delete(F.doc(items, d));
  pendingWrites++;
  setStatus("saving");
  batch.commit().then(() => {
    pendingWrites--;
    if (!pendingWrites) setStatus("synced");
  }, (e) => {
    pendingWrites--;
    console.warn("Sync write failed", e);
    setStatus("error", friendly(e));
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
  if (!fb?.emulator) throw new Error("Only available with the Firebase emulator");
  const { A, auth } = fb;
  const cred = A.GoogleAuthProvider.credential(JSON.stringify({ sub: "test-" + normEmail(email), email: normEmail(email), email_verified: true, name }));
  await A.signInWithCredential(auth, cred);
}

export async function signOutCloud() {
  if (!fb) return;
  syncNow();
  stopListening();
  writeLocal({ uid: null, familyId: null, base: {} });
  base = {};
  await fb.A.signOut(fb.auth);
}

export async function startFamily(name = "Our family") {
  const { F, db } = fb;
  const email = normEmail(user.email);
  const ref = await F.addDoc(F.collection(db, "families"), { name, owner: user.uid, ownerEmail: email, emails: [email], createdAt: F.serverTimestamp() });
  connect(ref.id);
}

// Looks again for a family space that someone added this account to.
export async function checkFamilyAgain() {
  if (!user) return false;
  setStatus("connecting");
  try {
    const fid = await findFamily();
    if (!fid) { setStatus("no-family"); return false; }
    connect(fid);
    return true;
  } catch (e) {
    setStatus("error", friendly(e));
    return false;
  }
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
