import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createProgressLog } from "../providers/progress-log.js";
import { loadMarketCalendar } from "./market-calendar.mjs";
import { KEEPER_WORKFLOW, STAGES, catchUpCandidateDates, kstDayStartIso, missingCloseDates, planKeeper } from "./scheduler-plan.mjs";

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
    // File names under data/runs/<date>/ on `ref` (contents API, read-only);
    // a missing directory is an empty list.
    async listRunFiles(date, ref) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid run date ${date}`);
      const response = await fetchImpl(`${API}/repos/${repository}/contents/data/runs/${date}?ref=${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return [];
      if (response.status !== 200) throw new Error(`list data/runs/${date}: HTTP ${response.status}`);
      const body = await response.json();
      return Array.isArray(body) ? body.filter((entry) => entry?.type === "file").map((entry) => entry.name) : [];
    },
    async dispatch(workflow, ref, inputs = null) {
      const response = await fetchImpl(`${API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(inputs ? { ref, inputs } : { ref }), signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 204) throw new Error(`dispatch ${workflow}: HTTP ${response.status}`);
    },
  };
}

export async function runKeeper({ client, calendar, ref = "main", now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, startedAt = now(), stages = STAGES, maxLoops = MAX_LOOPS }) {
  const dispatched = new Map(); // stage id -> synthetic queued runs, covers API listing lag
  const events = [];
  const warnings = new Set();
  let catchUp = null; // { date, dates }: missing 1530.json check, once per KST day
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
    let plan = planKeeper({ now: current, calendar, runsByStage, keeperStartedAt: startedAt, stages, catchUp: catchUp?.date === date ? catchUp : undefined });
    if (plan.stages.some((s) => s.state === "unchecked") && typeof client.listRunFiles === "function") {
      try {
        const candidates = catchUpCandidateDates(date, calendar);
        const filesByDate = {};
        for (const candidate of candidates) filesByDate[candidate] = await client.listRunFiles(candidate, ref);
        catchUp = { date, dates: missingCloseDates(candidates, filesByDate) };
      } catch (error) {
        catchUp = { date, dates: [] };
        const warning = `missing close-settlement check failed; catch-up not dispatched: ${error.message}`;
        if (!warnings.has(warning)) { warnings.add(warning); log(`::warning::${warning}`); }
      }
      plan = planKeeper({ now: current, calendar, runsByStage, keeperStartedAt: startedAt, stages, catchUp });
    }
    for (const warning of plan.warnings || []) if (!warnings.has(warning)) { warnings.add(warning); log(`::warning::${warning}`); }
    log(`판단 #${loop + 1} · ${plan.action.type}${plan.action.stage ? ` ${plan.action.stage}` : ""}${plan.action.until ? ` (다음 확인 ${plan.action.until})` : ""}${plan.action.reason ? ` · ${plan.action.reason}` : ""} · 단계 상태 ${plan.stages.map((s) => `${s.id}:${s.state}`).join(", ")}`);
    const { action } = plan;
    if (action.type === "dispatch") {
      log(`실행 요청 · ${action.workflow}${action.inputs ? ` · 입력 ${JSON.stringify(action.inputs)}` : ""}`);
      await client.dispatch(action.workflow, ref, action.inputs || null);
      dispatched.set(action.stage, [...(dispatched.get(action.stage) || []), { status: "queued", conclusion: null, created_at: current.toISOString(), event: "workflow_dispatch", synthetic: true }]);
      events.push({ at: current.toISOString(), type: "dispatch", stage: action.stage, ...(action.inputs ? { inputs: action.inputs } : {}) });
      await sleep(5_000);
      continue;
    }
    if (action.type === "sleep") {
      log(`대기 · ${Math.round(Math.max(1_000, Math.min(MAX_SLEEP_MS, Date.parse(action.until) - current.getTime())) / 1000)}초 (최대 ${Math.round(MAX_SLEEP_MS / 1000)}초 단위로 재확인)`);
      await sleep(Math.max(1_000, Math.min(MAX_SLEEP_MS, Date.parse(action.until) - current.getTime())));
      continue;
    }
    if (action.type === "relay") {
      log(`runner 시간 한도 전 다음 스케줄러로 이어받기 요청 · ${KEEPER_WORKFLOW}`);
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
    const LOG = createProgressLog({ label: "스케줄러" });
    LOG(`시작 · ref ${process.env.GITHUB_REF_NAME || "main"}`);
    const outcome = await runKeeper({ client, calendar: await loadMarketCalendar(), ref: process.env.GITHUB_REF_NAME || "main", startedAt: started, log: (line) => (String(line).startsWith("::") ? console.log(line) : LOG(line)) });
    LOG(`종료 · ${outcome.result} · 실행 요청 ${outcome.events.filter((e) => e.type === "dispatch").length}건`);
    const minutes = Math.round((Date.now() - started.getTime()) / 60_000);
    const summary = [`### KOSPI scheduler keeper`, `- result: \`${outcome.result}\``, `- runner minutes: ${minutes}`, ...(outcome.warnings || []).map((w) => `- **warning:** ${w}`), ...outcome.events.map((e) => `- ${e.at}: ${e.type}${e.stage ? ` ${e.stage}` : ""}${e.reason ? ` (${e.reason})` : ""}`)].join("\n");
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (outcome.result === "error") process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
