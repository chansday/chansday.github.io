import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("historical result status is applied only to its own date", async () => {
  const code = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const fn = code.match(/async function applyPreviousResultStatus\([\s\S]*?\r?\n}\r?\n/)?.[0];
  assert.ok(fn);
  const status = JSON.parse(await readFile(new URL("../data/runs/2026-11-02/previous-result-status.json", import.meta.url), "utf8"));
  const urls = [];
  const context = vm.createContext({ fetch: async (url) => { urls.push(url); return { ok: true, json: async () => status }; } });
  const apply = vm.runInContext(`(${fn})`, context);
  const historical = { pipeline: { previousResult: { status: "pending" } } };
  await apply(historical, "2026-11-02");
  assert.equal(historical.pipeline.previousResult.status, "partial");
  assert.match(historical.pipeline.previousResult.message, /사후 재계산/);
  const today = { pipeline: { previousResult: { status: "pending" } } };
  await apply(today, "2026-11-03");
  assert.equal(today.pipeline.previousResult.status, "pending");
  assert.equal(urls[0], "./data/runs/2026-11-02/previous-result-status.json");
});
