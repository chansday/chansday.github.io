import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluatePreviousResult, previousTradingDate } from "../scripts/previous-result.mjs";
import { loadMarketCalendar } from "../scripts/market-calendar.mjs";
const exec = promisify(execFile);
const stageScript = new URL("../scripts/update-results.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

test("previous date respects weekends, holidays, and calendar coverage", async () => {
  const calendar = await loadMarketCalendar();
  assert.equal(previousTradingDate("2026-11-02", calendar), "2026-10-30");
  assert.equal(previousTradingDate("2026-03-03", calendar), "2026-02-27");
  assert.throws(() => previousTradingDate("2026-01-01", calendar), /Calendar does not cover/);
});

test("run-all propagates only its own status produced after checkout", async () => {
  for (const [sourceRun, expected] of [["run-1", "blocked"], ["other-run", "pending"]]) {
    const root = await mkdtemp(join(tmpdir(), "previous-provenance-"));
    try {
      const dir = join(root, "data/runs/2026-10-30");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "previous-result-status.json"), JSON.stringify({ runDate: "2026-10-30", runId: sourceRun,
        status: "blocked", attemptedAt: "2026-10-29T22:00:05Z", message: "same run failure" }));
      const args = [stageScript, "--mode", "analysis", "--provider", "none", "--run-date", "2026-10-30",
        "--run-started-at", "2026-10-29T22:00:00Z", "--attempted-at", "2026-10-29T22:00:05Z"];
      await assert.rejects(exec(process.execPath, args, { cwd: root, env: { ...process.env, KOSPI_RUN_ID: "run-1" } }), e => e.code === 2);
      const result = JSON.parse(await readFile(join(dir, "0800.json"), "utf8"));
      assert.equal(result.pipeline.previousResult.status, expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("stage records failure separately without overwriting latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "previous-stage-"));
  try {
    await mkdir(join(root, "data/runs/2026-11-02"), { recursive: true });
    await mkdir(join(root, "data/runs/2026-11-03"), { recursive: true });
    await writeFile(join(root, "data/latest-snapshot.json"), "original");
    const args = [stageScript, "--mode", "update-results", "--provider", "naver-crawl", "--run-date", "2026-11-03", "--run-started-at", "2026-11-02T22:00:00Z"];
    await assert.rejects(exec(process.execPath, args, { cwd: root }), e => e.code === 2);
    const { readFile } = await import("node:fs/promises");
    const path = join(root, "data/runs/2026-11-03/previous-result-status.json");
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "blocked");
    assert.equal(await readFile(join(root, "data/latest-snapshot.json"), "utf8"), "original");
    const saved = { mode: "provider", provider: { id: "naver-crawl" }, asOfDate: "2026-11-02",
      meta: { run_date: "2026-11-02", run_stage: "close-settlement", source: { source_id: "naver-public-polling-crawl", source_date: "2026-11-02", retrieved_at: "2026-11-02T06:31:20Z" } },
      pipeline: { closeSettlement: { status: "ready", attemptedAt: "2026-11-02T06:31:00Z" } },
      rows: [{ symbol: "005930", actual_open: 100, actual_close: 110, expected_open: 100, expected_close: 105,
        expected_open_source: { kind: "preopen_quote", recorded_at: "2026-11-01T23:00:00Z" }, close_basis: "krx_regular", close_quote_at: "2026-11-02T06:31:00Z", close_quote_age_seconds: 20 }] };
    const closePath = join(root, "data/runs/2026-11-02/1530.json");
    await writeFile(closePath, JSON.stringify(saved));
    await exec(process.execPath, args, { cwd: root });
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "ready");
    await rm(closePath);
    await assert.rejects(exec(process.execPath, args, { cwd: root }), e => e.code === 2);
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "ready");
    assert.equal(await readFile(join(root, "data/latest-snapshot.json"), "utf8"), "original");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved close must be timely, matching, and sourced; missing rows stay partial", async () => {
  const cwd = process.cwd(), root = await mkdtemp(join(tmpdir(), "previous-result-"));
  try {
    process.chdir(root);
    await mkdir("data/runs/2026-11-02", { recursive: true });
    const row = { symbol: "005930", actual_open: 100, actual_close: 110, expected_open: 100, expected_close: 105,
      expected_open_source: { kind: "preopen_quote", recorded_at: "2026-11-01T23:00:00Z" },
      close_basis: "krx_regular", close_quote_at: "2026-11-02T06:31:00Z", close_quote_age_seconds: 20 };
    const saved = { mode: "provider", provider: { id: "naver-crawl" }, asOfDate: "2026-11-02",
      meta: { run_date: "2026-11-02", run_stage: "close-settlement", source: { source_id: "naver-public-polling-crawl", source_date: "2026-11-02", retrieved_at: "2026-11-02T06:31:20Z" } },
      pipeline: { closeSettlement: { status: "ready", attemptedAt: "2026-11-02T06:31:00Z" } }, rows: [row] };
    const file = "data/runs/2026-11-02/1530.json", run = () => evaluatePreviousResult("2026-11-03", "2026-11-02T22:00:00Z");
    await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "ready");
    row.close_quote_age_seconds = 360; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked", "fabricated observation after retrieval is rejected");
    row.close_quote_age_seconds = 20; saved.meta.source.retrieved_at = "2026-11-02T06:40:00Z"; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked", "retrieval outside close window is rejected");
    saved.meta.source.retrieved_at = "2026-11-02T06:31:20Z";
    saved.meta.close_model = { scored_at: "2026-11-02T00:00:00Z", backfill: true }; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked");
    delete saved.meta.close_model;
    saved.meta.source.retrieved_at = "2026-11-03T00:00:00Z"; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked");
    saved.meta.source.retrieved_at = "2026-11-02T06:31:20Z";
    saved.rows.push({ ...row, symbol: "000660", actual_close: null }); await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "partial");
    saved.pipeline.closeSettlement.attemptedAt = "2026-11-02T06:30:11Z"; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked");
    saved.pipeline.closeSettlement.attemptedAt = "2026-11-02T06:31:00Z"; saved.asOfDate = "2026-10-30"; await writeFile(file, JSON.stringify(saved));
    assert.equal((await run()).status, "blocked");
    await rm(file); assert.equal((await run()).status, "blocked");
  } finally { process.chdir(cwd); await rm(root, { recursive: true, force: true }); }
});
