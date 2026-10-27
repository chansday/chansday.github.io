import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createDailyBaselineExperiment } from "../providers/daily-baseline-experiment.js";
import { runDailyBaseline } from "../scripts/daily-baseline-run.mjs";
import { runAll } from "../scripts/run-all.mjs";

const response = (text, status = 200) => ({ ok: status === 200, status, headers: { get: () => "text/plain" }, text: async () => text });
function setup({ denied = false, missing = ["20261026"], quote = "2026-10-27T08:20:00+09:00" } = {}) {
  const calls = [];
  const values = { 20261026: 101, 20261023: 110, 20261022: 120, 20261021: 90 };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/robots.txt")) return response(`User-agent: *\n${denied ? "Disallow" : "Allow"}: /\n`);
    const date = url.match(/quotes_([0-9]{8})/)?.[1];
    if (missing.includes(date) || !values[date]) return response("", 404);
    return response(`basDt,종목코드,종목명,mrktCtg,mkp,clpr,trqu\n${date},000001,A,KOSPI,100,${values[date]},1000\n${date},000002,B,KOSPI,100,105,1000\n`);
  };
  return { calls, fetchImpl, now: () => new Date(quote), targetDate: "2026-10-27", env: { KOSPI_PUBLIC_MAX_RETRIES: "0" } };
}
test("a missing immediately prior session is explicit; estimates never masquerade as observations", async () => {
  const result = await createDailyBaselineExperiment(setup());
  assert.equal(result.status, "experimental"); assert.equal(result.stale, true);
  assert.deepEqual(result.unavailable_dates, ["2026-10-26"]);
  assert.deepEqual(result.history_dates, ["2026-10-23", "2026-10-22", "2026-10-21"]);
  assert.equal(result.input_type, "latest_available_prior_close_reference_not_quote");
  const row = result.rows.find((item) => item.symbol === "000001");
  assert.equal(row.reference_price, 110); assert.equal(row.estimated_close, 117.33); assert.equal(row.estimated_return, 6.66);
  for (const key of ["expected_open", "actual_open", "actual_close", "error"]) assert.equal(Object.hasOwn(row, key), false);
  assert.notEqual(row.estimated_return, result.rows.find((item) => item.symbol === "000002").estimated_return);
});
test("more than one missing session and robots denial fail closed", async () => {
  const missing = await createDailyBaselineExperiment(setup({ missing: ["20261026", "20261023"] }));
  assert.equal(missing.status, "no_data"); assert.deepEqual(missing.rows, []);
  const config = setup({ denied: true }); const denied = await createDailyBaselineExperiment(config);
  assert.equal(denied.status, "blocked"); assert.equal(config.calls.length, 1);
});
test("past and post-close forecasts are not reconstructed; intraday is labelled", async () => {
  const old = setup({ quote: "2026-10-28T08:20:00+09:00" });
  assert.equal((await createDailyBaselineExperiment(old)).status, "no_data"); assert.equal(old.calls.length, 0);
  const post = setup({ quote: "2026-10-27T15:30:00+09:00" });
  assert.equal((await createDailyBaselineExperiment(post)).status, "no_data"); assert.equal(post.calls.length, 0);
  assert.equal((await createDailyBaselineExperiment(setup({ quote: "2026-10-27T10:00:00+09:00" }))).phase, "during-market");
});

test("a market phase change while collecting fails closed", async () => {
  const config = setup(); let count = 0;
  config.now = () => new Date(++count === 1 ? "2026-10-27T08:59:59+09:00" : "2026-10-27T09:00:01+09:00");
  const result = await createDailyBaselineExperiment(config);
  assert.equal(result.status, "no_data"); assert.deepEqual(result.rows, []);
});

