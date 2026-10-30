import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPostCloseRows, runPostCloseEvaluation } from "../scripts/post-close-evaluation.mjs";
import { runAll } from "../scripts/run-all.mjs";
import { mergePostCloseEvaluation } from "../providers/post-close-overlay.js";
import { runStagePostClose } from "../scripts/stage-post-close-evaluation.mjs";
import { rankHistoryFor } from "./support/rank-fixture.mjs";

const sessions = [
  { date: "2026-10-26", url: "https://example.test/26", rows: [{ symbol: "000001", open: 105, close: 110, volume: 10 }] },
  { date: "2026-10-23", url: "https://example.test/23", rows: [{ symbol: "000001", open: 100, close: 100, volume: 10 }] },
  { date: "2026-10-22", url: "https://example.test/22", rows: [{ symbol: "000001", open: 100, close: 100, volume: 10 }] },
];
const actual = { symbol: "000001", name: "Example", actual_open: 120, actual_close: 126 };
// The rank model is the only expected-close model; a constant +1% rank model
// (fixture) stands in for the day's trained one.
const rankHistory = rankHistoryFor(sessions, ["000001"], { level: 0.01 });

test("prior sessions determine both estimates; same-day observations only change evaluation", () => {
  const [row] = buildPostCloseRows(sessions, [actual], rankHistory);
  assert.equal(row.expected_open, 112.75);
  assert.equal(row.expected_close, 113.88);
  assert.equal(row.expected_return, 1);
  assert.equal(row.session_return, 5);
  assert.equal(row.error, 4);
  assert.equal(row.expected_close_basis.model, "ridge_rank_11_features_60_sessions_v1");
  const [changed] = buildPostCloseRows(sessions, [{ ...actual, actual_open: 150, actual_close: 120 }], rankHistory);
  assert.equal(changed.expected_open, row.expected_open);
  assert.equal(changed.expected_close, row.expected_close);
  assert.notEqual(changed.error, row.error);
  const [missing] = buildPostCloseRows(sessions, [{ ...actual, symbol: "000002" }], rankHistory);
  const [noModel] = buildPostCloseRows(sessions, [actual]);
  assert.equal(noModel.expected_close, null, "no rank model: no substitute close model");
  assert.equal(missing.expected_open, null);
  assert.equal(missing.error, null);
});

test("post-close evaluation saves isolated record, refuses wrong run and preserves existing result", async () => {
  const root = await mkdtemp(join(tmpdir(), "post-close-"));
  const previous = process.cwd();
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const dir = join(root, "data", "runs", "2026-10-27");
    await mkdir(dir, { recursive: true });
    const stageFile = join(dir, "1530.json");
    await writeFile(stageFile, JSON.stringify({ status: "ready", meta: { run_date: "2026-10-27", run_id: "42.1", run_stage: "close-settlement" }, rows: [actual] }));
    const historyFetcher = async () => ({ ok: true, sessions, ...rankHistory, retrieved_at: "2026-10-27T08:00:00Z", robots_url: "https://example.test/robots.txt", robots_checked_at: "2026-10-27T07:59:59Z" });
    await assert.rejects(runPostCloseEvaluation({ runDate: "2026-10-27", runId: "wrong", stageFile, historyFetcher }), /does not belong/);
    const result = await runPostCloseEvaluation({ runDate: "2026-10-27", runId: "42.1", stageFile, historyFetcher });
    const record = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(record.evaluation.evaluated_sample_count, 1);
    assert.equal(record.kind, "post_close_retrospective");
    assert.match(record.notice, /after close/);
    const original = await readFile(result.path, "utf8");
    const preserved = await runPostCloseEvaluation({ runDate: "2026-10-27", runId: "42.1", stageFile, historyFetcher });
    assert.equal(preserved.preserved, true);
    assert.equal(await readFile(result.path, "utf8"), original);
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }); }
});

test("run-all blocks committing when post-close evaluation fails", async () => {
  const summary = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T07:00:00Z", "--run-id", "test"], {
    stageRunner: async () => ({ status: "ready", stageFile: "stub" }),
    consistencyChecker: async () => ({ status: "ready" }),
    retrospectiveRunner: async () => { throw new Error("history unavailable"); },
  });
  assert.equal(summary.status, "blocked");
  assert.equal(summary.commitAllowed, false);
  assert.match(summary.retrospective.message, /history unavailable/);
});

