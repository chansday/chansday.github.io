import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkMarketDate, classifyMarketDate, loadMarketCalendar } from "../scripts/market-calendar.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("checked-in KRX calendar covers 2026 and validates its source contract", async () => {
  const calendar = await loadMarketCalendar();
  assert.equal(calendar.market, "KOSPI");
  assert.equal(calendar.timezone, "Asia/Seoul");
  assert.equal(calendar.coverage.end, "2026-12-31");
  assert.equal(calendar.holidays.length, 17);
  assert.equal(calendar.source.name.includes("한국거래소"), true);
});

test("market guard runs on a covered weekday and skips weekends", async () => {
  const calendar = await loadMarketCalendar();
  assert.equal(classifyMarketDate("2026-10-27", calendar).status, "run");
  assert.equal(classifyMarketDate("2026-10-24", calendar).reason, "weekend");
  assert.equal(classifyMarketDate("2026-10-25", calendar).reason, "weekend");
});

test("market guard skips ordinary, substitute, and temporary KRX holidays", async () => {
  for (const [date, reason] of [
    ["2026-05-05", "public_holiday"],
    ["2026-05-25", "substitute_holiday"],
    ["2026-06-03", "temporary_holiday"],
    ["2026-10-05", "substitute_holiday"],
  ]) {
    const result = await checkMarketDate(date);
    assert.equal(result.status, "skip", date);
    assert.equal(result.reason, reason, date);
  }
});

test("unknown covered weekdays fail closed instead of collecting", async () => {
  const result = await checkMarketDate("2027-01-04");
  assert.equal(result.status, "error");
  assert.equal(result.reason, "calendar_coverage_missing");
});

test("CLI guard writes a false output for manual weekend/holiday runs", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-calendar-guard-"));
  const outputPath = join(tempRoot, "github-output");
  const script = fileURLToPath(new URL("../scripts/market-session-guard.mjs", import.meta.url));
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, "--date", "2026-10-05"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.match(stdout, /"status":"skip"/);
    assert.match(await readFile(outputPath, "utf8"), /should_run=false/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI guard fails closed when the calendar has no coverage", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-calendar-fail-closed-"));
  const outputPath = join(tempRoot, "github-output");
  const script = fileURLToPath(new URL("../scripts/market-session-guard.mjs", import.meta.url));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--date", "2027-01-04"], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      }),
      /No checked-in KRX calendar covers 2027-01-04/,
    );
    assert.match(await readFile(outputPath, "utf8"), /should_run=false/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workflow guard gates validation, every collection stage, and commit while retaining manual dispatch", async () => {
  const workflow = await readFile(new URL("../.github/workflows/kospi-pipeline.yml", import.meta.url), "utf8");
  const guardIndex = workflow.indexOf("Guard KOSPI trading day");
  const firstCollectionIndex = workflow.indexOf("Run previous-day result update");
  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.ok(guardIndex >= 0 && guardIndex < firstCollectionIndex);
  assert.equal((workflow.match(/steps\.market-day\.outputs\.should_run == 'true'/g) || []).length >= 8, true);
  assert.match(workflow, /name: Commit snapshot state when changed\r?\n\s+if: steps\.market-day\.outputs\.should_run == 'true'/);
});
