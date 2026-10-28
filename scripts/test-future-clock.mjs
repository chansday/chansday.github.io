// Runs the test suite with the clock moved forward, as stage jobs will see it
// on later trading days. A test that depends on today's date or on data that
// the stages refresh daily fails here at push time instead of blocking a stage.
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSETS_DAYS = [1, 3, 8, 45];
const preload = pathToFileURL(fileURLToPath(new URL("../tests/support/fake-clock.mjs", import.meta.url))).href;
const testFiles = ["--test", "tests/*.test.mjs"];

let failed = 0;
for (const days of OFFSETS_DAYS) {
  const fakeNow = new Date(Date.now() + days * DAY_MS).toISOString();
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${preload}`].filter(Boolean).join(" ");
  const result = spawnSync(process.execPath, testFiles, { stdio: "inherit", env: { ...process.env, KOSPI_FAKE_NOW: fakeNow, NODE_OPTIONS: nodeOptions } });
  console.log(`future clock +${days}d (${fakeNow}): ${result.status === 0 ? "pass" : "FAIL"}`);
  if (result.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
