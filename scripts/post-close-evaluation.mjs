import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNaverDailyHistory } from "../providers/naver-daily-cache.js";
import { buildEvaluationSummary, deriveExpectedReturn, deriveSessionReturn, deriveEvaluationError } from "../providers/evaluation-contract.js";
import { mergePostCloseEvaluation } from "../providers/post-close-overlay.js";
import { priorHistoryEstimate } from "../providers/forecast-basis.js";
import { createProgressLog } from "../providers/progress-log.js";

const valid = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// Sessions are newest first. No target-day prices enter the forecast calculation.
// Each row records the model inputs actually used (gap and session ratios,
// prior close and dates) so the retrospective values can be reproduced.
// history: the loaded daily cache (or chart history); its return_history,
// forecast_model and rank_forecast select the same model as the live stages.
export function buildPostCloseRows(sessions, actualRows, history = {}) {
  if (!Array.isArray(sessions) || sessions.length !== 3) throw new Error("Three prior sessions are required");
  return actualRows.map((actual) => {
    const full = priorHistoryEstimate(sessions, actual.symbol, { returnHistory: history?.return_history?.[actual.symbol] ?? null, forecastModel: history?.forecast_model ?? null, rankForecast: history?.rank_forecast ?? null });
    // A symbol the day's model cannot score has no retrospective estimate.
    const estimate = full && full.expected_close !== null ? full : null;
    const row = { symbol: actual.symbol, name: actual.name, expected_open: estimate?.expected_open ?? null, expected_close: estimate?.expected_close ?? null,
      actual_open: valid(actual.actual_open) ? actual.actual_open : null, actual_close: valid(actual.actual_close) ? actual.actual_close : null };
    return { ...row, expected_return: deriveExpectedReturn(row), session_return: deriveSessionReturn(row), error: deriveEvaluationError(row), missing_reason: estimate ? null : "insufficient_prior_history",
      ...(estimate ? { expected_open_basis: estimate.open_basis, expected_close_basis: estimate.close_basis } : {}) };
  });
}

export async function runPostCloseEvaluation({ runDate, runId, stageFile, outputDir = null, historyFetcher = loadNaverDailyHistory, log = createProgressLog({ label: `사후 평가 ${runDate}` }) }) {
  log(`시작 · run ${runId} · 정산 파일 ${stageFile}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid post-close identity");
  const snapshot = JSON.parse(await readFile(stageFile, "utf8"));
  if (snapshot.status !== "ready" || snapshot.meta?.run_date !== runDate || snapshot.meta?.run_id !== runId || snapshot.meta?.run_stage !== "close-settlement" || !Array.isArray(snapshot.rows) || !snapshot.rows.length) throw new Error("Post-close settlement is missing or does not belong to this run");
  const path = join(outputDir || join("data", "runs", runDate), `retrospective-${runId}.json`);
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    mergePostCloseEvaluation(snapshot, previous); // validate identity and observation matches
    const evaluated = previous.rows.filter((row) => deriveEvaluationError(row) !== null).length;
    if (!evaluated) throw new Error("Existing retrospective has no evaluated rows");
    log(`기존 결과 보존 · ${evaluated}/${previous.rows.length}종목 평가됨 · ${path}`);
    return { status: "ready", path, evaluated, total: previous.rows.length, preserved: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const history = await historyFetcher({ targetDate: runDate, maxMissingSessions: 0 });
  log(`직전 이력 ${history.ok ? `${history.sessions?.map((s) => s.date).join(", ")} · ${history.valid_symbols?.length ?? "-"}종목` : `없음 (${history.reason})`}`);
  if (!history.ok) throw new Error(`Prior history unavailable: ${history.reason}`);
  if (history.sessions.length !== 3 || history.sessions.some((s, i) => s.date >= runDate || (i > 0 && s.date >= history.sessions[i - 1].date))) throw new Error("Invalid prior history dates");
  const rows = buildPostCloseRows(history.sessions, snapshot.rows, history);
  const models = [...new Set(rows.map((row) => row.expected_close_basis?.model).filter(Boolean))];
  const evaluation = buildEvaluationSummary(rows, { testOnly: true, dataset: "historical_test", asOfDate: runDate, forecastStage: "0820", actualStage: "1530", inputDates: history.sessions.map((s) => s.date).reverse(), note: "Retrospective calculation using prior daily history, evaluated against observed same-day prices; not a forecast recorded before the open." });
  if (evaluation.evaluated_sample_count === 0) throw new Error("No rows have complete prior history and observed prices");
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: runDate, run_id: runId, created_at: new Date().toISOString(), history_dates: history.sessions.map((s) => s.date), history_urls: history.sessions.map((s) => s.url), history_retrieved_at: history.retrieved_at, robots_url: history.robots_url, robots_checked_at: history.robots_checked_at, model: models.length === 1 ? models[0] : models.join("+") || "none", notice: `Calculated after close; prior source publication and revisions are unverified. Not a forecast made before the open or a measure of live forecast performance.${history.source === "naver-daily" ? ` Naver daily venue and adjustment unconfirmed and may differ from regular-market quotes; ${history.comparison_conflicts} comparison conflicts recorded.` : ""}`, evaluation, rows };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  log(`완료 · ${evaluation.evaluated_sample_count}/${rows.length}종목 평가 · 모델 ${record.model} · MAE ${evaluation.metrics.mean_absolute_error ?? "-"} · rank IC ${evaluation.ranking_metrics?.rank_ic ?? "-"} · ${path}`);
  return { status: "ready", path, evaluated: evaluation.evaluated_sample_count, total: rows.length };
}
