import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { loadMarketCalendar } from "../scripts/market-calendar.mjs";
import { KEEPER_WORKFLOW, STAGES, kstDayStartIso, kstInstant, planKeeper, runsForDay } from "../scripts/scheduler-plan.mjs";
import { runKeeper } from "../scripts/scheduler-keeper.mjs";

const calendar = await loadMarketCalendar();
const kst = (date, hhmm, sec = "00") => new Date(`${date}T${hhmm}:${sec}+09:00`);
const DAY = "2026-10-29"; // Thursday, trading day
const run = (date, hhmm, status = "completed", conclusion = "success", event = "workflow_dispatch") => ({ created_at: kst(date, hhmm).toISOString(), status, conclusion, event });
const plan = (hhmm, runsByStage = {}, started = null, sec = "00") => planKeeper({ now: kst(DAY, hhmm, sec), calendar, runsByStage, keeperStartedAt: started ? kst(DAY, started) : kst(DAY, hhmm, sec) });
const state = (p, id) => p.stages.find((s) => s.id === id).state;

test("weekends and KRX holidays exit immediately; missing calendar coverage is an error", () => {
  for (const now of [kst("2026-10-31", "05:00"), kst("2026-11-01", "05:00"), kst("2026-10-09", "05:00"), kst("2026-12-25", "05:00")]) {
    const p = planKeeper({ now, calendar });
    assert.equal(p.action.type, "exit"); assert.match(p.action.reason, /market closed/); assert.deepEqual(p.stages, []);
  }
  assert.equal(planKeeper({ now: kst("2027-01-04", "05:00"), calendar }).action.type, "error");
});

test("before 06:10 the keeper sleeps until just after the first stage time, then dispatches it", () => {
  const early = plan("05:30");
  assert.equal(early.action.type, "sleep"); assert.equal(early.action.until, new Date(kst(DAY, "06:10").getTime() + 3000).toISOString());
  assert.equal(plan("06:10", {}, "05:30", "05").action.stage, "naver-daily-history");
  assert.equal(plan("06:10", {}, "05:30", "01").action.type, "sleep", "never dispatches before the boundary");
});

test("dispatch order and times follow the KST stage table", () => {
  assert.deepEqual(STAGES.map((s) => [s.id, s.at]), [["naver-daily-history", "06:10"], ["update-results", "07:00"], ["analysis", "08:00"], ["forecast", "08:20"], ["open-settlement", "09:00"], ["close-settlement", "15:30"]]);
  const done = (ids) => Object.fromEntries(ids.map((id) => [id, [run(DAY, "06:11")]]));
  assert.equal(plan("07:00", done(["naver-daily-history"]), null, "05").action.stage, "update-results");
  assert.equal(plan("08:20", done(["naver-daily-history", "update-results", "analysis"]), null, "05").action.stage, "forecast");
  assert.equal(plan("15:30", done(["naver-daily-history", "update-results", "analysis", "forecast", "open-settlement"]), null, "05").action.stage, "close-settlement");
  const all = plan("15:40", done(STAGES.map((s) => s.id)));
  assert.equal(all.action.type, "exit");
});

test("history is watched while running and retried once at 07:10 after a failure, never after 07:45", () => {
  const running = plan("06:12", { "naver-daily-history": [run(DAY, "06:10", "in_progress", null)] });
  assert.equal(state(running, "naver-daily-history"), "watch"); assert.equal(running.action.type, "sleep");
  assert.ok(Date.parse(running.action.until) - kst(DAY, "06:12").getTime() <= 5 * 60_000);
  const failed = { "naver-daily-history": [run(DAY, "06:10", "completed", "failure")] };
  assert.equal(state(plan("06:40", failed), "naver-daily-history"), "waiting");
  assert.equal(plan("07:10", failed).action.stage, "naver-daily-history");
  assert.equal(state(plan("07:50", failed), "naver-daily-history"), "missed");
  const twice = { "naver-daily-history": [run(DAY, "06:10", "completed", "failure"), run(DAY, "07:10", "completed", "failure")] };
  assert.equal(state(plan("07:20", twice), "naver-daily-history"), "failed");
});

