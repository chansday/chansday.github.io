import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
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
  const tempRoot = await mkdtemp(join(resolve(tmpdir()), "kospi-calendar-guard-"));
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
  const tempRoot = await mkdtemp(join(resolve(tmpdir()), "kospi-calendar-fail-closed-"));
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
    assert.doesNotMatch(workflow, /github\.run_started_at/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/_run-stage\.yml/);
  }
  const shared = await readFile(new URL("_run-stage.yml", workflowRoot), "utf8");
  assert.ok(shared.indexOf("Guard KOSPI trading day") < shared.indexOf("Run resolved KOSPI stage"));
  assert.match(shared, /Capture actual runner start timestamp/);
  assert.match(shared, /GITHUB_OUTPUT/);
  assert.match(shared, /GITHUB_ENV/);
  assert.doesNotMatch(shared, /inputs\.run_started_at/);
  assert.match(shared, /scripts\/run-context\.mjs/);
  const runNow = await readFile(new URL("run-now.yml", workflowRoot), "utf8");
  assert.match(runNow, /auto_stage: true/);
  assert.doesNotMatch(runNow, /github\.run_started_at/);
  assert.match(runNow, /uses: \.\/\.github\/workflows\/_run-stage\.yml/);
  assert.match(shared, /npm test && npm run check/);
  assert.match(shared, /no_data\/partial\/degraded\/blocked/);
  assert.match(shared, /steps\.stage\.outcome.*success/);
  assert.match(shared, /steps\.stage\.outputs\.status == 'ready'/);
  assert.match(shared, /steps\.capture-run-context\.outcome == 'success'/);
  assert.match(shared, /steps\.capture-run-context\.outputs\.run_started_at != ''/);
  assert.match(shared, /steps\.checkout\.outcome == 'success'/);
  assert.match(shared, /steps\.setup-node\.outcome == 'success'/);
  assert.match(shared, /steps\.validate-run-context\.outcome == 'success'/);
  assert.match(shared, /-z "\$run_started_at"/);
  assert.match(shared, /\?\?\?\?-\?\?-\?\?T\?\?:\?\?:\?\?\.\?\?\?Z/);
  assert.doesNotMatch(shared, /steps\.stage\.outcome == 'failure'/);
  assert.match(shared, /steps\.market-day\.outcome.*success/);
  assert.match(shared, /git push/);
});

test("a non-ready stage exposes its status and cannot satisfy the snapshot commit gate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/_run-stage.yml", import.meta.url), "utf8");
  const tempRoot = await mkdtemp(join(resolve(tmpdir()), "kospi-stage-no-commit-"));
  const outputPath = join(tempRoot, "github-output");
  const script = fileURLToPath(new URL("../scripts/update-results.mjs", import.meta.url));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        script,
        "--mode", "forecast",
        "--provider", "none",
        "--run-date", "2026-10-27",
        "--run-started-at", "2026-10-27T00:15:00.000Z",
        "--attempted-at", "2026-10-27T00:15:00.000Z",
      ], {
        cwd: tempRoot,
        env: { ...process.env, GITHUB_OUTPUT: outputPath, KOSPI_RUN_ID: "test-run.1" },
      }),
      (error) => error.code === 2 || error.status === 2,
    );
    assert.match(await readFile(outputPath, "utf8"), /^status=no_data\r?$/m);
    assert.match(workflow, /steps\.stage\.outcome == 'success'/);
    assert.match(workflow, /steps\.stage\.outputs\.status == 'ready'/);
    assert.doesNotMatch(workflow, /steps\.stage\.outcome == 'failure'/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run all now exposes only run_date and commits the final state once", async () => {
  const workflow = await readFile(new URL("run-all-now.yml", new URL("../.github/workflows/", import.meta.url)), "utf8");
  assert.match(workflow, /name: KOSPI run all now/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /run_date:/);
  assert.doesNotMatch(workflow, /inputs:\s*\n\s+provider:/);
  assert.doesNotMatch(workflow, /inputs:\s*\n\s+stage:/);
  assert.match(workflow, /KOSPI_RUN_ID: \$\{\{ github\.run_id \}\}\.\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /KOSPI_RUN_DATE: \$\{\{ inputs\.run_date \}\}/);
  assert.match(workflow, /Capture actual run start timestamp/);
  assert.match(workflow, /echo "run_started_at=\$run_started_at" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /echo "KOSPI_RUN_STARTED_AT=\$run_started_at" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(workflow, /KOSPI_RUN_STARTED_AT: \$\{\{ github\.run_started_at \}\}/);
  assert.match(workflow, /--run-started-at "\$\{\{ steps\.run-context\.outputs\.run_started_at \}\}"/);
  assert.match(workflow, /steps\.run-all\.outcome.*skipped/);
  assert.match(workflow, /partial\)/);
  assert.match(workflow, /ready\)/);
  assert.match(workflow, /blocked\|degraded/);
  assert.match(workflow, /empty or unknown overall_status/);
  assert.match(workflow, /outputs\.overall_status == 'ready'/);
  assert.match(workflow, /outputs\.overall_status == 'partial'/);
  assert.match(workflow, /outputs\.pending_only_partial == 'true'/);
  assert.match(workflow, /outputs\.executed_stages_ready == 'true'/);
  assert.match(workflow, /outputs\.commit_allowed == 'true'/);
  assert.match(workflow, /only non-executed stages; every executed stage was ready/);
  assert.match(workflow, /group: kospi-signal-board-pipeline/);
  assert.match(workflow, /git add data\/latest-snapshot\.json data\/runs/);
  assert.equal((workflow.match(/git commit -m/g) || []).length, 1);
  const runner = await readFile(new URL("../scripts/run-all.mjs", import.meta.url), "utf8");
  assert.match(runner, /const STAGES = Object\.freeze\(\[/);
  assert.match(runner, /"update-results",\s+"analysis",\s+"forecast",\s+"open-settlement",\s+"close-settlement"/s);
  assert.match(runner, /--run-date/);
  assert.match(runner, /KOSPI_PROVIDER: "naver-crawl"/);
  assert.doesNotMatch(runner, /fixture|demo|replay/i);
});

test("push validation is isolated from the feature workflows and cannot write snapshots", async () => {
  const validation = await readFile(new URL("../.github/workflows/validation.yml", import.meta.url), "utf8");
  assert.match(validation, /push:/);
  assert.match(validation, /npm test && npm run check && npm run collection:audit/);
  assert.match(validation, /git diff --exit-code -- data\/latest-snapshot\.json data\/runs/);
  assert.doesNotMatch(validation, /workflow_dispatch:/);
});
