// Deploy step for GitHub Pages: adds ?v=<version> to every script and stylesheet URL, so a
// phone that cached files from an older deploy can never mix old and new modules (a mix
// fails to start and leaves a blank page). Usage: node scripts/stamp-version.mjs public <version>
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function stampJs(code, v) {
  return code.replace(/((?:from|import)\s*\(?\s*")(\.{1,2}\/[^"?]+\.js)(")/g, `$1$2?v=${v}$3`);
}

export function stampHtml(html, v) {
  return html.replace(/((?:src|href)=")([^":?]+\.(?:js|css))(")/g, `$1$2?v=${v}$3`);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !/^[\w.-]+$/.test(version || "")) { console.error("usage: stamp-version.mjs <dir> <version>"); process.exit(1); }
  let n = 0;
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    const next = file.endsWith(".js") ? stampJs(text, version) : file.endsWith(".html") ? stampHtml(text, version) : text;
    if (next !== text) { writeFileSync(file, next); n++; }
  }
  console.log(`stamped ${n} files with v=${version}`);
}