test("a late keeper skips missed pre-open stages but still runs settlement late on the same day", () => {
  const late = plan("09:30");
  for (const id of ["naver-daily-history", "update-results", "analysis", "forecast"]) assert.equal(state(late, id), "missed");
  assert.equal(late.action.stage, "open-settlement");
  const afternoon = plan("21:34", { "open-settlement": [run(DAY, "09:31")] });
  assert.equal(afternoon.action.stage, "close-settlement");
  const night = plan("23:30");
  assert.equal(night.action.type, "exit"); assert.ok(night.stages.every((s) => s.state === "missed"));
  const forecastEdge = plan("08:50", {}, null, "00");
  assert.equal(state(forecastEdge, "forecast"), "due"); assert.equal(state(plan("08:51"), "forecast"), "missed");
});

test("duplicates are prevented: queued, running, successful or failed runs today count; other days and events do not", () => {
  for (const r of [run(DAY, "07:00", "queued", null), run(DAY, "07:00", "in_progress", null), run(DAY, "07:00"), run(DAY, "07:00", "completed", "failure")]) {
    const p = plan("07:05", { "naver-daily-history": [run(DAY, "06:10")], "update-results": [r] });
    assert.notEqual(p.action.stage, "update-results");
  }
  const otherDay = plan("07:05", { "naver-daily-history": [run(DAY, "06:10")], "update-results": [run("2026-10-28", "07:00")] });
  assert.equal(otherDay.action.stage, "update-results");
  assert.equal(runsForDay([run(DAY, "07:00", "completed", "success", "push")], DAY).length, 0);
  // Cancelled runs (e.g. a replaced pending run) are dispatched again, at most three times.
  const cancelled = (n) => ({ "naver-daily-history": [run(DAY, "06:10")], "update-results": Array.from({ length: n }, () => run(DAY, "07:00", "completed", "cancelled")) });
  assert.equal(plan("07:05", cancelled(1)).action.stage, "update-results");
  assert.equal(state(plan("07:05", cancelled(3)), "update-results"), "gave_up");
  assert.equal(kstDayStartIso(DAY), "2026-10-28T15:00:00.000Z");
});

test("relay happens before the runner budget; the relayed keeper continues with remaining stages", () => {
  const sleeping = plan("04:00", {}, "00:07");
  assert.equal(sleeping.action.type, "sleep"); assert.equal(sleeping.action.until, new Date(kst(DAY, "00:07").getTime() + 325 * 60_000).toISOString());
  const relay = planKeeper({ now: new Date(kst(DAY, "00:07").getTime() + 325 * 60_000), calendar, keeperStartedAt: kst(DAY, "00:07") });
  assert.equal(relay.action.type, "relay");
  const done = Object.fromEntries(STAGES.slice(0, 5).map((s) => [s.id, [run(DAY, s.at)]]));
  const midday = plan("10:30", done, "09:00");
  assert.equal(midday.action.type, "sleep"); assert.equal(midday.action.until, kst(DAY, "14:25").toISOString());
});

test("runKeeper simulation dispatches each stage once at its time and relays within the budget", async () => {
  let clock = kst(DAY, "05:00").getTime();
  const runs = new Map(STAGES.map((s) => [s.workflow, []]));
  const dispatches = [];
  const client = {
    async listRuns(workflow, since) {
      assert.equal(since, kstDayStartIso(DAY));
      // A dispatched run appears 1 minute later and succeeds after 10 minutes.
      return runs.get(workflow).filter((r) => r.visibleAt <= clock).map((r) => ({ ...r, status: clock >= r.doneAt ? "completed" : "in_progress", conclusion: clock >= r.doneAt ? "success" : null }));
    },
    async dispatch(workflow) {
      dispatches.push([workflow, new Date(clock).toISOString()]);
      if (runs.has(workflow)) runs.get(workflow).push({ created_at: new Date(clock).toISOString(), event: "workflow_dispatch", visibleAt: clock + 60_000, doneAt: clock + 600_000 });
    },
  };
  const deps = { client, calendar, now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, log: () => {} };
  const first = await runKeeper({ ...deps, startedAt: new Date(clock) });
  assert.equal(first.result, "relay");
  const second = await runKeeper({ ...deps, startedAt: new Date(clock) });
  assert.equal(second.result, "exit");
  const stageDispatches = dispatches.filter(([w]) => w !== KEEPER_WORKFLOW);
  assert.deepEqual(stageDispatches.map(([w]) => w), STAGES.map((s) => s.workflow));
  for (const [workflow, at] of stageDispatches) {
    const stage = STAGES.find((s) => s.workflow === workflow);
    const delay = Date.parse(at) - kst(DAY, stage.at).getTime();
    assert.ok(delay >= 3000 && delay < 60_000, `${workflow} dispatched ${delay} ms after its time`);
  }
  assert.equal(dispatches.filter(([w]) => w === KEEPER_WORKFLOW).length, 1);
  const relayAt = Date.parse(dispatches.find(([w]) => w === KEEPER_WORKFLOW)[1]);
  assert.ok(relayAt - kst(DAY, "05:00").getTime() <= 325 * 60_000 + 60_000);
});

