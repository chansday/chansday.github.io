import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { classifyMarketDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";

// Pure scheduling rules for the keeper workflow. No network or clock access:
// callers pass `now`, the calendar and today's runs per stage workflow.
//
// Late policy:
// - Pre-open stages (history, update-results, analysis, forecast) are useful
//   only before the open. They are dispatched up to `lastStart`; after that
//   they are "missed" and never dispatched late.
// - Settlement stages record observed prices, so a late dispatch is still
//   correct on the same KST date; they are dispatched until `lastStart` (23:00).
// - close-catch-up settles a past trading day whose 15:30 close-settlement left
//   no data/runs/D/1530.json, from the Naver daily candle. It runs in the idle
//   gap after open-settlement (09:30, last start 14:30, i.e. well before the
//   15:30 close) and only once every earlier stage of today has finished, so it
//   never delays a pre-open stage or the open/close settlement of today. It is
//   dispatched only when the keeper confirmed missing dates (catchUp.dates).
export const STAGES = Object.freeze([
  { id: "naver-daily-history", workflow: "naver-daily-history.yml", at: "06:10", lastStart: "07:45", kind: "pre-open", retry: { at: "07:10", maxAttempts: 2 } },
  { id: "update-results", workflow: "update-results.yml", at: "07:00", lastStart: "08:50", kind: "pre-open" },
  { id: "analysis", workflow: "analysis.yml", at: "08:00", lastStart: "08:50", kind: "pre-open" },
  { id: "forecast", workflow: "forecast.yml", at: "08:20", lastStart: "08:50", kind: "pre-open" },
  { id: "open-settlement", workflow: "open-settlement.yml", at: "09:00", lastStart: "23:00", kind: "settlement" },
  { id: "close-catch-up", workflow: "close-catch-up.yml", at: "09:30", lastStart: "14:30", kind: "catch-up", after: Object.freeze(["naver-daily-history", "update-results", "analysis", "forecast", "open-settlement"]) },
  { id: "close-settlement", workflow: "close-settlement.yml", at: "15:30", lastStart: "23:00", kind: "settlement" },
].map(Object.freeze));

export const CATCH_UP_STAGE_ID = "close-catch-up";
export const CATCH_UP_TRADING_DAYS = 5;
const TERMINAL_STATES = new Set(["done", "failed", "missed", "gave_up"]);

// The CATCH_UP_TRADING_DAYS trading days before `today`, oldest first.
export function catchUpCandidateDates(today, calendar, count = CATCH_UP_TRADING_DAYS) {
  const result = [];
  for (let days = 1; days <= 45 && result.length < count; days += 1) {
    const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days);
    const value = date.toISOString().slice(0, 10), state = classifyMarketDate(value, calendar);
    if (state.status === "error") break;
    if (state.status === "run") result.push(value);
  }
  return result.reverse();
}

// filesByDate[date] lists the file names in data/runs/<date>/ (empty when the
// directory is missing). A date needs catch-up when 1530.json is absent and a
// same-date forecast/open file exists (otherwise there is nothing to settle).
export function missingCloseDates(candidates, filesByDate) {
  return candidates.filter((date) => {
    const files = Array.isArray(filesByDate?.[date]) ? filesByDate[date] : [];
    return !files.includes("1530.json") && (files.includes("0900.json") || files.includes("0820.json"));
  });
}

// The catch-up stage is due only after every `after` stage of today is
// terminal and the keeper checked the repository for missing settlements.
function refineCatchUp(state, stage, states, now, catchUp) {
  if (stage.kind !== "catch-up" || state.state !== "due") return state;
  const pending = (stage.after || []).filter((id) => { const s = states.find((x) => x.id === id); return s && !TERMINAL_STATES.has(s.state); });
  if (pending.length) return { ...state, state: "waiting", due_at: new Date(now.getTime() + ACTIVE_POLL_MS).toISOString(), reason: `waits for ${pending.join(", ")}` };
  if (!catchUp || !Array.isArray(catchUp.dates)) return { ...state, state: "unchecked", reason: "missing close-settlement files not checked" };
  if (!catchUp.dates.length) return { ...state, state: "not_needed", reason: "no recent trading day lacks 1530.json" };
  return { ...state, inputs: { run_date: catchUp.dates.join(",") }, reason: `missing 1530.json for ${catchUp.dates.join(", ")}` };
}

