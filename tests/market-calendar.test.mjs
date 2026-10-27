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

test("feature workflows expose input-free buttons and route through the shared guarded runner", async () => {
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  const expected = {
    "update-results.yml": ["0 22 * * 0-4", "update-results"],
    "analysis.yml": ["0 23 * * 0-4", "analysis"],
    "forecast.yml": ["20 23 * * 0-4", "forecast"],
    "open-settlement.yml": ["0 0 * * 1-5", "open-settlement"],
    "close-settlement.yml": ["30 6 * * 1-5", "close-settlement"],
  };
  for (const [file, [cron, stage]] of Object.entries(expected)) {
    const workflow = await readFile(new URL(file, workflowRoot), "utf8");
    assert.match(workflow, /workflow_dispatch:\r?\n/);
    assert.match(workflow, new RegExp(`cron: "${cron.replaceAll("*", "\\*")}"`));
    assert.match(workflow, new RegExp(`stage: ${stage}`));
    assert.match(workflow, /provider: naver-crawl/);
    assert.doesNotMatch(workflow, /inputs:/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/_run-stage\.yml/);
  }
  const shared = await readFile(new URL("_run-stage.yml", workflowRoot), "utf8");
  assert.ok(shared.indexOf("Guard KOSPI trading day") < shared.indexOf("Run resolved KOSPI stage"));
  assert.match(shared, /run_started_at:/);
  assert.match(shared, /inputs\.run_started_at/);
  assert.match(shared, /scripts\/run-context\.mjs/);
  const runNow = await readFile(new URL("run-now.yml", workflowRoot), "utf8");
  assert.match(runNow, /auto_stage: true/);
  assert.match(runNow, /run_started_at: \$\{\{ github\.run_started_at \}\}/);
  assert.match(runNow, /uses: \.\/\.github\/workflows\/_run-stage\.yml/);
  assert.match(shared, /npm test && npm run check/);
  assert.match(shared, /no_data\/partial\/degraded\/blocked/);
  assert.match(shared, /git push/);
});

test("push validation is isolated from the feature workflows and cannot write snapshots", async () => {
  const validation = await readFile(new URL("../.github/workflows/validation.yml", import.meta.url), "utf8");
  assert.match(validation, /push:/);
  assert.match(validation, /npm test && npm run check && npm run collection:audit/);
  assert.match(validation, /git diff --exit-code -- data\/latest-snapshot\.json data\/runs/);
  assert.doesNotMatch(validation, /workflow_dispatch:/);
});
