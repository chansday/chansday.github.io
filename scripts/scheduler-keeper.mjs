import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadMarketCalendar } from "./market-calendar.mjs";
import { KEEPER_WORKFLOW, STAGES, kstDayStartIso, planKeeper } from "./scheduler-plan.mjs";

// Keeper loop: plans with scheduler-plan.mjs, reads today's stage runs from
// the Actions API and dispatches stage workflows with the job's GITHUB_TOKEN
// (workflow_dispatch from GITHUB_TOKEN creates runs). No external service,
// PAT or secret. Uses only api.github.com.
const API = "https://api.github.com";
const USER_AGENT = "chansday-kospi-scheduler-keeper";
const MAX_SLEEP_MS = 15 * 60_000; // re-poll at least every 15 minutes
const MAX_LOOPS = 400;

export function githubClient({ token, repository, fetchImpl = globalThis.fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT };
  return {
    async listRuns(workflow, sinceIso) {
      const url = `${API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?created=${encodeURIComponent(`>=${sinceIso}`)}&per_page=50`;
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw new Error(`list runs ${workflow}: HTTP ${response.status}`);
      const body = await response.json();
      return (body.workflow_runs || []).map(({ id, event, status, conclusion, created_at }) => ({ id, event, status, conclusion, created_at }));
    },
    async dispatch(workflow, ref) {
      const response = await fetchImpl(`${API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ref }), signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 204) throw new Error(`dispatch ${workflow}: HTTP ${response.status}`);
    },
  };
}

export async function runKeeper({ client, calendar, ref = "main", now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, startedAt = now(), stages = STAGES, maxLoops = MAX_LOOPS }) {
  const dispatched = new Map(); // stage id -> synthetic queued runs, covers API listing lag
  const events = [];
  const warnings = new Set();
  for (let loop = 0; loop < maxLoops; loop += 1) {
    const current = now();
    const runsByStage = {};
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
    const plan0 = planKeeper({ now: current, calendar, runsByStage: {}, keeperStartedAt: startedAt, stages });
    if (["exit", "error"].includes(plan0.action.type) && plan0.stages.length === 0) {
      log(JSON.stringify({ at: current.toISOString(), action: plan0.action }));
      events.push({ at: current.toISOString(), ...plan0.action });
      return { result: plan0.action.type, events };
    }
    const since = kstDayStartIso(date);
    for (const stage of stages) {
      const listed = await client.listRuns(stage.workflow, since);
      const synthetic = (dispatched.get(stage.id) || []).filter((s) => !listed.some((r) => Date.parse(r.created_at) >= Date.parse(s.created_at) - 60_000));
      runsByStage[stage.id] = [...listed, ...synthetic];
    }
    const plan = planKeeper({ now: current, calendar, runsByStage, keeperStartedAt: startedAt, stages });
    for (const warning of plan.warnings || []) if (!warnings.has(warning)) { warnings.add(warning); log(`::warning::${warning}`); }
    log(JSON.stringify({ at: current.toISOString(), action: plan.action, stages: plan.stages.map((s) => `${s.id}:${s.state}`) }));
    const { action } = plan;
    if (action.type === "dispatch") {
      await client.dispatch(action.workflow, ref);
      dispatched.set(action.stage, [...(dispatched.get(action.stage) || []), { status: "queued", conclusion: null, created_at: current.toISOString(), event: "workflow_dispatch", synthetic: true }]);
      events.push({ at: current.toISOString(), type: "dispatch", stage: action.stage });
      await sleep(5_000);
      continue;
    }
    if (action.type === "sleep") {
      await sleep(Math.max(1_000, Math.min(MAX_SLEEP_MS, Date.parse(action.until) - current.getTime())));
      continue;
    }
    if (action.type === "relay") {
      await client.dispatch(KEEPER_WORKFLOW, ref);
      events.push({ at: current.toISOString(), type: "relay" });
      return { result: "relay", events, warnings: [...warnings] };
    }
    events.push({ at: current.toISOString(), ...action });
    return { result: action.type, events, warnings: [...warnings] };
  }
  throw new Error("keeper loop limit reached");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const started = new Date();
  (async () => {
    const client = githubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
    const outcome = await runKeeper({ client, calendar: await loadMarketCalendar(), ref: process.env.GITHUB_REF_NAME || "main", startedAt: started });
    const minutes = Math.round((Date.now() - started.getTime()) / 60_000);
    const summary = [`### KOSPI scheduler keeper`, `- result: \`${outcome.result}\``, `- runner minutes: ${minutes}`, ...(outcome.warnings || []).map((w) => `- **warning:** ${w}`), ...outcome.events.map((e) => `- ${e.at}: ${e.type}${e.stage ? ` ${e.stage}` : ""}${e.reason ? ` (${e.reason})` : ""}`)].join("\n");
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (outcome.result === "error") process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
