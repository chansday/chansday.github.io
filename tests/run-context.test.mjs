import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStage } from "../scripts/run-context.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("run context derives KST date and current stage from the caller run start", () => {
  const beforeOpen = resolveStage("2026-10-26T23:59:59Z");
  assert.equal(beforeOpen.runDate, "2026-10-27");
  assert.equal(beforeOpen.phase, "before-open");
  assert.equal(beforeOpen.stage, "forecast");
  assert.equal(beforeOpen.referenceTime, "2026-10-26T23:59:59.000Z");
  assert.equal(resolveStage("2026-10-27T01:00:00Z").phase, "after-open");
  assert.equal(resolveStage("2026-10-27T01:00:00Z").stage, "open-settlement");
  assert.equal(resolveStage("2026-10-27T06:30:00Z").phase, "after-close");
  assert.equal(resolveStage("2026-10-27T06:30:00Z").stage, "close-settlement");
});

test("auto-stage dry-run uses the supplied run start for before/open/close paths", async () => {
  const cases = [
    ["2026-10-26T23:59:59Z", "forecast"],
    ["2026-10-27T01:00:00Z", "open-settlement"],
    ["2026-10-27T06:30:00Z", "close-settlement"],
  ];
  for (const [startedAt, expectedStage] of cases) {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/workflow-dry-run.mjs",
      "--auto-stage",
      "--run-started-at",
      startedAt,
      "--provider",
      "none",
    ], { cwd: PROJECT_ROOT });
    const summary = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(summary.mode, expectedStage);
    assert.equal(summary.runDate, "2026-10-27");
    assert.equal(summary.attemptedAt, new Date(startedAt).toISOString());
    assert.equal(summary.status, "no_data");
    assert.equal(summary.dryRun, true);
  }
});

test("public-csv no longer rejects a manual forecast solely because a schedule cutoff passed", async () => {
  const source = await readFile(new URL("../providers/public-csv-provider.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /kstCutoffPassed|forecastCutoff|Forecast collection cutoff/);
  assert.match(source, /no live pre-market quote\/order-book data/);
});

test("run-now and fixed workflows use the crawl provider and forward the caller run start", async () => {
  const runNow = await readFile(new URL("../.github/workflows/run-now.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("../.github/workflows/_run-stage.yml", import.meta.url), "utf8");
  const fixed = await readFile(new URL("../.github/workflows/forecast.yml", import.meta.url), "utf8");
  assert.match(runNow, /provider:\s*naver-crawl/);
  assert.match(fixed, /provider:\s*naver-crawl/);
  assert.match(runner, /--run-started-at.*inputs\.run_started_at/);
  assert.match(runner, /--attempted-at.*inputs\.run_started_at/);
});