test("run-all executes the retrospective only for a ready current post-close run", async () => {
  let calls = 0;
  const dependencies = {
    stageRunner: async () => ({ status: "ready", stageFile: "stub" }),
    consistencyChecker: async () => ({ status: "ready" }),
    retrospectiveRunner: async ({ runDate, runId, stageFile }) => {
      calls += 1;
      assert.equal(runDate, "2026-10-27"); assert.equal(runId, "test"); assert.equal(stageFile, "stub");
      return { status: "ready", evaluated: 1, total: 1 };
    },
  };
  const afterClose = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T07:00:00Z", "--run-id", "test"], dependencies);
  assert.equal(afterClose.status, "ready"); assert.equal(afterClose.retrospective.status, "ready"); assert.equal(calls, 1);
  const beforeClose = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T03:00:00Z", "--run-id", "test"], dependencies);
  assert.equal(beforeClose.retrospective.status, "not_run"); assert.equal(calls, 1);
});

test("retrospective overlays the existing sheet without changing observed values and rejects mismatched runs", () => {
  const [estimated] = buildPostCloseRows(sessions, [actual], rankHistory);
  const snapshot = { status: "ready", meta: { run_date: "2026-10-27", run_id: "42.1", run_stage: "close-settlement" }, rows: [{ ...actual, status: "valid", actual_volume: 12 }] };
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: "2026-10-27", run_id: "42.1", history_dates: sessions.map((session) => session.date), notice: "Retrospective", rows: [estimated] };
  const result = mergePostCloseEvaluation(snapshot, record);
  assert.equal(result.rows[0].expected_open, 112.75);
  assert.equal(result.rows[0].actual_open, 120);
  assert.equal(result.rows[0].actual_volume, 12);
  assert.equal(result.evaluation.evaluated_sample_count, 1);
  assert.equal(result.meta.retrospective_evaluation, true);
  assert.equal(snapshot.rows[0].expected_open, undefined);
  assert.throws(() => mergePostCloseEvaluation(snapshot, { ...record, run_id: "42.2" }), /identity/);
  assert.throws(() => mergePostCloseEvaluation(snapshot, { ...record, rows: [{ ...estimated, actual_close: 100 }] }), /mismatch/);
});

test("past-date manual run evaluates the stored settlement without collecting or overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "past-settlement-"));
  const previous = process.cwd();
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const dir = join(root, "data", "runs", "2026-10-27");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "1530.json");
    const settlement = { status: "ready", asOfDate: "2026-10-27", provider: { id: "naver-crawl" }, meta: { run_date: "2026-10-27", run_id: "40517864324.1", run_stage: "close-settlement", source: { source_date: "2026-10-27" } }, rows: [actual] };
    const original = JSON.stringify(settlement);
    await writeFile(file, original);
    let called = 0;
    const summary = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T15:58:22Z", "--run-id", "40536268679.1"], {
      stageRunner: async () => { throw new Error("stage collection must not run"); },
      experimentRunner: async () => { throw new Error("experiment must not run"); },
      retrospectiveRunner: async ({ runDate, runId, stageFile }) => { called += 1; assert.equal(runId, "40517864324.1"); assert.equal(runDate, "2026-10-27"); assert.equal(stageFile, "data/runs/2026-10-27/1530.json"); return { status: "ready", evaluated: 1, total: 1 }; },
    });
    assert.equal(called, 1); assert.equal(summary.status, "ready");
    assert.equal(summary.retrospective.historical, true); assert.equal(summary.commitAllowed, true);
    assert.equal(await readFile(file, "utf8"), original);
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }); }
});

test("scheduled close evaluation runs only after close on a confirmed trading day", async () => {
  let calls = 0;
  const evaluator = async (input) => { calls += 1; assert.equal(input.stageFile, "data/runs/2026-10-27/1530.json"); return { status: "ready" }; };
  for (const [runDate, runStartedAt] of [["2026-10-24", "2026-10-24T07:00:00Z"], ["2026-10-05", "2026-10-05T07:00:00Z"], ["2026-05-05", "2026-05-05T07:00:00Z"], ["2026-06-03", "2026-06-03T07:00:00Z"]]) {
    assert.equal((await runStagePostClose({ runDate, runStartedAt, runId: "1.1", evaluator })).status, "skipped");
  }
  await assert.rejects(runStagePostClose({ runDate: "2099-01-05", runStartedAt: "2099-01-05T07:00:00Z", runId: "1.1", evaluator }), /calendar covers/);
  await assert.rejects(runStagePostClose({ runDate: "2026-10-27", runStartedAt: "2026-10-27T06:29:59Z", runId: "1.1", evaluator }), /after 15:30/);
  assert.equal(calls, 0);
  assert.equal((await runStagePostClose({ runDate: "2026-10-27", runStartedAt: "2026-10-27T06:30:00Z", runId: "1.1", evaluator })).status, "ready");
  assert.equal(calls, 1);
});
