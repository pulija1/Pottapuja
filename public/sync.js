// Sign-in and "Check in": save all app data as Markdown files in the family's private GitHub
// repository (one commit per check-in, plus a session log), and load it back on another device.
// Runs in the browser against the GitHub REST API with the family's own fine-grained token,
// so it works on GitHub Pages with no server. The token lives only in this browser, under its
// own storage key, and never goes into backups or check-ins.

import { toMarkdownFiles, fromMarkdownFiles, sessionMd, summarize, FILES, INDEX } from "./shared/markdown.js";

const KEY = "familyMealPlanner.sync";
const API = "https://api.github.com";
const DEFAULTS = { name: "", login: "", avatar: "", repo: "", branch: "main", folder: "output", token: "", lastSha: "", lastAt: "", lastSummary: null, skipped: false };

export function getSync() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSync(patch) {
  const next = { ...getSync(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function signOut() {
  return setSync({ token: "", login: "", avatar: "", lastSha: "", lastAt: "", lastSummary: null, skipped: false });
}

// A quick, unauthenticated check (3 s) used to decide whether to show the sign-in page at all.
export async function githubReachable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(API + "/zen", { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

export function syncReady(s = getSync()) {
  return /^[\w.-]+\/[\w.-]+$/.test(s.repo) && !!s.token;
}

// "https://github.com/me/data.git" or "me/data/" -> "me/data"
export function cleanRepo(text) {
  return String(text || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

class SyncError extends Error {
  constructor(msg, kind = "") { super(msg); this.kind = kind; }
}

async function gh(s, path, init = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...init,
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${s.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    throw new SyncError("Couldn't reach GitHub. Check the internet connection and try again.", "network");
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  if (res.status === 401) throw new SyncError("GitHub didn't accept the token. Sign in again with a new token.", "auth");
  if (res.status === 403) throw new SyncError("The token isn't allowed to do this. Give it Contents: Read and write on the data repository.", "auth");
  if (res.status === 404) throw new SyncError("Not found", "missing");
  if (res.status === 409) throw new SyncError("The repository is empty", "empty");
  if (res.status === 422) throw new SyncError("Someone else checked in at the same moment", "conflict");
  throw new SyncError(`GitHub answered ${res.status}. Try again in a minute.`);
}

const encPath = (p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

// Checks the token and the repository. Returns the GitHub user, or throws a message to show.
export async function verify({ token, repo }) {
  const s = { token, repo: cleanRepo(repo) };
  if (!token) throw new SyncError("Paste your GitHub token.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(s.repo)) throw new SyncError("Enter the repository as owner/name, for example pulija1/Pottapuja-data.");
  const user = await gh(s, "/user");
  let info;
  try {
    info = await gh(s, `/repos/${s.repo}`);
  } catch (e) {
    if (e.kind === "missing") throw new SyncError(`Can't find ${s.repo}, or the token doesn't include it.`);
    throw e;
  }
  if (!info.private) throw new SyncError(`${s.repo} is public, so anyone could read the family's data. Use a private repository.`);
  if (info.permissions && !info.permissions.push) throw new SyncError("The token can read the repository but not save to it. Give it Contents: Read and write.");
  return { login: user.login, name: user.name || user.login, avatar: user.avatar_url || "", branch: info.default_branch || "main" };
}

async function headSha(s) {
  try {
    const ref = await gh(s, `/repos/${s.repo}/git/ref/heads/${encPath(s.branch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.kind === "missing" || e.kind === "empty") return null;
    throw e;
  }
}

async function readFile(s, path, ref) {
  try {
    const f = await gh(s, `/repos/${s.repo}/contents/${encPath(path)}?ref=${ref}`);
    if (f.content && f.encoding === "base64") return fromBase64(f.content);
    const blob = await gh(s, `/repos/${s.repo}/git/blobs/${f.sha}`);   // files over 1 MB
    return fromBase64(blob.content);
  } catch (e) {
    if (e.kind === "missing") return null;
    throw e;
  }
}

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const stamp = (d) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

// Saves the data as one commit. Unless `force`, refuses with { conflict: true } when another
// device checked in since this one last synced, so nobody's changes are silently replaced.
export async function checkIn(state, { force = false, now = new Date(), today = "" } = {}) {
  const s = getSync();
  if (!syncReady(s)) throw new SyncError("Sign in first.");
  let head = await headSha(s);
  if (!head) {
    // A brand-new empty repository has no branch yet: the contents API can make the first commit.
    await gh(s, `/repos/${s.repo}/contents/${encPath(s.folder + "/" + INDEX)}`, {
      method: "PUT", body: JSON.stringify({ message: "Start the meal planner data folder", content: toBase64("# Family Meal Planner data\n"), branch: s.branch }),
    }).catch((e) => { throw e.kind === "missing" ? new SyncError(`Can't find ${s.repo}, or the token doesn't include it.`) : e; });
    head = await headSha(s);
    s.lastSha = head;
  }
  if (!force && head !== s.lastSha) {
    if (s.lastSha) return { conflict: true };
    // First check-in from this device: only a conflict if another device already checked in.
    const existing = await readFile(s, `${s.folder}/${Object.keys(FILES)[0]}`, head);
    if (existing !== null) return { conflict: true };
  }
  const meta = { at: stamp(now), name: s.name || s.login, today };
  const files = toMarkdownFiles(state, meta);
  const sessionName = `${now.toISOString().slice(0, 19).replace(/[T:]/g, "-")}${s.login ? "-" + s.login.replace(/[^\w-]/g, "") : ""}.md`;
  files[`sessions/${sessionName}`] = sessionMd(state, s.lastSummary, meta);
  const commit = await gh(s, `/repos/${s.repo}/git/commits/${head}`);
  const tree = await gh(s, `/repos/${s.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: Object.entries(files).map(([p, content]) => ({ path: `${s.folder}/${p}`, mode: "100644", type: "blob", content })) }),
  });
  const next = await gh(s, `/repos/${s.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `Check in from ${meta.name || "the meal planner"}, ${meta.at}`, tree: tree.sha, parents: [head] }),
  });
  try {
    await gh(s, `/repos/${s.repo}/git/refs/heads/${encPath(s.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: next.sha, force: false }) });
  } catch (e) {
    if (e.kind === "conflict") return { conflict: true };
    throw e;
  }
  setSync({ lastSha: next.sha, lastAt: now.toISOString(), lastSummary: summarize(state) });
  return { ok: true, url: `https://github.com/${s.repo}/tree/${s.branch}/${s.folder}` };
}

// The latest checked-in data (ready for importJson), or null when nothing is checked in yet.
export async function loadLatest({ now = new Date() } = {}) {
  const s = getSync();
  if (!syncReady(s)) throw new SyncError("Sign in first.");
  const head = await headSha(s);
  if (!head) return null;
  const files = {};
  for (const f of [INDEX, ...Object.keys(FILES)]) files[f] = await readFile(s, `${s.folder}/${f}`, head);
  const data = fromMarkdownFiles(files);
  if (!data) return null;
  setSync({ lastSha: head, lastAt: now.toISOString(), lastSummary: summarize(data) });
  return data;
}
