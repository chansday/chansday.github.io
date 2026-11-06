import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createProgressLog } from "../providers/progress-log.js";
import { loadMarketCalendar } from "./market-calendar.mjs";
import { readFile } from "node:fs/promises";
import { CALENDAR } from "./us-market-calendar.mjs";
import { managedStages, planManaged } from "./scheduler-managed.mjs";
import { KEEPER_BUDGET_MINUTES, KEEPER_WORKFLOW, STAGES, catchUpCandidateDates, kstDayStartIso, kstInstant, missingCloseDates, planKeeper } from "./scheduler-plan.mjs";

// Keeper loop: plans with scheduler-plan.mjs, reads today's stage runs from
// the Actions API and dispatches stage workflows with the job's GITHUB_TOKEN
// (workflow_dispatch from GITHUB_TOKEN creates runs). No external service,
// PAT or secret. Uses only api.github.com.
const API = "https://api.github.com";
const USER_AGENT = "kospi-scheduler-keeper";
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
      return (body.workflow_runs || []).map(({ id, event, status, conclusion, created_at, display_title }) => ({ id, event, status, conclusion, created_at, display_title }));
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
    async readCalendar(file, ref) {
      if (!['krx-market-holidays.json','us-market-calendar.json'].includes(file)) throw new Error('Invalid calendar path');
      const response=await fetchImpl(`${API}/repos/${repository}/contents/data/${file}?ref=${encodeURIComponent(ref)}`,{headers,signal:AbortSignal.timeout(20000)});
      if(response.status!==200) throw new Error(`calendar ${file}: HTTP ${response.status}`);
      const body=await response.json();
      if(body.encoding!=='base64' || typeof body.content!=='string') throw new Error(`Invalid calendar response: ${file}`);
      return JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
    },
    async dispatch(workflow, ref, inputs = null) {
      const response = await fetchImpl(`${API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(inputs ? { ref, inputs } : { ref }), signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 204) throw new Error(`dispatch ${workflow}: HTTP ${response.status}`);
    },
  };
}

// stayAlive: instead of exiting when today has nothing left (or the market is
// closed), keep sleeping until the next KST day and relay before the runner
// budget, so one started keeper keeps the schedule alive without depending on
// GitHub cron starts (which can be delayed or dropped). Cron starts remain as
// a backup that only queues behind the running keeper.
export const STAY_ALIVE_WAKE = "00:05";
export function nextKstDayWake(current) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
  const next = new Date(`${today}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return kstInstant(next.toISOString().slice(0, 10), STAY_ALIVE_WAKE);
}

export async function runKeeper({ client, calendar, ref = "main", now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, startedAt = now(), stages = STAGES, maxLoops = MAX_LOOPS, stayAlive = false, budgetMinutes = KEEPER_BUDGET_MINUTES, usCalendar = null }) {
  const dispatched = new Map(); // stage id -> synthetic queued runs, covers API listing lag
  const events = [];
  const warnings = new Set();
  // Relay is the sole automatic restart mechanism; retry transient API errors
  // within the runner's remaining time instead of abandoning the chain at once.
  const relay = async () => {
    let last;
    for (let attempt=1; attempt<=8; attempt++) {
      try { await client.dispatch(KEEPER_WORKFLOW,ref); return; }
      catch (error) { last=error; log(`::warning::keeper relay ${attempt}/8 failed: ${error.message}`); if(attempt<8) await sleep(30000); }
    }
    throw last;
  };
  // Returns null to continue the loop after sleeping, or a final result (relay).
  const hold = async (current, action) => {
    const budgetEnd = startedAt.getTime() + budgetMinutes * 60_000;
    if (current.getTime() >= budgetEnd) {
      log(`대기 중 runner 시간 한도 도달 · 다음 스케줄러로 이어받기 요청 · ${KEEPER_WORKFLOW}`);
      await relay();
      events.push({ at: current.toISOString(), type: "relay", reason: "stay alive" });
      return { result: "relay", events, warnings: [...warnings] };
    }
    const wake = Math.min(nextKstDayWake(current).getTime(), budgetEnd);
    const ms = Math.max(1_000, Math.min(MAX_SLEEP_MS, wake - current.getTime()));
    log(`오늘 남은 단계 없음(${action.reason || action.type}) · 종료하지 않고 대기 ${Math.round(ms / 1000)}초 · 다음 날 확인 ${nextKstDayWake(current).toISOString()} · 이어받기 기한 ${new Date(budgetEnd).toISOString()}`);
    events.push({ at: current.toISOString(), type: "hold", reason: action.reason || action.type });
    await sleep(ms);
    return null;
  };
  let refreshedAt = 0;
  let catchUp = null; // { date, dates }: missing 1530.json check, once per KST day
  for (let loop = 0; loop < maxLoops; loop += 1) {
    try {
    const current = now();
    if (usCalendar && typeof client.readCalendar === 'function' && current.getTime()-refreshedAt>=5*60000) {
      refreshedAt=current.getTime();
      for (const [file,market] of [['krx-market-holidays.json','KOSPI'],['us-market-calendar.json','NASDAQ']]) {
        try {
          const value=await client.readCalendar(file,ref);
          if(value?.market!==market || !value?.coverage?.start || !value?.coverage?.end || !Array.isArray(value.holidays)) throw new Error('invalid calendar contract');
          if(market==='KOSPI') calendar=value; else if(Array.isArray(value.early_closes)) usCalendar=value; else throw new Error('invalid US calendar');
        } catch(error) { log(`::warning::calendar refresh failed (${file}): ${error.message}`); }
      }
    }
    if (usCalendar && current.getTime() >= startedAt.getTime()+budgetMinutes*60000) {
      await relay(); events.push({at:current.toISOString(),type:'relay'});
      return {result:'relay',events,warnings:[...warnings]};
    }
    const runsByStage = {};
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
    const plan0 = planKeeper({ now: current, calendar, runsByStage: {}, keeperStartedAt: startedAt, budgetMinutes, stages });
    if (["exit", "error"].includes(plan0.action.type) && plan0.stages.length === 0 && !usCalendar) {
      log(JSON.stringify({ at: current.toISOString(), action: plan0.action }));
      if (stayAlive && plan0.action.type === "exit") { const held = await hold(current, plan0.action); if (held) return held; continue; }
      events.push({ at: current.toISOString(), ...plan0.action });
      return { result: plan0.action.type, events };
    }
    const since = kstDayStartIso(date);
    for (const stage of (plan0.stages.length ? stages : [])) {
      const listed = await client.listRuns(stage.workflow, since);
      const synthetic = (dispatched.get(stage.id) || []).filter((s) => !listed.some((r) => Date.parse(r.created_at) >= Date.parse(s.created_at) - 60_000));
      runsByStage[stage.id] = [...listed, ...synthetic];
    }
    let plan = planKeeper({ now: current, calendar, runsByStage, keeperStartedAt: startedAt, budgetMinutes, stages, catchUp: catchUp?.date === date ? catchUp : undefined });
    if (usCalendar && plan.action.type === "error") {
      const warning=`KRX calendar unavailable; KRX stages paused while calendar updates continue: ${plan.action.reason}`;
      if (!warnings.has(warning)) { warnings.add(warning); log(`::warning::${warning}`); }
      plan={...plan,action:{type:'exit',reason:warning}};
    }
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
      plan = planKeeper({ now: current, calendar, runsByStage, keeperStartedAt: startedAt, budgetMinutes, stages, catchUp });
    }
    for (const warning of plan.warnings || []) if (!warnings.has(warning)) { warnings.add(warning); log(`::warning::${warning}`); }
    log(`판단 #${loop + 1} · ${plan.action.type}${plan.action.stage ? ` ${plan.action.stage}` : ""}${plan.action.until ? ` (다음 확인 ${plan.action.until})` : ""}${plan.action.reason ? ` · ${plan.action.reason}` : ""} · 단계 상태 ${plan.stages.map((s) => `${s.id}:${s.state}`).join(", ")}`);
    let managed = null;
    if (usCalendar) {
      const extraRuns = {};
      for (const workflow of new Set(managedStages(date,calendar,usCalendar).map(s=>s.workflow))) {
        const listed=await client.listRuns(workflow,since);
        const pending=[...dispatched.values()].flat().filter(r=>r.workflow===workflow && r.display_title && !listed.some(x=>x.display_title===r.display_title && Date.parse(x.created_at)>=Date.parse(r.created_at)-60000));
        extraRuns[workflow]=[...listed,...pending];
      }
      managed=planManaged(date,current,calendar,usCalendar,extraRuns);
      const activeExtra=Object.entries(extraRuns).some(([workflow,rows])=>!['update-market-calendar.yml','update-us-market-calendar.yml','personal-investor-flow.yml'].includes(workflow) && rows.some(r=>r.status!=='completed' && current.getTime()-Date.parse(r.created_at)<45*60000));
      const activeCore=plan.stages.some(r=>r.active_since && current.getTime()-Date.parse(r.active_since)<45*60000);
      if (plan.action.type==='dispatch' && activeExtra) { await sleep(30000); continue; }
      if (managed.type==='dispatch' && plan.action.type!=='dispatch' && (activeCore || activeExtra)) { await sleep(30000); continue; }
      if (managed.type==='dispatch' && plan.action.type!=='dispatch' && !activeCore && !activeExtra) {
        const s=managed.stage;
        await client.dispatch(s.workflow,ref,s.inputs);
        dispatched.set(s.id,[...(dispatched.get(s.id)||[]),{workflow:s.workflow,display_title:`keeper:${s.id}`,status:'queued',conclusion:null,created_at:current.toISOString(),event:'workflow_dispatch',synthetic:true}]);
        events.push({at:current.toISOString(),type:'dispatch',stage:s.id});
        await sleep(5000); continue;
      }
    }
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
      await sleep(Math.max(1_000, Math.min(MAX_SLEEP_MS, Date.parse(action.until) - current.getTime(), managed?.until ? managed.until-current.getTime() : Infinity)));
      continue;
    }
    if (action.type === "relay") {
      log(`runner 시간 한도 전 다음 스케줄러로 이어받기 요청 · ${KEEPER_WORKFLOW}`);
      await relay();
      events.push({ at: current.toISOString(), type: "relay" });
      return { result: "relay", events, warnings: [...warnings] };
    }
    if (stayAlive && action.type === "exit" && managed?.until) { await sleep(Math.max(1000,Math.min(MAX_SLEEP_MS,managed.until-current.getTime(),startedAt.getTime()+budgetMinutes*60000-current.getTime()))); continue; }
    if (stayAlive && action.type === "exit") { const held = await hold(current, action); if (held) return held; continue; }
    events.push({ at: current.toISOString(), ...action });
    return { result: action.type, events, warnings: [...warnings] };
    } catch(error) {
      if (!usCalendar || !/HTTP (429|5\d\d)|fetch failed|timeout|ECONN|network/i.test(String(error.message))) throw error;
      log(`::warning::temporary scheduler API failure; retrying: ${error.message}`);
      await sleep(30000);
    }
  }
  throw new Error("keeper loop limit reached");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const started = new Date();
  (async () => {
    const client = githubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
    const LOG = createProgressLog({ label: "스케줄러" });
    LOG(`시작 · ref ${process.env.GITHUB_REF_NAME || "main"}`);
    const outcome = await runKeeper({ client, calendar: await loadMarketCalendar(), usCalendar: JSON.parse(await readFile(CALENDAR,"utf8")), ref: process.env.GITHUB_REF_NAME || "main", startedAt: started, stayAlive: process.env.KEEPER_STAY_ALIVE !== "0", log: (line) => (String(line).startsWith("::") ? console.log(line) : LOG(line)) });
    LOG(`종료 · ${outcome.result} · 실행 요청 ${outcome.events.filter((e) => e.type === "dispatch").length}건`);
    const minutes = Math.round((Date.now() - started.getTime()) / 60_000);
    const summary = [`### KOSPI scheduler keeper`, `- result: \`${outcome.result}\``, `- runner minutes: ${minutes}`, ...(outcome.warnings || []).map((w) => `- **warning:** ${w}`), ...outcome.events.map((e) => `- ${e.at}: ${e.type}${e.stage ? ` ${e.stage}` : ""}${e.reason ? ` (${e.reason})` : ""}`)].join("\n");
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (outcome.result === "error") process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
