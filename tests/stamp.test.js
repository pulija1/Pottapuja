// The Pages deploy step that versions every file URL (stale-cache blank page fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampJs, stampHtml } from "../scripts/stamp-version.mjs";

test("DEPLOY-01 module imports and page assets get the deploy version", () => {
  assert.equal(stampJs('import { a } from "./shared/plan.js";\nimport x from "../store.js";', "abc123"),
    'import { a } from "./shared/plan.js?v=abc123";\nimport x from "../store.js?v=abc123";');
  assert.equal(stampJs('const m = await import("./store.js");', "v1"), 'const m = await import("./store.js?v=v1");');
  assert.equal(stampJs('fetch("api/recipes"); const s = "https://x.js";', "v1"), 'fetch("api/recipes"); const s = "https://x.js";');
  assert.equal(stampHtml('<link rel="stylesheet" href="style.css"><script src="boot.js"></script><a href="https://github.com/x.js">', "v1"),
    '<link rel="stylesheet" href="style.css?v=v1"><script src="boot.js?v=v1"></script><a href="https://github.com/x.js">');
});
