// Small zero-config server: serves the browser app and one AI endpoint.
//   GET  /api/health   -> { ok, ai: "live" | "mock" | "off", model }
//   POST /api/recipes  -> { recipes, rejected, mode, ms }  or 503 when the AI is unavailable
// Everything else is a static file from ./public.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { aiMode, generateRecipes, AiUnavailable, MODEL } from "./lib/ai.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 32 * 1024;
// Live AI calls cost money on the family's key: cap them per visitor so a public server can't be drained.
const AI_PER_MINUTE = Number(process.env.AI_PER_MINUTE || 10);

// Browser hardening for every answer (the page's CSP is in index.html, so it also works on GitHub Pages).
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// Fixed one-minute window per key (the client's IP address). Returns false once the key is over the limit.
export function rateLimiter(limit, windowMs = 60000) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const h = hits.get(key);
    if (!h || now - h.start >= windowMs) {
      if (hits.size > 10000) hits.clear();
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    h.count += 1;
    return h.count <= limit;
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (status === 413) headers.connection = "close";
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Stop collecting but keep draining, so the 413 answer reaches the client.
        req.removeAllListeners("data");
        req.resume();
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("Body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("Bad URL");
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    const etag = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" }).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
      etag,
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

export function createServer() {
  const allowAi = rateLimiter(AI_PER_MINUTE);
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/health") {
        const mode = aiMode();
        return sendJson(res, 200, { ok: true, ai: mode, model: mode === "live" ? MODEL : null });
      }
      if (url.pathname === "/api/recipes") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
        if (aiMode() === "live" && !allowAi(req.socket.remoteAddress)) {
          return sendJson(res, 429, { error: "Too many recipe requests. Wait a minute and try again." });
        }
        const body = await readBody(req);
        const ac = new AbortController();
        res.on("close", () => { if (!res.writableEnded) ac.abort(); });
        try {
          const out = await generateRecipes(body, { signal: ac.signal });
          return sendJson(res, 200, out);
        } catch (err) {
          if (ac.signal.aborted) return; // client went away
          if (err instanceof AiUnavailable) {
            console.warn("[ai]", err.message, err.cause?.message || "");
            return sendJson(res, 503, { error: err.message, ai: aiMode() });
          }
          throw err;
        }
      }
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown API route" });
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "Server error" : err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`Meal planner running at http://localhost:${PORT}  (AI: ${aiMode()})`);
  });
}