export const KEEPER_WORKFLOW = "scheduler-keeper.yml";
export const KEEPER_BUDGET_MINUTES = 325; // job timeout is 340; relay leaves margin
export const MAX_CANCELLED_ATTEMPTS = 3;
export const WATCH_INTERVAL_MS = 5 * 60_000;
export const DISPATCH_GRACE_MS = 3_000; // dispatch just after the boundary, never before
// Stage workflows share one concurrency group (one running + one pending; a new
// pending run cancels the older pending one). The keeper therefore starts the
// next stage only after every earlier stage run of today has completed. A run
// still active after STALE_ACTIVE_MS no longer blocks (stuck runner safety).
export const ACTIVE_POLL_MS = 30_000;
export const STALE_ACTIVE_MS = 45 * 60_000;
export const CALENDAR_WARNING_DAYS = 30;

export function kstInstant(date, hhmm) {
  const value = new Date(`${date}T${hhmm}:00+09:00`);
  if (Number.isNaN(value.getTime())) throw new Error(`Invalid KST instant ${date} ${hhmm}`);
  return value;
}

// Midnight KST of `date` as a UTC ISO string, for the Actions API `created` filter.
export function kstDayStartIso(date) { return kstInstant(date, "00:00").toISOString(); }

// Only runs created on the same KST date and started by dispatch/schedule count.
export function runsForDay(runs, date) {
  return (Array.isArray(runs) ? runs : []).filter((run) => run && typeof run.created_at === "string"
    && kstDate(new Date(run.created_at)) === date
    && (run.event === undefined || run.event === "workflow_dispatch" || run.event === "schedule"));
}

export function stageState(stage, runs, now, date) {
  const at = kstInstant(date, stage.at), last = kstInstant(date, stage.lastStart);
  const today = runsForDay(runs, date);
  const active = today.filter((r) => r.status !== "completed");
  const succeeded = today.filter((r) => r.status === "completed" && r.conclusion === "success");
  const cancelled = today.filter((r) => r.status === "completed" && ["cancelled", "skipped"].includes(r.conclusion));
  const failed = today.filter((r) => r.status === "completed" && !["success", "cancelled", "skipped"].includes(r.conclusion));
  const attempts = today.length;
  const activeSince = active.length ? new Date(Math.min(...active.map((r) => Date.parse(r.created_at)))).toISOString() : null;
  const base = { id: stage.id, workflow: stage.workflow, kind: stage.kind, at: at.toISOString(), last_start: last.toISOString(), attempts, ...(activeSince ? { active_since: activeSince } : {}) };
  if (succeeded.length) return { ...base, state: "done" };
  if (active.length) {
    // A retryable stage is watched so a failure can be retried inside its window.
    const watch = stage.retry && now < last && attempts < stage.retry.maxAttempts;
    return { ...base, state: watch ? "watch" : "running" };
  }
  if (failed.length) {
    if (stage.retry && attempts < stage.retry.maxAttempts) {
      const retryAt = kstInstant(date, stage.retry.at);
      if (now > last) return { ...base, state: "missed", reason: "retry window closed" };
      return { ...base, state: now >= retryAt ? "due" : "waiting", due_at: retryAt.toISOString(), reason: "retry after failure" };
    }
    return { ...base, state: "failed", reason: "completed without success; not retried" };
  }
  if (cancelled.length >= MAX_CANCELLED_ATTEMPTS) return { ...base, state: "gave_up", reason: `${cancelled.length} cancelled runs` };
  if (now > last) return { ...base, state: "missed", reason: stage.kind === "pre-open" ? "pre-open stage is not run after its last start" : "same-day window closed" };
  if (now.getTime() >= at.getTime() + DISPATCH_GRACE_MS) return { ...base, state: "due", due_at: at.toISOString(), ...(cancelled.length ? { reason: "previous run cancelled" } : {}) };
  return { ...base, state: "waiting", due_at: new Date(at.getTime() + DISPATCH_GRACE_MS).toISOString() };
}