test("mock forecast survives isolated JSON persistence and HTTP retrieval", async () => {
  const result = await createDailyBaselineExperiment(setup());
  const dir = await mkdtemp(join(tmpdir(), "daily-baseline-"));
  const file = join(dir, "experiment.json");
  const server = createServer(async (_req, res) => { res.setHeader("content-type", "application/json"); res.end(await readFile(file)); });
  try {
    await writeFile(file, JSON.stringify(result));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/experiment.json`);
    const loaded = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(loaded, result);
    assert.equal(loaded.input_type, "latest_available_prior_close_reference_not_quote");
    assert.ok(loaded.rows.every((row) => !Object.hasOwn(row, "expected_open") && !Object.hasOwn(row, "actual_close")));
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test("run-all saves an isolated forecast once and does not promote blocked settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-run-all-"));
  try {
    const args = ["--run-date", "2026-10-27", "--run-started-at", "2026-10-26T23:20:00Z"];
    const deps = { stageRunner: async () => ({ status: "blocked", message: "robots", stageFile: null }),
      consistencyChecker: async () => ({ status: "ready" }),
      experimentRunner: () => runDailyBaseline({ ...setup(), root }) };
    const first = await runAll(args, deps);
    assert.equal(first.status, "blocked"); assert.equal(first.commitAllowed, false);
    assert.equal(first.experiment.status, "experimental"); assert.equal(first.experiment.saved, true);
    const before = await readFile(first.experiment.path, "utf8");
    await rm(join(root, "2026-10-27-status.json"));
    const second = await runAll(args, deps);
    assert.equal(second.experiment.status, "preserved");
    assert.equal(await readFile(first.experiment.path, "utf8"), before);
    const record = JSON.parse(before);
    assert.ok(record.rows.every((row) => !("expected_open" in row) && !("actual_open" in row) && !("actual_close" in row)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future collection timestamp is rejected before writing", async () => {
  const result = await createDailyBaselineExperiment(setup());
  const root = await mkdtemp(join(tmpdir(), "baseline-future-"));
  try {
    result.history_retrieved_at = "2026-10-27T02:00:00Z";
    const saved = await runDailyBaseline({ targetDate: "2026-10-27", root, create: async () => result });
    assert.equal(saved.status, "failed");
    assert.equal(JSON.parse(await readFile(saved.statusPath, "utf8")).reason, "collection_error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mock collection saves a phase record served from the site root and renders it", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-site-root-"));
  const elements = new Map();
  class Element {
    constructor() { this.children = []; this.value = ""; this.textContent = ""; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    addEventListener() {}
  }
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    if (!/^\/data\/experiments\/2026-10-27-(before-open|during-market|status)\.json$/.test(req.url)) { res.writeHead(404).end(); return; }
    try { const content = await readFile(join(root, req.url.slice(1))); res.writeHead(200, { "content-type": "application/json" }).end(content); }
    catch (error) { if (error.code === "ENOENT") res.writeHead(404).end(); else res.writeHead(500).end(); }
  });
  try {
    const saved = await runDailyBaseline({ ...setup(), root: join(root, "data", "experiments") });
    assert.equal(saved.saved, true);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;
    globalThis.document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: () => new Element() };
    globalThis.fetch = (url, options) => previousFetch(new URL(url, origin), options);
    const { renderDailyExperiments } = await import("../providers/daily-experiment-view.js");
    await renderDailyExperiments("2026-10-27");
    assert.match(elements.get("daily-experiment-status").textContent, /실험 기록 1개/);
    const flattened = (el) => typeof el === "string" ? el : [el.textContent, ...el.children.map(flattened)].join(" ");
    const rendered = flattened(elements.get("daily-experiment-results"));
    assert.match(rendered, /000001/); assert.match(rendered, /117\.33/); assert.match(rendered, /6\.66%/);
    const original = await readFile(saved.path, "utf8");
    await rm(saved.statusPath);
    const blocked = await runDailyBaseline({ ...setup({ denied: true }), root: join(root, "data", "experiments") });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.reason, "robots_blocked");
    await renderDailyExperiments("2026-10-27");
    assert.match(elements.get("daily-experiment-status").textContent, /robots 정책으로 차단/);
    assert.match(flattened(elements.get("daily-experiment-results")), /000001/);
    assert.equal(await readFile(saved.path, "utf8"), original);
    await rm(blocked.statusPath);
    const retried = await runDailyBaseline({ ...setup(), root: join(root, "data", "experiments") });
    assert.equal(retried.status, "preserved");
    await renderDailyExperiments("2026-10-27");
    assert.match(elements.get("daily-experiment-status").textContent, /기존 실험 보존/);
    assert.equal(await readFile(saved.path, "utf8"), original);
    await rm(retried.statusPath);
    const missingResult = await runDailyBaseline({ ...setup({ missing: ["20261026", "20261023"] }), root: join(root, "data", "experiments") });
    await renderDailyExperiments("2026-10-27");
    assert.match(elements.get("daily-experiment-status").textContent, /수집 데이터 부족/);
    await rm(missingResult.statusPath);
    await runDailyBaseline({ ...setup(), root: join(root, "data", "experiments"), create: async () => { throw new Error("failure"); } });
    await renderDailyExperiments("2026-10-27");
    assert.match(elements.get("daily-experiment-status").textContent, /수집 또는 검증 실패/);
    await renderDailyExperiments("2026-10-28");
    assert.match(elements.get("daily-experiment-status").textContent, /미실행 또는 상태 기록 누락/);
  } finally {
    globalThis.document = previousDocument; globalThis.fetch = previousFetch;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});


test("failure and unavailable data have separate status and attempts can retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "experiment-status-"));
  try {
    const blocked = await runDailyBaseline({ ...setup({ denied: true }), root });
    assert.equal(blocked.status, "blocked");
    let status = JSON.parse(await readFile(blocked.statusPath, "utf8"));
    assert.equal(status.reason, "robots_blocked");
    await rm(blocked.statusPath);
    const missing = await runDailyBaseline({ ...setup({ missing: ["20261026", "20261023"] }), root });
    status = JSON.parse(await readFile(missing.statusPath, "utf8"));
    assert.equal(status.status, "no_data"); assert.equal(status.reason, "data_unavailable");
    await rm(missing.statusPath);
    const failed = await runDailyBaseline({ ...setup(), root, create: async () => { throw new Error("private token"); } });
    status = JSON.parse(await readFile(failed.statusPath, "utf8"));
    assert.equal(status.status, "failed"); assert.equal(status.reason, "collection_error");
    assert.doesNotMatch(JSON.stringify(status), /private token/);
    await rm(failed.statusPath);
    const retried = await runDailyBaseline({ ...setup(), root });
    assert.equal(retried.status, "experimental"); assert.equal(retried.saved, true);
    assert.equal(JSON.parse(await readFile(retried.statusPath, "utf8")).status, "experimental");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run-all summary reports experiment failure separately from ready operating stages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "experiment-summary-"));
  const summaryFile = join(dir, "summary.txt"), previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    const result = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-26T23:20:00Z"], {
      stageRunner: async () => ({ status: "ready" }), consistencyChecker: async () => ({ status: "ready" }),
      experimentRunner: async () => ({ status: "blocked", reason: "robots_blocked", statusSaved: true, saved: false }),
    });
    assert.equal(result.commitAllowed, true); assert.equal(result.experiment.status, "blocked");
    assert.match(await readFile(summaryFile, "utf8"), /isolated daily experiment: `blocked` \(robots_blocked\)/);
  } finally { if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previous; await rm(dir, { recursive: true, force: true }); }
});

test("status persistence failure is not reported as success", async () => {
  const root = await mkdtemp(join(tmpdir(), "experiment-status-write-"));
  try {
    const notDirectory = join(root, "file"); await writeFile(notDirectory, "x");
    await assert.rejects(() => runDailyBaseline({ ...setup({ denied: true }), root: notDirectory }));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("both workflows save status independently and fail on experiment errors", async () => {
  const stage = await readFile(new URL("../.github/workflows/_run-stage.yml", import.meta.url), "utf8");
  const all = await readFile(new URL("../.github/workflows/run-all-now.yml", import.meta.url), "utf8");
  assert.match(stage, /steps\.daily-experiment\.outputs\.status_saved/);
  assert.match(stage, /steps\.daily-experiment\.outcome.*!=.*success/);
  assert.match(stage, /isolated daily experiment status/);
  assert.match(all, /steps\.run-all\.outputs\.experiment_status_saved/);
  assert.match(all, /experimental\|preserved/);
  assert.match(all, /Experiment status could not be saved/);
  for (const workflow of [stage, all]) assert.match(workflow, /bash scripts\/stage-daily-experiment\.sh/);
});


test("status failure retry stages validated unpublished forecast through the workflow shell", async () => {
  const work = await mkdtemp(join(tmpdir(), "experiment-workflow-"));
  const checkout = join(work, "repo"), clone = join(work, "clone");
  const bash = process.platform === "win32" ? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
  const exec = (command, args, cwd, env = {}) => {
    const r = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    if (r.error || r.status !== 0) throw new Error(`${command} failed: ${r.error || r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  try {
    await mkdir(join(checkout, "scripts"), { recursive: true });
    await mkdir(join(checkout, "providers"), { recursive: true });
    await writeFile(join(checkout, "package.json"), '{"type":"module"}\n');
    for (const path of ["scripts/stage-daily-experiment.sh", "scripts/stage-daily-experiment.mjs", "scripts/stage-experiment-status.mjs", "providers/daily-experiment-contract.js", "providers/evaluation-contract.js"]) await copyFile(new URL(`../${path}`, import.meta.url), join(checkout, path));
    exec("git", ["init", "-q"], checkout);
    exec("git", ["config", "user.email", "test@example.invalid"], checkout);
    exec("git", ["config", "user.name", "Test"], checkout);
    exec("git", ["add", "package.json", "scripts", "providers"], checkout);
    exec("git", ["commit", "-qm", "test fixture"], checkout);
    const root = join(checkout, "data", "experiments"), statusPath = join(root, "2026-10-27-status.json");
    await mkdir(root, { recursive: true });
    const invalid = join(root, "2026-10-27-during-market.json");
    await writeFile(invalid, "{}\n");
    const rejection = spawnSync(bash, ["scripts/stage-daily-experiment.sh"], { cwd: checkout, encoding: "utf8", env: { ...process.env, EXPERIMENT_DATE: "2026-10-27", EXPERIMENT_CANDIDATES: "during-market", EXPERIMENT_CANDIDATE: "true", STATUS_SAVED: "false" } });
    assert.notEqual(rejection.status, 0);
    assert.equal(exec("git", ["diff", "--cached", "--name-only"], checkout), "");
    await rm(invalid);
    const precomputed = await createDailyBaselineExperiment(setup());
    await assert.rejects(() => runDailyBaseline({ ...setup(), root, create: async () => { await mkdir(statusPath); return precomputed; } }));
    const predictionPath = join(root, "2026-10-27-before-open.json");
    const original = await readFile(predictionPath, "utf8");
    await rm(statusPath, { recursive: true });
    const retry = await runDailyBaseline({ ...setup({ denied: true }), root });
    assert.equal(retry.status, "blocked"); assert.equal(retry.saved, false); assert.equal(retry.candidate, true);
    assert.deepEqual(retry.candidatePhases, ["before-open"]);
    const env = { EXPERIMENT_DATE: "2026-10-27", EXPERIMENT_CANDIDATES: retry.candidatePhases.join(","), EXPERIMENT_CANDIDATE: "true", STATUS_SAVED: "true", STATUS_HASH: retry.statusHash };
    exec(bash, ["scripts/stage-daily-experiment.sh"], checkout, env);
    assert.deepEqual(exec("git", ["diff", "--cached", "--name-only"], checkout).split(/\r?\n/).sort(), ["data/experiments/2026-10-27-before-open.json", "data/experiments/2026-10-27-status.json"]);
    assert.equal(exec("git", ["show", ":data/experiments/2026-10-27-before-open.json"], checkout), original.trim());
    exec("git", ["commit", "-qm", "publish fixture"], checkout);
    exec("git", ["clone", "-q", checkout, clone], work);
    const clonePath = join(clone, "data", "experiments", "2026-10-27-before-open.json");
    await writeFile(clonePath, "local-user-modification\n");
    exec(bash, ["scripts/stage-daily-experiment.sh"], clone, { ...env, STATUS_SAVED: "false" });
    assert.equal(exec("git", ["diff", "--cached", "--name-only"], clone), "");
    assert.equal(await readFile(clonePath, "utf8"), "local-user-modification\n");
    assert.equal(exec("git", ["show", "HEAD:data/experiments/2026-10-27-before-open.json"], clone), original.trim());
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("invalid existing orphan forecast is not accepted or staged", async () => {
  const root = await mkdtemp(join(tmpdir(), "experiment-invalid-"));
  try {
    const path = join(root, "2026-10-27-before-open.json");
    await writeFile(path, "{}\n");
    const retry = await runDailyBaseline({ ...setup(), root });
    assert.equal(retry.status, "failed"); assert.notEqual(retry.candidate, true);
    assert.equal(await readFile(path, "utf8"), "{}\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("concurrent attempts reserve one phase file without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "experiment-reserve-"));
  try {
    const forecast = await createDailyBaselineExperiment(setup());
    const args = { ...setup(), root, create: async () => forecast };
    const results = await Promise.allSettled([runDailyBaseline(args), runDailyBaseline(args)]);
    assert.ok(results.some((result) => result.status === "fulfilled" && result.value.candidate));
    assert.deepEqual(JSON.parse(await readFile(join(root, "2026-10-27-before-open.json"), "utf8")), forecast);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("dirty tracked, staged and untracked status files stay unchanged and are never staged by workflow", async () => {
  const repo = await mkdtemp(join(tmpdir(), "experiment-user-status-"));
  const root = join(repo, "data", "experiments"), path = join(root, "2026-10-27-status.json");
  const bash = process.platform === "win32" ? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
  const exec = (command, args, env = {}) => {
    const r = spawnSync(command, args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    if (r.error || r.status !== 0) throw new Error(`${command} failed: ${r.error || r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFile(path, "published status\n");
    for (const file of ["stage-daily-experiment.sh", "stage-experiment-status.mjs"]) await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(repo, "scripts", file));
    await writeFile(join(repo, "package.json"), '{"type":"module"}\n');
    exec("git", ["init", "-q"]); exec("git", ["config", "user.email", "test@example.invalid"]); exec("git", ["config", "user.name", "Test"]);
    exec("git", ["add", "data", "scripts", "package.json"]); exec("git", ["commit", "-qm", "fixture"]);
    let called = false;
    const args = { ...setup(), root, create: async () => { called = true; return { status: "blocked", reason: "robots" }; } };
    await writeFile(path, "user modification\n");
    await assert.rejects(() => runDailyBaseline(args), /existing user changes/);
    assert.equal(called, false); assert.equal(await readFile(path, "utf8"), "user modification\n");
    assert.equal(exec("git", ["diff", "--cached", "--name-only"]), "");
    exec("git", ["add", "--", "data/experiments/2026-10-27-status.json"]);
    await assert.rejects(() => runDailyBaseline(args), /existing user changes/);
    assert.equal(await readFile(path, "utf8"), "user modification\n");
    assert.equal(exec("git", ["show", ":data/experiments/2026-10-27-status.json"]), "user modification");
    exec("git", ["reset", "-q", "HEAD", "--", "data/experiments/2026-10-27-status.json"]);
    exec("git", ["restore", "--", "data/experiments/2026-10-27-status.json"]);
    const made = await runDailyBaseline(args);
    await writeFile(path, "user edit after execution\n");
    const env = { EXPERIMENT_DATE: "2026-10-27", EXPERIMENT_CANDIDATE: "false", STATUS_SAVED: "true", STATUS_HASH: made.statusHash };
    const stage = spawnSync(bash, ["scripts/stage-daily-experiment.sh"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    assert.notEqual(stage.status, 0); assert.equal(await readFile(path, "utf8"), "user edit after execution\n");
    assert.equal(exec("git", ["diff", "--cached", "--name-only"]), "");
    exec("git", ["restore", "--", "data/experiments/2026-10-27-status.json"]);
    exec("git", ["update-index", "--assume-unchanged", "data/experiments/2026-10-27-status.json"]);
    await writeFile(path, "hidden user modification\n");
    await assert.rejects(() => runDailyBaseline(args), /existing user changes/);
    assert.equal(await readFile(path, "utf8"), "hidden user modification\n");
    exec("git", ["update-index", "--no-assume-unchanged", "data/experiments/2026-10-27-status.json"]);
    exec("git", ["restore", "--", "data/experiments/2026-10-27-status.json"]);
    await assert.rejects(() => runDailyBaseline({ ...args, create: async () => { await writeFile(path, "edit during execution\n"); return { status: "blocked", reason: "robots" }; } }), /existing user changes|changed during execution/);
    assert.equal(await readFile(path, "utf8"), "edit during execution\n");
    const untracked = join(root, "2026-10-28-status.json"); await writeFile(untracked, "untracked user bytes\n");
    called = false;
    await assert.rejects(() => runDailyBaseline({ ...args, targetDate: "2026-10-28" }), /existing user changes|not tracked/);
    assert.equal(called, false); assert.equal(await readFile(untracked, "utf8"), "untracked user bytes\n");
    assert.equal(exec("git", ["diff", "--cached", "--name-only"]), "");
  } finally { await rm(repo, { recursive: true, force: true }); }
});
