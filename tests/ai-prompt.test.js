import { test } from "node:test";
import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RecipeList } from "../lib/ai.js";
import { RECIPE_LIST_SCHEMA, SYSTEM, buildPrompt, parseRequest } from "../public/shared/ai-prompt.js";
import { looksLikeKey } from "../public/ai-browser.js";

// Field names and required lists only: the browser's schema and the server's zod schema must ask for the same answer.
function shape(schema) {
  if (schema.type === "object") return { required: [...schema.required].sort(), props: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, shape(v)])) };
  if (schema.type === "array") return { items: shape(schema.items) };
  return schema.type;
}

test("AIKEY-01 browser and server ask Claude for the same recipe shape", () => {
  assert.deepEqual(shape(RECIPE_LIST_SCHEMA), shape(zodOutputFormat(RecipeList).schema));
  assert.equal(RECIPE_LIST_SCHEMA.additionalProperties, false);
  assert.deepEqual(RECIPE_LIST_SCHEMA.properties.recipes.items.properties.forWhom.enum, ["baby", "kid", "family"]);
});

test("AIKEY-02 prompt keeps the baby rules and has no names", () => {
  assert.match(SYSTEM, /never honey/);
  const p = buildPrompt(parseRequest({ ingredients: ["ragi", "banana"], forWhom: "baby", schoolNutFree: true }));
  assert.match(p, /ragi, banana/);
  assert.match(p, /8-month-old/);
  assert.match(p, /nut-free/);
});

test("AIKEY-03 key check accepts Claude keys only", () => {
  assert.ok(looksLikeKey("sk-ant-api03-" + "a".repeat(40)));
  assert.ok(!looksLikeKey("ghp_" + "a".repeat(36)));
  assert.ok(!looksLikeKey("sk-ant-"));
  assert.ok(!looksLikeKey(""));
});