// Returns the next keeper action:
//   exit     - market closed, or nothing left to dispatch/watch today
//   dispatch - start `stage.workflow` now
//   sleep    - wait until `until`, then plan again
//   relay    - dispatch the keeper itself and exit (runner time budget reached)
export function planKeeper({ now, calendar, runsByStage = {}, keeperStartedAt = now, budgetMinutes = KEEPER_BUDGET_MINUTES, stages = STAGES, catchUp = undefined }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
  const date = kstDate(now);
  const market = classifyMarketDate(date, calendar);
  if (market.status === "error") return { date, market, stages: [], action: { type: "error", reason: market.message } };
  if (market.status !== "run") return { date, market, stages: [], action: { type: "exit", reason: `market closed: ${market.reason}` } };
  const base = stages.map((stage) => stageState(stage, runsByStage[stage.id] || [], now, date));
  const states = base.map((state, i) => refineCatchUp(state, stages[i], base, now, catchUp));
  const deadline = new Date(keeperStartedAt.getTime() + budgetMinutes * 60_000);
  const warnings = calendarWarnings(date, calendar);
  const result = (action) => ({ date, market, stages: states, deadline: deadline.toISOString(), warnings, action });
  const due = states.find((s) => s.state === "due");
  if (due) {
    const blocking = states.filter((s) => s.active_since && now.getTime() - Date.parse(s.active_since) < STALE_ACTIVE_MS);
    if (!blocking.length) return result({ type: "dispatch", stage: due.id, workflow: due.workflow, ...(due.inputs ? { inputs: due.inputs } : {}), reason: due.reason || "scheduled time reached" });
    if (now >= deadline) return result({ type: "relay", reason: `runner budget of ${budgetMinutes} min reached while ${due.id} waits` });
    const until = new Date(Math.min(now.getTime() + ACTIVE_POLL_MS, deadline.getTime()));
    return result({ type: "sleep", until: until.toISOString(), reason: `${due.id} waits for ${blocking.map((s) => s.id).join(", ")} to complete (shared pipeline queue)` });
  }
  const waiting = states.filter((s) => s.state === "waiting").map((s) => new Date(s.due_at));
  const watching = states.some((s) => s.state === "watch");
  if (!waiting.length && !watching) return result({ type: "exit", reason: "all stages for today are dispatched, done, failed or missed" });
  const next = new Date(Math.min(...waiting.map((d) => d.getTime()), watching ? now.getTime() + WATCH_INTERVAL_MS : Infinity));
  if (now >= deadline) return result({ type: "relay", reason: `runner budget of ${budgetMinutes} min reached; next action at ${next.toISOString()}` });
  const until = next < deadline ? next : deadline;
  return result({ type: "sleep", until: until.toISOString(), reason: next < deadline ? "waiting for next stage" : "sleeping until relay point" });
}

// Warn ahead of the KRX calendar coverage end; after it the keeper fails daily.
export function calendarWarnings(date, calendar, days = CALENDAR_WARNING_DAYS) {
  const end = calendar?.coverage?.end;
  if (typeof end !== "string") return [];
  const left = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return left >= 0 && left <= days ? [`KRX calendar coverage ends ${end} (${left} days left); run "KOSPI annual market calendar update" or the keeper stops with an error after that date.`] : [];
}

// Dry run: node scripts/scheduler-plan.mjs --now 2026-10-29T05:30:00+09:00 [--runs file.json]
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const now = value("--now") ? new Date(value("--now")) : new Date();
  const started = value("--started") ? new Date(value("--started")) : now;
  (async () => {
    const runsByStage = value("--runs") ? JSON.parse(await readFile(value("--runs"), "utf8")) : {};
    const plan = planKeeper({ now, calendar: await loadMarketCalendar(), runsByStage, keeperStartedAt: started });
    console.log(JSON.stringify({ now: now.toISOString(), date: plan.date, market: plan.market.reason, action: plan.action, stages: plan.stages.map((s) => `${s.id}:${s.state}${s.due_at ? `@${s.due_at}` : ""}`) }, null, 2));
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
