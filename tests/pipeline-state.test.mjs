import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { noDataSnapshot } from "../providers/provider-adapter.js";

const exec = promisify(execFile);
const script = new URL("../scripts/update-results.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const date = "2026-10-30";
const ready = (label) => ({ status: "ready", attemptedAt: "2026-10-30T00:00:00.000Z", provider_id: "naver-crawl", message: label });

test("rerunning a stage restores each earlier stage's own saved pipeline result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-state-"));
  try {
    const dir = join(root, "data", "runs", date);
    await mkdir(dir, { recursive: true });
    const base = noDataSnapshot();
    const save = async (file, stage, pipeline, extra = {}) => writeFile(join(dir, `${file}.json`), JSON.stringify({ ...base, mode: "provider", asOfDate: date, ...extra, meta: { ...base.meta, run_date: date, run_stage: stage, ...extra.meta }, pipeline: { ...base.pipeline, ...pipeline } }));
    await save("0700", "update-results", { previousResult: ready("actual 0700") });
    await save("0800", "analysis", { analysis: ready("actual 0800") });
    await save("0820", "forecast", { forecast: ready("actual 0820"), previousResult: ready("stale inherited") });
    await save("0900", "open-settlement", {});
    await assert.rejects(exec(process.execPath, [script, "--mode", "open-settlement", "--provider", "none", "--run-date", date, "--run-started-at", "2026-10-30T01:10:00Z"], { cwd: root }), (e) => e.code === 2);
    const output = JSON.parse(await readFile(join(dir, "0900.json"), "utf8"));
    assert.deepEqual(output.pipeline.previousResult, ready("actual 0700"));
    assert.deepEqual(output.pipeline.analysis, ready("actual 0800"));
    assert.deepEqual(output.pipeline.forecast, ready("actual 0820"));
    assert.equal(output.pipeline.openSettlement.status, "blocked");
    assert.equal(output.pipeline.closeSettlement.status, "pending");
    // Wrong-date or test-only stage files must not replace existing state.
    await save("0700", "update-results", { previousResult: ready("wrong date") }, { meta: { run_date: "2026-10-29" } });
    await save("0800", "analysis", { analysis: ready("test only") }, { meta: { test_only: true } });
    await assert.rejects(exec(process.execPath, [script, "--mode", "open-settlement", "--provider", "none", "--run-date", date, "--run-started-at", "2026-10-30T01:10:00Z"], { cwd: root }), (e) => e.code === 2);
    const again = JSON.parse(await readFile(join(dir, "0900.json"), "utf8"));
    assert.deepEqual(again.pipeline.previousResult, ready("actual 0700"));
    assert.deepEqual(again.pipeline.analysis, ready("actual 0800"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future prior-stage results and future inherited states cannot leak into an earlier run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-future-"));
  try {
    const dir = join(root, "data", "runs", date);
    await mkdir(dir, { recursive: true });
    const base = noDataSnapshot();
    const future = { ...ready("FUTURE_STATE"), attemptedAt: "2026-10-30T03:00:00.000Z" };
    const save = async (file, stage, pipeline) => writeFile(join(dir, `${file}.json`), JSON.stringify({ ...base, mode: "provider", asOfDate: date, meta: { ...base.meta, run_date: date, run_stage: stage }, pipeline: { ...base.pipeline, ...pipeline } }));
    await save("0700", "update-results", { previousResult: future });
    await save("0800", "analysis", { previousResult: future });
    const args = [script, "--mode", "analysis", "--provider", "none", "--run-date", date, "--run-started-at", "2026-10-30T00:00:00Z"];
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(exec(process.execPath, args, { cwd: root }), (e) => e.code === 2);
      const saved = JSON.parse(await readFile(join(dir, "0800.json"), "utf8"));
      assert.deepEqual(saved.pipeline.previousResult, base.pipeline.previousResult);
      assert.equal(saved.pipeline.analysis.status, "blocked");
      assert.deepEqual(JSON.parse(await readFile(join(dir, "0700.json"), "utf8")).pipeline.previousResult, future);
    }
    // Equal timestamps are valid for stages within a single run-all.
    const timely = ready("SAME_RUN");
    await save("0700", "update-results", { previousResult: timely });
    await assert.rejects(exec(process.execPath, args, { cwd: root }), (e) => e.code === 2);
    const saved = JSON.parse(await readFile(join(dir, "0800.json"), "utf8"));
    assert.deepEqual(saved.pipeline.previousResult, timely);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same run accepts its recorded invocation time without accepting a future or different run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-run-id-"));
  try {
    const dir = join(root, "data", "runs", date);
    await mkdir(dir, { recursive: true });
    const base = noDataSnapshot();
    const save = async (step, runId) => writeFile(join(dir, "0700.json"), JSON.stringify({ ...base, mode: "provider", asOfDate: date, meta: { ...base.meta, run_date: date, run_stage: "update-results", run_id: runId }, pipeline: { ...base.pipeline, previousResult: step } }));
    const args = [script, "--mode", "analysis", "--provider", "none", "--run-date", date, "--run-started-at", "2026-10-30T00:00:00Z", "--attempted-at", "2026-10-30T00:01:00Z"];
    const options = { cwd: root, env: { ...process.env, KOSPI_RUN_ID: "same-run" } };
    const run = async () => { await assert.rejects(exec(process.execPath, args, options), (e) => e.code === 2); return JSON.parse(await readFile(join(dir, "0800.json"), "utf8")); };
    const same = { ...ready("same run"), attemptedAt: "2026-10-30T00:01:00.000Z" };
    await save(same, "same-run");
    assert.deepEqual((await run()).pipeline.previousResult, same);
    // Remove the inherited result; a different run after the reference is not evidence.
    await rm(join(dir, "0800.json"));
    await save(same, "another-run");
    assert.deepEqual((await run()).pipeline.previousResult, base.pipeline.previousResult);
    await rm(join(dir, "0800.json"));
    await save({ ...same, attemptedAt: "2099-01-01T00:00:00.000Z" }, "same-run");
    assert.deepEqual((await run()).pipeline.previousResult, base.pipeline.previousResult);
    await rm(join(dir, "0800.json"));
    await save({ ...same, attemptedAt: "2026-10-30T00:02:00.000Z" }, "same-run");
    assert.deepEqual((await run()).pipeline.previousResult, base.pipeline.previousResult);
    await rm(join(dir, "0800.json"));
    await save({ ...same, attemptedAt: "2099-01-01T00:00:00.000Z" }, "same-run");
    const futureArgs = [...args];
    futureArgs[futureArgs.indexOf("--attempted-at") + 1] = "2099-01-01T00:00:00Z";
    await assert.rejects(exec(process.execPath, futureArgs, options), (e) => e.code === 2);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "0800.json"), "utf8")).pipeline.previousResult, base.pipeline.previousResult);
    // A future reference time must not override the real stage clock.
    for (const runId of ["same-run", "another-run"]) {
      await rm(join(dir, "0800.json"));
      await save({ ...same, attemptedAt: "2099-01-01T05:00:00.000Z" }, runId);
      const futureReferenceArgs = [...args];
      futureReferenceArgs[futureReferenceArgs.indexOf("--run-started-at") + 1] = "2099-01-01T06:00:00Z";
      futureReferenceArgs[futureReferenceArgs.indexOf("--attempted-at") + 1] = "2099-01-01T06:00:00Z";
      await assert.rejects(exec(process.execPath, futureReferenceArgs, options), (e) => e.code === 2);
      assert.deepEqual(JSON.parse(await readFile(join(dir, "0800.json"), "utf8")).pipeline.previousResult, base.pipeline.previousResult);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
