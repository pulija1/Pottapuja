// Firestore security rules (RULES), run against the Firebase emulator: npm run test:firebase
// Only people listed in a family space can read or change it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider, signOut } from "firebase/auth";
import {
  initializeFirestore, connectFirestoreEmulator, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, arrayUnion, arrayRemove, serverTimestamp, terminate,
} from "firebase/firestore";

const PROJECT = process.env.GCLOUD_PROJECT || "demo-meal-planner";
const apps = [];
let n = 0;

async function as(email, { verified = true } = {}) {
  const app = initializeApp({ apiKey: "demo-key", projectId: PROJECT, authDomain: "localhost" }, `u${n++}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  if (email) await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: "s-" + email, email, email_verified: verified })));
  return { db, auth, uid: auth.currentUser?.uid, email };
}

const denied = async (p) => assert.rejects(p, (e) => e.code === "permission-denied");
const tag = Date.now().toString(36);

async function family(owner) {
  const ref = await addDoc(collection(owner.db, "families"), { name: "Our family", owner: owner.uid, ownerEmail: owner.email, emails: [owner.email], createdAt: serverTimestamp() });
  return ref.id;
}

after(async () => {
  for (const a of apps) { await terminate(initializeFirestore(a, {})).catch(() => {}); await deleteApp(a).catch(() => {}); }
});

test("RULES-01 a member can read and write the family's data; others can't", async () => {
  const ram = await as(`ram-${tag}@example.com`);
  const eve = await as(`eve-${tag}@example.com`);
  const fid = await family(ram);
  await setDoc(doc(ram.db, "families", fid, "items", "shopping"), { a1: '{"id":"a1","name":"ghee"}' }, { merge: true });
  assert.ok((await getDoc(doc(ram.db, "families", fid, "items", "shopping"))).exists());
  await denied(getDoc(doc(eve.db, "families", fid)));
  await denied(getDoc(doc(eve.db, "families", fid, "items", "shopping")));
  await denied(setDoc(doc(eve.db, "families", fid, "items", "shopping"), { x: "1" }, { merge: true }));
  await denied(getDocs(collection(eve.db, "families", fid, "items")));
});

test("RULES-02 adding someone by email lets them in; removing them shuts them out", async () => {
  const ram = await as(`ram2-${tag}@example.com`);
  const sita = await as(`sita-${tag}@example.com`);
  const fid = await family(ram);
  await updateDoc(doc(ram.db, "families", fid), { emails: arrayUnion(sita.email) });
  const found = await getDocs(query(collection(sita.db, "families"), where("emails", "array-contains", sita.email)));
  assert.deepEqual(found.docs.map((d) => d.id), [fid]);
  await setDoc(doc(sita.db, "families", fid, "items", "todos-2026-10"), { t1: "{}" }, { merge: true });
  await updateDoc(doc(ram.db, "families", fid), { emails: arrayRemove(sita.email) });
  await denied(getDoc(doc(sita.db, "families", fid, "items", "todos-2026-10")));
});

test("RULES-03 the person who started the space can't be removed or replaced", async () => {
  const ram = await as(`ram3-${tag}@example.com`);
  const sita = await as(`sita3-${tag}@example.com`);
  const fid = await family(ram);
  await updateDoc(doc(ram.db, "families", fid), { emails: arrayUnion(sita.email) });
  await denied(updateDoc(doc(sita.db, "families", fid), { emails: arrayRemove(ram.email) }));
  await denied(updateDoc(doc(sita.db, "families", fid), { owner: sita.uid }));
  await denied(updateDoc(doc(sita.db, "families", fid), { ownerEmail: sita.email }));
  await denied(deleteDoc(doc(sita.db, "families", fid)));
});

test("RULES-04 a new space can only list its creator; not signed in or unverified gets nothing", async () => {
  const ram = await as(`ram4-${tag}@example.com`);
  await denied(addDoc(collection(ram.db, "families"), { name: "x", owner: ram.uid, ownerEmail: ram.email, emails: [ram.email, "other@example.com"], createdAt: serverTimestamp() }));
  await denied(addDoc(collection(ram.db, "families"), { name: "x", owner: "someone-else", ownerEmail: ram.email, emails: [ram.email], createdAt: serverTimestamp() }));
  const fid = await family(ram);
  const anon = await as(null);
  await denied(getDoc(doc(anon.db, "families", fid)));
  const unverified = await as(`ram4-${tag}@example.com`.replace("ram4", "unv"), { verified: false });
  await denied(addDoc(collection(unverified.db, "families"), { name: "x", owner: unverified.uid, ownerEmail: unverified.email, emails: [unverified.email], createdAt: serverTimestamp() }));
});

test("RULES-05 only the app's own document names are accepted, and nothing outside families", async () => {
  const ram = await as(`ram5-${tag}@example.com`);
  const fid = await family(ram);
  for (const d of ["shopping", "reminders", "meta", "todos-2026-10", "days-2026-10", "recipes-3"]) await setDoc(doc(ram.db, "families", fid, "items", d), { k: "1" }, { merge: true });
  await denied(setDoc(doc(ram.db, "families", fid, "items", "anything"), { k: "1" }));
  await denied(setDoc(doc(ram.db, "elsewhere", "x"), { k: "1" }));
  await denied(getDocs(collection(ram.db, "families")));   // can't list every family
});

test("RULES-06 emails in a different case still match", async () => {
  const mixed = await as(`Ram6-${tag}@Example.com`);
  const lower = mixed.email.toLowerCase();
  const fid = (await addDoc(collection(mixed.db, "families"), { name: "Our family", owner: mixed.uid, ownerEmail: lower, emails: [lower], createdAt: serverTimestamp() })).id;
  assert.ok((await getDoc(doc(mixed.db, "families", fid))).exists());
  await signOut(mixed.auth);
});