test("runKeeper on a holiday exits without calling the API", async () => {
  const client = { listRuns: async () => { throw new Error("must not call"); }, dispatch: async () => { throw new Error("must not call"); } };
  const result = await runKeeper({ client, calendar, now: () => kst("2026-12-25", "05:00"), sleep: async () => {}, log: () => {} });
  assert.equal(result.result, "exit");
});

test("workflows: keeper has minimal permissions and bounded runtime; stages are dispatch-only; actions are current majors", async () => {
  const root = new URL("../.github/workflows/", import.meta.url);
  const keeper = (await readFile(new URL("scheduler-keeper.yml", root), "utf8")).replace(/\r\n/g, "\n");
  assert.match(keeper, /permissions:\n  actions: write\n  contents: read\n/);
  assert.match(keeper, /concurrency:\n  group: kospi-scheduler-keeper\n  cancel-in-progress: false/);
  const timeout = Number(keeper.match(/timeout-minutes: (\d+)/)[1]); assert.ok(timeout <= 340);
  assert.match(keeper, /node scripts\/scheduler-keeper\.mjs/); assert.match(keeper, /workflow_dispatch:/);
  const crons = [...keeper.matchAll(/cron: "(\d+) (\d+) \* \* ([\d-]+)"/g)].map(([, m, h]) => (Number(h) * 60 + Number(m) + 540) % 1440);
  assert.ok(crons.filter((t) => t < 6 * 60).length >= 4, "several pre-dawn KST starts");
  for (const file of await readdir(root)) {
    const text = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(text, /\t/, `${file} has a tab`); assert.match(text, /^name: /m); assert.match(text, /^on:/m);
    assert.doesNotMatch(text, /actions\/(checkout|setup-node)@v[1-6]\b/, `${file} uses an old action major`);
    assert.doesNotMatch(text, /secrets\.(?!KOSPI_PROVIDER_API_KEY|KOSPI_PROVIDER_BASE_URL|inherit)/);
  }
  for (const stage of STAGES) {
    const text = await readFile(new URL(stage.workflow, root), "utf8");
    assert.doesNotMatch(text, /cron:/, `${stage.workflow} must not keep a duplicate schedule`); assert.match(text, /workflow_dispatch:/);
  }
});

// Simulated Actions API with the shared pipeline queue: a dispatch made while
// another stage run is active is recorded as an overlap (it would be pending and
// could be cancelled by the next pending run).
function simulate({ start, durationMs = 180_000, conclusionFor = () => "success" }) {
  let clock = start.getTime();
  const runs = new Map(STAGES.map((s) => [s.workflow, []]));
  const dispatches = [], overlaps = [];
  const statusOf = (r) => (clock >= r.doneAt ? { status: "completed", conclusion: r.conclusion } : { status: "in_progress", conclusion: null });
  const client = {
    async listRuns(workflow) { return runs.get(workflow).filter((r) => r.visibleAt <= clock).map((r) => ({ created_at: r.created_at, event: "workflow_dispatch", ...statusOf(r) })); },
    async dispatch(workflow) {
      dispatches.push([workflow, clock]);
      if (!runs.has(workflow)) return;
      const active = [...runs.entries()].flatMap(([w, list]) => list.filter((r) => clock < r.doneAt).map(() => w));
      if (active.length) overlaps.push([workflow, active]);
      const attempt = runs.get(workflow).length + 1;
      runs.get(workflow).push({ created_at: new Date(clock).toISOString(), visibleAt: clock + 20_000, doneAt: clock + (typeof durationMs === "function" ? durationMs(workflow) : durationMs), conclusion: conclusionFor(workflow, attempt) });
    },
  };
  const deps = { client, calendar, now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, log: () => {} };
  return { deps, dispatches, overlaps, now: () => clock };
}

