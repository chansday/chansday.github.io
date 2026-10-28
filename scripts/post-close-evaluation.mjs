import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchForecastHistory } from "../providers/public-csv-provider.js";
import { buildEvaluationSummary, deriveExpectedReturn, deriveSessionReturn, deriveEvaluationError } from "../providers/evaluation-contract.js";
import { mergePostCloseEvaluation } from "../providers/post-close-overlay.js";

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n) => Math.max(-0.05, Math.min(0.05, n));
const valid = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// Sessions are newest first. No target-day prices enter the forecast calculation.
export function buildPostCloseRows(sessions, actualRows) {
  if (!Array.isArray(sessions) || sessions.length !== 3) throw new Error("Three prior sessions are required");
  const maps = sessions.map((session) => new Map(session.rows.map((row) => [row.symbol, row])));
  return actualRows.map((actual) => {
    const history = maps.map((map) => map.get(actual.symbol));
    const complete = history.every((row) => row && valid(row.open) && valid(row.close) && valid(row.volume));
    let expectedOpen = null, expectedClose = null;
    if (complete) {
      const gap = clamp(((history[0].open / history[1].close - 1) + (history[1].open / history[2].close - 1)) / 2);
      const session = clamp(history.reduce((sum, row) => sum + row.close / row.open - 1, 0) / 3);
      expectedOpen = round(history[0].close * (1 + gap));
      expectedClose = round(expectedOpen * (1 + session));
    }
    const row = { symbol: actual.symbol, name: actual.name, expected_open: expectedOpen, expected_close: expectedClose,
      actual_open: valid(actual.actual_open) ? actual.actual_open : null, actual_close: valid(actual.actual_close) ? actual.actual_close : null };
    return { ...row, expected_return: deriveExpectedReturn(row), session_return: deriveSessionReturn(row), error: deriveEvaluationError(row), missing_reason: complete ? null : "insufficient_prior_history" };
  });
}

export async function runPostCloseEvaluation({ runDate, runId, stageFile, historyFetcher = fetchForecastHistory }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid post-close identity");
  const snapshot = JSON.parse(await readFile(stageFile, "utf8"));
  if (snapshot.status !== "ready" || snapshot.meta?.run_date !== runDate || snapshot.meta?.run_id !== runId || snapshot.meta?.run_stage !== "close-settlement" || !Array.isArray(snapshot.rows) || !snapshot.rows.length) throw new Error("Post-close settlement is missing or does not belong to this run");
  const path = join("data", "runs", runDate, `retrospective-${runId}.json`);
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    mergePostCloseEvaluation(snapshot, previous); // validate identity and observation matches
    const evaluated = previous.rows.filter((row) => deriveEvaluationError(row) !== null).length;
    if (!evaluated) throw new Error("Existing retrospective has no evaluated rows");
    return { status: "ready", path, evaluated, total: previous.rows.length, preserved: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const history = await historyFetcher({ targetDate: runDate, maxMissingSessions: 0 });
  if (!history.ok) throw new Error(`Prior history unavailable: ${history.reason}`);
  if (history.sessions.length !== 3 || history.sessions.some((s, i) => s.date >= runDate || (i > 0 && s.date >= history.sessions[i - 1].date))) throw new Error("Invalid prior history dates");
  const rows = buildPostCloseRows(history.sessions, snapshot.rows);
  const evaluation = buildEvaluationSummary(rows, { testOnly: true, dataset: "historical_test", asOfDate: runDate, forecastStage: "0820", actualStage: "1530", inputDates: history.sessions.map((s) => s.date).reverse(), note: "Retrospective calculation using prior daily history, evaluated against observed same-day prices; not a forecast recorded before the open." });
  if (evaluation.evaluated_sample_count === 0) throw new Error("No rows have complete prior history and observed prices");
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: runDate, run_id: runId, created_at: new Date().toISOString(), history_dates: history.sessions.map((s) => s.date), history_urls: history.sessions.map((s) => s.url), history_retrieved_at: history.retrieved_at, robots_url: history.robots_url, robots_checked_at: history.robots_checked_at, model: "prior_3_sessions_gap_and_session_mean_capped_5pct", notice: "Calculated after close; prior source publication and revisions are unverified. Not a forecast made before the open or a measure of live forecast performance.", evaluation, rows };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { status: "ready", path, evaluated: evaluation.evaluated_sample_count, total: rows.length };
}