test("a keeper starting at 08:40 runs the late pre-open stages one at a time, in order, without overlap", async () => {
  const sim = simulate({ start: kst(DAY, "08:40") });
  let outcome;
  do outcome = await runKeeper({ ...sim.deps, startedAt: new Date(sim.now()) }); while (outcome.result === "relay");
  const order = sim.dispatches.filter(([w]) => w !== KEEPER_WORKFLOW).map(([w]) => w);
  assert.deepEqual(order, ["update-results.yml", "analysis.yml", "forecast.yml", "open-settlement.yml", "close-settlement.yml"]);
  assert.deepEqual(sim.overlaps, [], "no stage is dispatched while another stage run is active");
  const at = Object.fromEntries(sim.dispatches.map(([w, t]) => [w, t]));
  assert.ok(at["analysis.yml"] >= at["update-results.yml"] + 180_000 && at["forecast.yml"] >= at["analysis.yml"] + 180_000);
  assert.ok(at["forecast.yml"] <= kst(DAY, "08:50").getTime());
});

test("sequential late processing marks a pre-open stage missed once its last start passes", async () => {
  const sim = simulate({ start: kst(DAY, "08:40"), durationMs: 360_000 });
  let outcome;
  do outcome = await runKeeper({ ...sim.deps, startedAt: new Date(sim.now()) }); while (outcome.result === "relay");
  const order = sim.dispatches.filter(([w]) => w !== KEEPER_WORKFLOW).map(([w]) => w);
  assert.deepEqual(order, ["update-results.yml", "analysis.yml", "open-settlement.yml", "close-settlement.yml"], "forecast would start after 08:50 and is missed");
  assert.deepEqual(sim.overlaps, []);
});

test("the 07:10 history retry waits for a running update-results instead of queueing behind it", async () => {
  const sim = simulate({ start: kst(DAY, "06:00"), durationMs: (w) => (w === "update-results.yml" ? 15 * 60_000 : 120_000), conclusionFor: (w, attempt) => (w === "naver-daily-history.yml" && attempt === 1 ? "failure" : "success") });
  let outcome;
  do outcome = await runKeeper({ ...sim.deps, startedAt: new Date(sim.now()) }); while (outcome.result === "relay");
  const history = sim.dispatches.filter(([w]) => w === "naver-daily-history.yml").map(([, t]) => t);
  const update = sim.dispatches.find(([w]) => w === "update-results.yml")[1];
  assert.equal(history.length, 2);
  assert.ok(history[1] >= update + 15 * 60_000, "retry starts only after update-results completed");
  assert.ok(history[1] <= kst(DAY, "07:45").getTime());
  assert.deepEqual(sim.overlaps, []);
});

test("an active run blocks the next due stage; a stuck run stops blocking after 45 minutes", () => {
  const since = (hhmm, status = "in_progress") => ({ "naver-daily-history": [run(DAY, "06:10")], "update-results": [run(DAY, hhmm, status, null)] });
  for (const status of ["queued", "in_progress"]) {
    const blocked = plan("08:00", since("07:30", status), null, "05");
    assert.equal(blocked.action.type, "sleep"); assert.match(blocked.action.reason, /analysis waits for update-results/);
    assert.ok(Date.parse(blocked.action.until) - kst(DAY, "08:00", "05").getTime() <= 30_000);
  }
  assert.equal(plan("08:00", since("07:16"), null, "05").action.type, "sleep", "active for 44 min still blocks");
  assert.equal(plan("08:00", since("07:14"), null, "05").action.stage, "analysis", "active for 46 min no longer blocks");
  assert.equal(plan("08:00", since("07:30", "completed"), null, "05").action.stage, "analysis");
});

test("the planner warns within 30 days of the calendar coverage end", () => {
  assert.deepEqual(planKeeper({ now: kst("2026-10-29", "05:00"), calendar }).warnings, []);
  const warned = planKeeper({ now: kst("2026-12-02", "05:00"), calendar });
  assert.equal(warned.warnings.length, 1); assert.match(warned.warnings[0], /coverage ends 2026-12-31 \(29 days left\)/);
});
