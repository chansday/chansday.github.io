import { isSnapshot, noDataSnapshot } from "./providers/provider-adapter.js";
import { createDemoProvider } from "./providers/demo-provider.js";
import { classifyDate, isIsoDate, normalizeDateIndex, normalizeMode, snapshotPath, statusLabel } from "./providers/date-navigation.js";
import { deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn, rankingExpectedReturn } from "./providers/evaluation-contract.js";
import { sortRankingRows } from "./providers/ranking-sort.js";
import { computeEvaluationScores, evaluationScoreSummary, evaluationScoreTooltip, formatEvaluationScore } from "./providers/evaluation-score.js";
import { mergePostCloseEvaluation } from "./providers/post-close-overlay.js";
import { NO_TRADE_LABEL, buildSelectedDetail } from "./providers/selected-detail.js";

const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const integerFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

const stateLabels = {
  ready: "정상", valid: "정상 확인", partial: "부분 결과", degraded: "품질 저하", no_data: "데이터 없음",
  pending: "대기", blocked: "차단됨", not_configured: "미설정", demo: "테스트",
};
const rowStateLabels = { valid: "정상 확인", pending: "대기", degraded: "품질 저하", blocked: "차단됨", no_data: "데이터 없음", demo: "테스트" };
const qualityLabels = {
  historical_baseline_public_daily: "과거 기준 데이터",
  historical_baseline_public_daily_pending_settlement: "과거 기준 데이터 · 정산 대기",
  historical_baseline_public_daily_open_settled: "과거 기준 데이터 · 시가 정산",
  historical_baseline_public_daily_settled: "과거 기준 데이터 · 정산 완료",
  public_baseline_no_preopen_quote: "장전 호가 없는 공개 기준선",
  fixture_synthetic: "합성 시험 데이터",
  replay_baseline: "합성 재생 기준선",
  backfill_test: "시험용 보충 데이터",
  retrospective_baseline_no_preopen_quote: "장전 호가 없는 사후 기준선",
  public_daily_momentum_volatility_v1: "공개 일봉 기준선",
  confirmed: "이용 조건 확인됨",
  evaluated: "검증 완료",
  historical_test: "시험용 과거 검증",
  test_only: "시험용 데이터",
  historical_fallback: "과거 검증 데이터",
  naver_preopen_quote: "네이버 장전 공개 호가",
  naver_live_quote: "네이버 실시간 공개 시세",
  naver_intraday_quote_baseline: "네이버 장중 시세 기준값",
  unconfirmed: "이용 조건 확인 필요",
};
const stateMessages = {
  ready: "정상 데이터 스냅샷을 표시하고 있습니다.",
  no_data: "실제 가격·예측값·신뢰도를 임의로 생성하지 않고 데이터 없음 상태로 표시합니다.",
  degraded: "일부 데이터가 지연되거나 품질 기준을 통과하지 못했습니다.",
  partial: "부분 결과입니다. 정상 랭킹으로 해석하지 않습니다.",
  pending: "아직 처리되지 않은 단계입니다.",
  blocked: "데이터 공급자 또는 표시 조건이 준비되지 않았습니다.",
  demo: "화면 확인용 테스트 모드입니다. 금융 실측값이 아닙니다.",
  fixture: "합성 데이터 모드입니다. 실제 금융 데이터가 아닙니다.",
  replay: "합성 재생 모드입니다. 실제 과거 예측이 아닙니다.",
  backfill_test: "시험용 보충 데이터입니다. 실제 금융 데이터나 과거 예측 성과가 아닙니다.",
  historical: "과거 공개 일봉 데이터입니다. 장전 호가가 없어 실시간 운영 예측으로 볼 수 없습니다.",
};
const historicalFallbackLabel = "과거 시험 데이터 · 운영용 아님";
const historicalFallbackLegacyLabel = "TEST ONLY · HISTORICAL BASELINE · NOT LIVE";
const historicalTestLegacyLabel = "HISTORICAL-TEST / TEST ONLY";
const historicalBaselineLegacyDescription = "공개 일봉 모멘텀·변동성 baseline";
const historicalFallbackContract = "isLiveNoDataSnapshot(data) / historical_fallback_source";
const historicalFallbackContractFile = "historical-test-fallback.js";
const historicalTestDataRoot = "data/runs/historical-test";
const HISTORICAL_TEST_STAGE = "1530";
const HISTORICAL_TEST_REQUIRED_FIELDS = Object.freeze(["rank", "expected_open", "actual_open", "actual_close"]);
const elementIds = [
  "mode-badge", "data-purpose", "global-status", "status-message", "as-of-date", "published-at", "model-version", "model-trained-at", "row-count", "provider-label", "top-clock", "refresh-button",
  "quality-ribbon", "quality-ribbon-label", "quality-ribbon-text", "truth-label", "truth-note-text", "evaluation-status", "evaluation-headline", "evaluation-description", "summary-status", "summary-status-detail", "summary-samples", "summary-samples-detail", "summary-range", "summary-range-detail", "summary-rmse", "summary-rmse-detail", "summary-expected", "summary-expected-detail", "summary-actual", "summary-actual-detail", "summary-error", "summary-error-detail", "summary-scope", "summary-scope-detail",
  "kpi-market", "kpi-market-note", "kpi-market-bar", "kpi-universe", "kpi-valid", "kpi-accuracy", "kpi-accuracy-note", "kpi-model", "kpi-model-note", "kpi-model-time", "kpi-model-quality", "table-state", "table-count", "ranking-table", "ranking-body", "ranking-cards", "empty-state", "empty-state-note", "search-input", "status-filter", "sort-select", "ranking-date-picker", "ranking-date-button", "ranking-date-label", "ranking-date-popover", "calendar-month", "calendar-grid", "calendar-status", "calendar-prev", "calendar-next",
  "selected-empty", "selected-content", "selected-detail-hint", "selected-symbol", "selected-name", "selected-status", "selected-expected-open", "selected-expected-close", "selected-expected-return", "selected-actual-open", "selected-actual-close", "selected-actual-return", "selected-error", "selected-confidence", "selected-quality", "selected-reasons", "selected-evidence",
  "source-name", "source-url", "source-license", "evaluation-scope", "data-timestamp", "snapshot-date", "source-collection", "source-range", "model-name", "baseline-input", "model-note", "limit-title", "quality-summary", "quality-source", "data-notice", "notice-title", "notice-detail", "footer-status",
].reduce((result, id) => ({ ...result, [id]: document.getElementById(id) }), {});

let snapshot = null;
let selectedSymbol = null;
let dateIndex = normalizeDateIndex(null);
let marketCalendar = null;
let currentDate = null;
let currentDataMode = "provider";
let calendarMonthCursor = null;
let dateRequestToken = 0;
let postCloseToken = 0;

async function renderPostClose(data) {
  const token = ++postCloseToken;
  const date = data?.meta?.run_date, runId = data?.meta?.run_id;
  if (!isIsoDate(date) || !/^[A-Za-z0-9._-]+$/.test(runId || "") || data?.meta?.run_stage !== "close-settlement" || isTestOnly(data)) return;
  try {
    const response = await fetch(`./data/runs/${date}/retrospective-${runId}.json`, { cache: "no-store" });
    if (response.status === 404) return;
    if (!response.ok) throw new Error("unavailable");
    const record = await response.json();
    if (token !== postCloseToken) return;
    renderHeader(attachRetrospectiveRecord(mergePostCloseEvaluation(data, record), record));
  } catch {
    if (token === postCloseToken) setText(elementIds["table-state"], "사후 평가 기록 읽기 오류");
  }
}

// Keep the retrospective record's own model, timing and per-row missing reasons
// for the detail panel; the merged rows already carry the matched estimates.
function attachRetrospectiveRecord(merged, record) {
  const missing = new Map((record?.rows || []).map((row) => [row?.symbol, row?.missing_reason || null]));
  return { ...merged, rows: merged.rows.map((row) => (missing.get(row.symbol) ? { ...row, retrospective_missing_reason: missing.get(row.symbol) } : row)), retrospective_record: { model: typeof record?.model === "string" ? record.model : null, created_at: record?.created_at || null } };
}
function setText(node, value) { if (node) node.textContent = value; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function valueOf(row, ...keys) { for (const key of keys) if (row?.[key] !== undefined) return row[key]; return null; }
function normalizeStatus(status) { return String(status || "no_data").toLowerCase().replaceAll("-", "_"); }
function normalizeDisplayZero(value, precision = 2) { if (!finite(value)) return value; return Math.abs(value) < (0.5 * (10 ** -precision)) ? 0 : value; }
function formatPrice(value) { return finite(value) ? `${numberFormatter.format(normalizeDisplayZero(value))}원` : "—"; }
function formatHigh(value) { return finite(value) ? formatPrice(value) : "-"; }
function formatPercent(value) { const displayValue = normalizeDisplayZero(value); return finite(displayValue) ? `${displayValue > 0 ? "+" : ""}${numberFormatter.format(displayValue)}%` : "—"; }
function roundExpectedHalfUp(value) { if (!finite(value)) return value; const magnitude = Math.floor(Math.abs(value) + 0.5); const rounded = value < 0 ? -magnitude : magnitude; return rounded === 0 ? 0 : rounded; }
function formatExpectedPrice(value) { if (!finite(value)) return "—"; const displayValue = normalizeDisplayZero(roundExpectedHalfUp(value), 0); return `${integerFormatter.format(displayValue)}원`; }
// 종목 평가: percentile 0–100 (3 decimals) of the unrounded expected return
// over every row of the displayed snapshot (providers/evaluation-score.js).
// Computed from the displayed rows so old snapshots without the stored fields
// and post-close overlays render the same way.
function attachEvaluationScores(rows) { const entries = computeEvaluationScores(rows.map((row) => row.expectedReturnRaw)); return rows.map((row, index) => ({ ...row, evaluationScore: entries[index]?.score ?? null, evaluationEntry: entries[index] })); }
function evaluationTitle(row) { return evaluationScoreTooltip(row.evaluationEntry, row.expectedReturnRaw); }
// Visible (not hover-only) rank and original value for touch layouts.
function evaluationNote(row) { return evaluationScoreSummary(row.evaluationEntry, row.expectedReturnRaw); }
function formatNumber(value) { return finite(value) ? integerFormatter.format(value) : "—"; }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date).replaceAll(". ", "."); }
function formatPlainDate(value) { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return match ? `${match[1]}.${match[2]}.${match[3]}` : "—"; }
function formatTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${timeFormatter.format(date).replaceAll(". ", ".")} KST`; }
function formatShortTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} KST`; }
function statusClass(status) { const key = normalizeStatus(status); if (["ready", "valid"].includes(key)) return "status-valid"; if (["degraded", "partial", "pending"].includes(key)) return `status-${key}`; if (key === "blocked") return "status-blocked"; return "status-muted"; }
function escapeText(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function isHistorical(data) { return data?.mode === "historical_test" || data?.provider?.id === "historical-test" || data?.meta?.historical_test === true; }
function isSynthetic(data) { return ["fixture", "replay", "backfill_test"].includes(data?.mode) || ["fixture", "replay_baseline", "backfill-test"].includes(data?.provider?.id); }
function isTestOnlySnapshot(data) { return Boolean(data?.meta?.test_only || data?.meta?.historical_test || data?.meta?.backfill || isHistorical(data) || isSynthetic(data)); }
const isTestOnly = isTestOnlySnapshot;
function qualityLabel(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return "품질 정보 없음";
  if (qualityLabels[key]) return qualityLabels[key];
  if (rowStateLabels[key]) return rowStateLabels[key];
  return "품질 상태 확인 필요";
}
function displayEnumLabel(value, fallback = "정보 없음") { const key = String(value || "").trim().toLowerCase(); return qualityLabels[key] || stateLabels[key] || rowStateLabels[key] || fallback; }
function providerDisplayName(data) {
  const providerId = String(data?.provider?.id || "").trim().toLowerCase();
  const labels = { "historical-test": "과거 기준 데이터", "public-csv": "공개 일별 데이터", "public-json": "공개 데이터", "naver-crawl": "네이버 공개 웹 크롤링", fixture: "합성 시험 데이터", replay_baseline: "합성 재생 기준선", "backfill-test": "시험용 보충 데이터", demo: "화면 확인용 데이터" };
  return labels[providerId] || "데이터 공급자 정보";
}
function sourceDisplayName(source, data) { const sourceName = String(source?.name || "").trim(); return sourceName && !/^[a-z0-9_-]+$/i.test(sourceName) ? sourceName : providerDisplayName(data); }
const MODEL_LABELS = { ridge_rank_11_features_60_sessions_v1: "순위 리지 모델", ridge_6_features_60_sessions_v1: "리지 모델", prior_20_sessions_trimmed_shrunk_mean_capped_1pct: "20일 축소 평균", prior_3_sessions_gap_and_session_mean_capped_5pct: "직전 3거래일 평균" };
// The expected-close model actually stored on most rows of this snapshot, with
// the training identity carried in its basis (version = model generation +
// last training date, e.g. v1.20261029).
function forecastModelInfo(data) {
  const counts = new Map();
  for (const row of Array.isArray(data?.rows) ? data.rows : []) {
    const basis = row?.expected_close_basis;
    if (!basis?.model) continue;
    const entry = counts.get(basis.model) || { n: 0, params: basis.inputs?.model_params || null };
    entry.n += 1; counts.set(basis.model, entry);
  }
  if (!counts.size) return null;
  const [id, { params }] = [...counts].sort((a, b) => b[1].n - a[1].n)[0];
  const generation = id.match(/_v(\d+)$/)?.[1];
  const last = typeof params?.train_last_date === "string" ? params.train_last_date : null;
  return { id, label: MODEL_LABELS[id] || id, version: generation && last ? `v${generation}.${last.replaceAll("-", "")}` : null, trainedAt: params?.trained_at || null,
    first: params?.train_first_date || null, last, days: params?.train_days ?? null, samples: params?.samples ?? null };
}

function modelDisplayName(data) {
  if (data?.meta?.retrospective_evaluation) return data.meta.retrospective_mixed ? "장전 기록과 사후 기준선 혼합" : "직전 3거래일 사후 기준선";
  if (isHistorical(data)) return "공개 일봉 기준선";
  return displayEnumLabel(data?.baseline?.model || data?.meta?.model || data?.model?.name, "예상 기준 정보 없음");
}

function testLabel(data) {
  if (data?.meta?.historical_fallback === true || data?.meta?.fallback_from_no_data) return historicalFallbackLabel;
  if (isHistorical(data)) return historicalFallbackLabel;
  if (data?.mode === "backfill_test") return "시험용 · 보충 데이터";
  if (data?.mode === "replay") return "시험용 · 합성 재생";
  if (data?.mode === "fixture") return "시험용 · 합성 데이터";
  return "시험용 데이터";
}

function normalizeRow(row, index) {
  const rawStatus = normalizeStatus(row?.status || row?.eligibility?.status || "no_data");
  const expectedOpen = valueOf(row, "expected_open");
  const expectedClose = valueOf(row, "expected_close");
  const actualOpen = valueOf(row, "actual_open");
  const actualClose = valueOf(row, "actual_close");
  return {
    rank: valueOf(row, "rank") ?? index + 1,
    symbol: valueOf(row, "symbol", "code", "instrument_id") || "—",
    name: valueOf(row, "name", "instrument_name") || "종목명 미정",
    expectedOpen, expectedOpenSource: row?.expected_open_source || (row?.retrospective_overlay ? { kind: "retrospective_history", history_dates: row.retrospective_overlay } : null), expectedClose, expectedReturn: deriveExpectedReturn({ expected_open: expectedOpen, expected_close: expectedClose }), expectedReturnRaw: rankingExpectedReturn({ expected_open: expectedOpen, expected_close: expectedClose }),
    actualOpen, actualClose, actualHigh: valueOf(row, "actual_high"), sessionReturn: deriveSessionReturn({ actual_open: actualOpen, actual_close: actualClose }), actualVolume: valueOf(row, "actual_volume"),
    error: deriveEvaluationError({ expected_open: expectedOpen, expected_close: expectedClose, actual_open: actualOpen, actual_close: actualClose }), confidence: valueOf(row, "confidence", "confidence_score"), quality: valueOf(row, "quality", "quality_status") || rawStatus,
    reasons: row?.eligibility?.reasons || row?.reasons || [], status: rawStatus === "ready" ? "valid" : rawStatus,
    raw: row || {},
  };
}
function emptySnapshot(message = "연결된 데이터 공급자가 없습니다.") { return noDataSnapshot({ provider: { id: null, status: "not_configured", label: "연결된 데이터 공급자 없음", source: null }, message }); }
function validateRequestedDate(date, label) {
  if (!isIsoDate(date)) throw new DateNavigationError("error", date, `${label} date is invalid: ${date}`);
  return date;
}
async function fetchSnapshot(path, errorLabel) { const response = await fetch(path, { cache: "no-store" }); if (!response.ok) throw new Error(`${errorLabel}: ${response.status}`); return response.json(); }
function historicalTestRunPath(date, stage = HISTORICAL_TEST_STAGE) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Historical-test date is invalid: ${date}`); if (!/^\d{4}$/.test(stage)) throw new Error(`Historical-test stage is invalid: ${stage}`); return `${historicalTestDataRoot}/${date}/${stage}.json`; }
function hasObservedHistoricalFields(row) { return Boolean(row && HISTORICAL_TEST_REQUIRED_FIELDS.every((field) => Object.hasOwn(row, field) && typeof row[field] === "number" && Number.isFinite(row[field])) && Number.isInteger(row.rank) && row.rank >= 1); }
function isHistoricalTestSnapshot(snapshotData) { return Boolean(isSnapshot(snapshotData) && snapshotData.mode === "historical_test" && snapshotData.provider?.id === "historical-test" && snapshotData.meta?.historical_test === true && snapshotData.meta?.test_only === true && snapshotData.rows.length > 0 && snapshotData.rows.every(hasObservedHistoricalFields)); }
function isLiveNoDataSnapshot(data) { return Boolean(data && data.mode === "provider" && data.status === "no_data" && data.meta?.historical_test !== true && data.meta?.test_only !== true && data.meta?.isDemo !== true); }
function markHistoricalTestFallback(snapshotData, liveSnapshot, sourcePath) { if (!isHistoricalTestSnapshot(snapshotData)) throw new Error("Historical-test fallback snapshot shape is invalid"); if (!isLiveNoDataSnapshot(liveSnapshot)) throw new Error("Historical-test fallback requires a live no_data snapshot"); return { ...snapshotData, meta: { ...snapshotData.meta, historical_fallback: true, historical_fallback_reason: "live_provider_no_data", historical_fallback_source: sourcePath, live_snapshot_status: liveSnapshot.status, live_provider_id: liveSnapshot.provider?.id ?? null } }; }

async function loadHistoricalTestSnapshot(date, liveSnapshot = null) {
  const sourcePath = historicalTestRunPath(date);
  void historicalTestDataRoot;
  const historical = await fetchSnapshot(`./${sourcePath}`, "Historical-test request failed");
  if (!isHistoricalTestSnapshot(historical)) throw new Error("Historical-test snapshot shape is invalid");
  return liveSnapshot ? markHistoricalTestFallback(historical, liveSnapshot, sourcePath) : historical;
}
async function loadHistoricalFallback(liveSnapshot) {
  if (!isLiveNoDataSnapshot(liveSnapshot)) return null;
  const fallbackDates = [...(dateIndex.availableDates["historical-test"] || [])].sort().reverse();
  for (const date of fallbackDates) {
    try { return await loadHistoricalTestSnapshot(date, liveSnapshot); } catch (error) { if (!String(error?.message || error).includes("404")) console.warn(error.message); }
  }
  return null;
}

class DateNavigationError extends Error {
  constructor(status, date, message) {
    super(message);
    this.name = "DateNavigationError";
    this.status = status;
    this.date = date;
  }
}

function requestedRoute() {
  const params = new URLSearchParams(window.location.search);
  const rawMode = params.get("mode")?.toLowerCase() || null;
  const rawDate = params.get("date");
  return { params, rawMode, date: rawDate && isIsoDate(rawDate) ? rawDate : rawDate };
}

function dateModeForRoute(rawMode = null) {
  if (rawMode === "historical_test") return "historical-test";
  if (rawMode === "backfill_test") return "backfill-test";
  if (rawMode === "demo") return "provider";
  return normalizeMode(rawMode || currentDataMode);
}

async function loadDateMetadata() {
  try {
    const [index, calendar] = await Promise.all([
      fetchSnapshot("./data/date-index.json", "Date index request failed"),
      fetchSnapshot("./data/krx-market-holidays.json", "Market calendar request failed"),
    ]);
    dateIndex = normalizeDateIndex(index);
    marketCalendar = calendar;
  } catch (error) {
    console.warn(error.message);
    dateIndex = normalizeDateIndex(null);
    marketCalendar = { holidays: [] };
  }
}

function dateState(date, mode = currentDataMode) { return classifyDate(date, mode, dateIndex, marketCalendar); }

async function loadSnapshotForMode(mode, date) {
  const normalizedMode = dateModeForRoute(mode);
  const path = snapshotPath(normalizedMode, date, normalizedMode === "provider" ? dateIndex?.latestStages?.provider?.[date] : null);
  const snapshotData = await fetchSnapshot(`./${path}`, `${normalizedMode} request failed`);
  if (!isSnapshot(snapshotData)) throw new Error(`${normalizedMode} snapshot shape is invalid`);
  if (normalizedMode === "historical-test" && !isHistoricalTestSnapshot(snapshotData)) throw new Error("Historical-test snapshot shape is invalid");
  if (normalizedMode === "fixture" && (snapshotData.mode !== "fixture" || snapshotData.meta?.isDemo !== true)) throw new Error("Fixture snapshot shape is invalid");
  if (normalizedMode === "replay" && (snapshotData.mode !== "replay" || snapshotData.meta?.isDemo !== true || snapshotData.meta?.replay_type !== "replay_baseline")) throw new Error("Replay snapshot shape is invalid");
  if (normalizedMode === "backfill-test" && (snapshotData.mode !== "backfill_test" || snapshotData.provider?.id !== "backfill-test" || snapshotData.meta?.isDemo !== true || snapshotData.meta?.backfill !== true)) throw new Error("Backfill snapshot shape is invalid");
  return snapshotData;
}

async function loadSnapshot() {
  const { rawMode, date } = requestedRoute();
  const requestedMode = rawMode;
  if (requestedMode === "demo") return createDemoProvider().getSnapshot();
  if (requestedMode === "fixture" || requestedMode === "replay" || requestedMode === "backfill-test" || requestedMode === "backfill_test" || requestedMode === "historical-test" || requestedMode === "historical_test" || date) {
    const selectedDate = validateRequestedDate(date || "2026-10-23", "Snapshot");
    const mode = dateModeForRoute(requestedMode);
    const state = dateState(selectedDate, mode);
    if (state.status === "holiday") throw new DateNavigationError("holiday", selectedDate, `${selectedDate} is a market holiday`);
    if (state.status === "not_collected") throw new DateNavigationError("not_collected", selectedDate, `${selectedDate} has no collected snapshot`);
    if (mode === "historical-test") return loadHistoricalTestSnapshot(selectedDate);
    return loadSnapshotForMode(mode, selectedDate);
  }
  const response = await fetch("./data/latest-snapshot.json", { cache: "no-store" });
  if (response.status === 404) return emptySnapshot();
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  const latest = await response.json();
  if (!isSnapshot(latest)) throw new Error("Snapshot shape is invalid");
  if (latest.status === "no_data") return (await loadHistoricalFallback(latest)) || latest;
  if (isTestOnly(latest)) return emptySnapshot();
  return latest;
}

function setStatusPill(node, status, text = stateLabels[normalizeStatus(status)] || normalizeStatus(status)) { if (!node) return; node.className = `status-pill ${statusClass(status)}`; node.textContent = text; }
function rowStatusLabel(row) { if (row.raw?.trading_status === "no_trade_observed") return NO_TRADE_LABEL; if (isHistorical(snapshot)) return row.status === "valid" ? "정상 확인" : (rowStateLabels[row.status] || row.status); return rowStateLabels[row.status] || qualityLabel(row.quality); }
function renderPipeline(data) {
  const pipeline = data?.pipeline || {};
  const steps = { previousResult: pipeline.previousResult, analysis: pipeline.analysis, forecast: pipeline.forecast, openSettlement: pipeline.openSettlement, closeSettlement: pipeline.closeSettlement };
  document.querySelectorAll(".pipeline-step[data-step]").forEach((step) => {
    const state = normalizeStatus(steps[step.dataset.step]?.status || (data?.status === "no_data" ? "no_data" : "pending"));
    step.dataset.state = state;
    const statusNode = step.querySelector("[data-step-status]");
    statusNode.className = `step-status ${statusClass(state)}`;
    statusNode.textContent = stateLabels[state] || state;
  });
}
function evaluationStats(rows) {
  const settled = rows.filter((row) => finite(row.error));
  const meanError = settled.length ? settled.reduce((sum, row) => sum + Math.abs(row.error), 0) / settled.length : null;
  return { settled, meanError };
}
function renderEvaluationSummary(data, rows, status) {
  const { settled, meanError } = evaluationStats(rows);
  const retrospective = data?.meta?.retrospective_evaluation === true;
  const historical = isHistorical(data);
  const fallback = data?.meta?.historical_fallback === true || data?.meta?.fallback_from_no_data;
  const evaluation = data?.evaluation || {};
  const metrics = evaluation.metrics || {};
  const meanAbsoluteError = finite(metrics.mean_absolute_error) ? metrics.mean_absolute_error : meanError;
  const rootMeanSquaredError = finite(metrics.root_mean_squared_error) ? metrics.root_mean_squared_error : null;
  const sampleCount = Number.isInteger(evaluation.sample_count) ? evaluation.sample_count : rows.length;
  const evaluatedSampleCount = Number.isInteger(evaluation.evaluated_sample_count) ? evaluation.evaluated_sample_count : settled.length;
  const missingSampleCount = Number.isInteger(evaluation.missing_sample_count) ? evaluation.missing_sample_count : Math.max(sampleCount - evaluatedSampleCount, 0);
  const evaluated = evaluation.status === "evaluated" || evaluatedSampleCount > 0;
  const label = retrospective ? (data?.meta?.retrospective_mixed ? "장전 기록 · 사후 계산 혼합" : "장 마감 후 사후 계산") : fallback ? historicalFallbackLabel : historical ? historicalFallbackLabel : isTestOnly(data) ? testLabel(data) : status === "ready" ? "운영 데이터" : "평가 대기";
  const range = evaluation.evaluation_range || {};
  const inputRange = range.input_range || {};
  const rangeHeadline = range.forecast_date ? formatPlainDate(range.forecast_date) : "—";
  const rangeDetail = inputRange.start && inputRange.end ? `입력 기준 ${formatPlainDate(inputRange.start)} ~ ${formatPlainDate(inputRange.end)}` : "검증 대상 기간 정보 없음";
  const expectedText = data?.meta?.retrospective_mixed ? "장전 기록 · 사후 기준 혼합" : historical || retrospective ? "사후 기준값" : rows.some((row) => finite(row.expectedReturn)) ? "예상값 기록" : "예상값 없음";
  const actualText = settled.length ? "실제 시가→종가 수익률" : "정산 대기";
  const scopeText = historical ? "KOSPI 전체 행" : rows.length ? "현재 표시 행" : "평가 대기";
  setText(elementIds["evaluation-status"], evaluated ? retrospective ? "사후 비교 완료" : "검증 완료" : "평가 대기");
  setText(elementIds["evaluation-headline"], evaluated ? `예상과 실제를 ${formatNumber(evaluatedSampleCount)}개 종목으로 비교했습니다.` : "아직 비교할 정산값이 없습니다.");
  setText(elementIds["evaluation-description"], historical || retrospective ? "일부 종목의 공개 일봉 사후 기준선은 장전 예측이나 실전 성과가 아닙니다. 종목별 출처를 확인하세요." : evaluated ? "평균 절대오차와 제곱근 평균오차를 함께 보며 결과의 크기를 가늠하세요." : "정산이 끝나면 예상값·실제값·오차를 같은 기준으로 보여드립니다.");
  setText(elementIds["summary-status"], evaluated && retrospective ? "사후 비교" : evaluation.status === "evaluated" ? "검증 완료" : evaluated ? "비교 가능" : "평가 대기");
  setText(elementIds["summary-status-detail"], retrospective ? (data?.meta?.retrospective_mixed ? "장전 기록 · 사후 계산 혼합" : "장 마감 후 사후 계산") : historical ? "검증용 과거 데이터" : "현재 스냅샷 기준");
  setText(elementIds["summary-samples"], formatNumber(evaluatedSampleCount));
  setText(elementIds["summary-samples-detail"], `전체 ${formatNumber(sampleCount)}개 · 제외 ${formatNumber(missingSampleCount)}개`);
  setText(elementIds["summary-range"], rangeHeadline);
  setText(elementIds["summary-range-detail"], rangeDetail);
  setText(elementIds["truth-label"], label);
  setText(elementIds["data-purpose"], retrospective ? (data?.meta?.retrospective_mixed ? "실측값 · 장전 기록 · 사후 예상" : "실측값 · 사후 예상") : historical ? "과거 공개 데이터" : isTestOnly(data) ? "시험용 데이터" : status === "ready" ? "운영 데이터" : "운영 데이터 대기");
  setText(elementIds["summary-expected"], expectedText);
  setText(elementIds["summary-expected-detail"], retrospective ? (data?.meta?.retrospective_mixed ? "종목별 장전 기록 또는 직전 3거래일 사후 계산" : "직전 3거래일 시가·종가 · 사후 계산") : historical ? `직전 ${data?.baseline?.lookback_sessions || 5}개 거래일 종가 · 장전 호가 없음` : "장전 기준값이 있는 종목");
  setText(elementIds["summary-actual"], actualText);
  setText(elementIds["summary-actual-detail"], settled.length ? `${formatNumber(evaluatedSampleCount)}개 종목의 실제 시가→종가` : "15:30 종가 정산 대기");
  setText(elementIds["summary-error"], finite(meanAbsoluteError) ? `${numberFormatter.format(meanAbsoluteError)}%` : "—");
  setText(elementIds["summary-error-detail"], finite(meanAbsoluteError) ? `오차 절대값의 평균 · 표본 ${formatNumber(evaluatedSampleCount)}개` : "오차 산출을 위한 정산 대기");
  setText(elementIds["summary-rmse"], finite(rootMeanSquaredError) ? `${numberFormatter.format(rootMeanSquaredError)}%` : "—");
  setText(elementIds["summary-rmse-detail"], finite(rootMeanSquaredError) ? "큰 오차를 더 민감하게 반영" : "평가 메타데이터 없음");
  setText(elementIds["summary-scope"], scopeText);
  setText(elementIds["summary-scope-detail"], rows.length ? `평가 표본 ${formatNumber(evaluatedSampleCount)} / 전체 ${formatNumber(sampleCount)}개` : "표시할 행이 없습니다.");
  setText(elementIds["truth-note-text"], retrospective ? "사후 계산된 예상값과 오차는 장전 예측이나 실전 성과가 아닙니다. 종목별 출처를 확인하세요." : historical ? "테스트 전용 과거 검증 데이터입니다. 당시 08:20에 게시된 예측이 아니며, 과거 예측 성과나 수익을 보장하지 않습니다." : isTestOnly(data) ? "검증 전용 데이터입니다. 합성·재생·보충 값은 금융 실측값이나 예측 성과가 아닙니다." : stateMessages[status] || stateMessages.no_data);
}
function renderRibbon(data, status) {
  const historicalFallback = data?.meta?.historical_fallback === true;
  const retrospective = data?.meta?.retrospective_evaluation === true;
  const show = Boolean(retrospective || historicalFallback || data?.meta?.fallback_from_no_data || (isTestOnly(data) && status !== "no_data"));
  elementIds["quality-ribbon"].hidden = !show;
  if (!show) return;
  setText(elementIds["quality-ribbon-label"], retrospective ? (data?.meta?.retrospective_mixed ? "장전 기록 · 사후 계산 혼합" : "장 마감 후 사후 계산") : historicalFallback ? historicalFallbackLabel : testLabel(data));
  setText(elementIds["quality-ribbon-text"], retrospective ? "장전 기록이 없는 종목은 직전 3거래일 이력으로 사후 계산했습니다. 종목별 출처를 확인하세요." : historicalFallback ? "운영 데이터가 없을 때만 선택하는 과거 공개 원본입니다. 숫자를 합성하지 않았습니다." : data?.meta?.fallback_from_no_data ? "운영 데이터가 없어 과거 공개 일봉을 표시합니다. 실전 데이터로 해석하지 마세요." : stateMessages[isHistorical(data) ? "historical" : data?.mode] || "시험용 데이터입니다. 금융 실측값이나 예측 성과로 해석하지 마세요.");
  if (historicalFallback) {
    setStatusPill(elementIds["mode-badge"], "pending", historicalFallbackLabel);
    setText(elementIds["global-status"], "과거 공개 데이터");
    setText(elementIds["status-message"], "운영 데이터가 없어 과거 공개 일봉을 표시합니다.");
  }
}
function renderKpis(data, rows, status) {
  if (!elementIds["kpi-market"]) return;
  const validRows = rows.filter((row) => row.status === "valid");
  const { settled, meanError } = evaluationStats(rows);
  const evaluation = data?.evaluation || {};
  const evaluationMae = finite(evaluation.metrics?.mean_absolute_error) ? evaluation.metrics.mean_absolute_error : meanError;
  const baseline = data?.baseline || {};
  const model = modelDisplayName(data);
  const quality = isHistorical(data) ? "과거 기준선" : displayEnumLabel(data?.meta?.source?.license_status || data?.provider?.status, "상태 정보 없음");
  setText(elementIds["kpi-market"], isHistorical(data) ? "검증용" : (stateLabels[status] || status));
  setText(elementIds["kpi-market-note"], isHistorical(data) ? "공개 일봉으로 사후 계산한 검증용 기준선" : stateMessages[status] || stateMessages.no_data);
  elementIds["kpi-market"].className = `kpi-value ${statusClass(isHistorical(data) ? "pending" : status)}`;
  elementIds["kpi-market-bar"].style.width = status === "ready" ? (isHistorical(data) ? "72%" : "100%") : "12%";
  setText(elementIds["kpi-universe"], formatNumber(rows.length));
  setText(elementIds["kpi-valid"], formatNumber(validRows.length));
  setText(elementIds["kpi-accuracy"], finite(evaluationMae) ? `${numberFormatter.format(evaluationMae)}%` : "—");
  setText(elementIds["kpi-accuracy-note"], settled.length ? `${data?.meta?.retrospective_evaluation ? "사후 계산 표본" : "정산 표본"} ${formatNumber(settled.length)}개` : "정산 표본 대기");
  setText(elementIds["kpi-model"], model);
  setText(elementIds["kpi-model-note"], data?.meta?.retrospective_evaluation || isHistorical(data) ? "사후 계산 · 장전 기록 아님" : displayEnumLabel(baseline.value_status, "예상 기준 정보 없음"));
  setText(elementIds["kpi-model-time"], formatShortTime(data?.publishedAt || data?.meta?.lastAttemptAt));
  setText(elementIds["kpi-model-quality"], quality);
}
function renderProvenance(data, source, status) {
  const baseline = data?.baseline || {};
  const evaluation = data?.evaluation || {};
  const historical = isHistorical(data);
  const model = modelDisplayName(data);
  const sourceRows = data?.meta?.source_rows || data?.rows?.length || 0;
  const range = historical ? `KOSPI 공개 원본 ${formatNumber(sourceRows)}개 행` : data?.meta?.source_range || (sourceRows ? `${formatNumber(sourceRows)}개 행` : "—");
  const isNaverCrawl = data?.provider?.id === "naver-crawl" || source?.source_id === "naver-public-polling-crawl";
  const limitation = historical ? "장전 호가·예상체결가·호가잔량은 원천 데이터에 없습니다." : isNaverCrawl ? "네이버 공개 웹 크롤링 · 비공식 출처 · 지연 가능 · 이용 조건 확인 필요" : data?.status === "no_data" ? "데이터 없음 · 숫자를 만들지 않습니다." : "결측·지연·품질 상태를 공개합니다.";
  setText(elementIds["source-name"], sourceDisplayName(source, data));
  setText(elementIds["source-license"], source?.license_status ? `이용 조건: ${displayEnumLabel(source.license_status, "확인 필요")}` : "이용 조건 —");
  const urlNode = elementIds["source-url"];
  urlNode.hidden = isNaverCrawl;
  if (source?.url) { urlNode.textContent = "원천 파일 열기 ↗"; urlNode.href = source.url; urlNode.removeAttribute("aria-disabled"); } else { urlNode.textContent = "원천 파일 링크 —"; urlNode.href = "#"; urlNode.setAttribute("aria-disabled", "true"); }
  setText(elementIds["evaluation-scope"], evaluation.evaluation_range?.forecast_date ? `${formatPlainDate(evaluation.evaluation_range.forecast_date)} 예상·정산` : historical ? "KOSPI 전체 공개 행" : status === "ready" ? "운영 스냅샷 행" : "평가 대기");
  setText(elementIds["snapshot-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["source-collection"], data?.meta?.source_collection_date || formatDate(source?.retrieved_at));
  setText(elementIds["source-range"], range);
  const modelInfo = forecastModelInfo(data);
  setText(elementIds["model-name"], modelInfo && !historical && !data?.meta?.retrospective_evaluation ? `${modelInfo.label}${modelInfo.version ? ` ${modelInfo.version}` : ""}` : model);
  if (modelInfo?.last && !historical && !data?.meta?.retrospective_evaluation) setText(elementIds["baseline-input"], `학습 ${modelInfo.first ? `${formatPlainDate(modelInfo.first)}~` : "~"}${formatPlainDate(modelInfo.last)} · ${modelInfo.days ?? "—"}거래일 · ${formatNumber(modelInfo.samples)}개 표본${modelInfo.trainedAt ? ` · 학습 ${formatTime(modelInfo.trainedAt)}` : ""}`);
  else setText(elementIds["baseline-input"], data?.meta?.retrospective_evaluation ? `직전 3거래일 시가·종가: ${data.retrospective_history_dates.join(", ")}` : historical ? `직전 ${baseline.lookback_sessions || 5}개 거래일 종가 기반 · ${baseline.input_through_date || "기준일 미상"}` : "연결된 데이터 기준");
  setText(elementIds["model-note"], data?.meta?.retrospective_mixed ? "장전 기록과 사후 계산이 섞여 있습니다. 종목별 출처를 확인하세요." : data?.meta?.retrospective_evaluation || historical ? "당시 08:20 예측이 아닌 사후 재현 가능한 기준선" : `예상 기준 상태: ${model === "미설정" ? "미설정" : status}`);
  setText(elementIds["limit-title"], historical ? "장전 정보가 없습니다" : "없는 값은 만들지 않습니다");
  setText(elementIds["quality-summary"], historical ? `${limitation} 예상값은 실제 과거 예측이 아닙니다.` : isNaverCrawl ? limitation : stateMessages[status] || stateMessages.no_data);
  setText(elementIds["quality-source"], `${sourceDisplayName(source, data)} · 갱신 ${formatShortTime(data?.publishedAt || data?.meta?.lastAttemptAt)}`);
  setText(elementIds["data-timestamp"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
}
function renderHeader(data) {
  const status = normalizeStatus(data?.status);
  const rows = attachEvaluationScores(Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : []);
  const source = data?.meta?.source || data?.provider?.source || null;
  const test = isTestOnly(data);
  const historical = isHistorical(data);
  const fallback = data?.meta?.historical_fallback === true;
  const route = requestedRoute();
  const statusText = fallback ? "과거 공개 데이터" : historical ? "과거 시험 데이터" : stateLabels[status] || status;
  document.documentElement.dataset.status = status;
  snapshot = { ...data, rows };
  currentDataMode = dateModeForRoute(route.rawMode || (historical || fallback ? "historical-test" : "provider"));
  currentDate = currentRouteDate(snapshot);
  if (isIsoDate(currentDate)) calendarMonthCursor = new Date(`${currentDate.slice(0, 7)}-01T00:00:00Z`);
  if (!selectedSymbol || !rows.some((row) => row.symbol === selectedSymbol)) selectedSymbol = rows[0]?.symbol || null;
  setStatusPill(elementIds["mode-badge"], historical || test ? "pending" : status, statusText);
  setText(elementIds["global-status"], fallback ? "과거 공개 데이터" : historical ? "과거 공개 데이터" : status === "ready" ? "시장 데이터 연결" : status === "demo" ? "화면 확인 모드" : status === "no_data" ? "데이터 대기" : statusText);
  setText(elementIds["status-message"], data?.meta?.fallback_from_no_data ? "운영 데이터가 없어 과거 공개 일봉 기준선을 표시합니다." : historical ? stateMessages.historical : stateMessages[data?.mode] || stateMessages[status] || stateMessages.no_data);
  setText(elementIds["as-of-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["published-at"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
  const info = forecastModelInfo(data);
  setText(elementIds["model-version"], info ? `${info.label}${info.version ? ` ${info.version}` : ""}` : "—");
  setText(elementIds["model-trained-at"], info?.trainedAt ? formatTime(info.trainedAt) : info?.last ? `데이터 ~${formatPlainDate(info.last)}` : "—");
  setText(elementIds["row-count"], formatNumber(rows.length));
  setText(elementIds["provider-label"], historical ? "과거 기준 데이터" : providerDisplayName(data));
  setText(elementIds["table-state"], test ? "과거 시험 데이터" : stateLabels[status] || status);
  setText(elementIds["table-count"], `${formatNumber(rows.length)}개 종목`);
  setText(elementIds["footer-status"], `${statusText} · 한국시간`);
  renderEvaluationSummary(data, rows, status);
  renderRibbon(data, status);
  renderKpis(data, rows, status);
  renderPipeline(data);
  renderProvenance(data, source, status);
  elementIds["data-notice"].hidden = status === "ready" && !test;
  setText(elementIds["notice-title"], fallback ? "운영 데이터 안내 · 과거 원본 표시" : historical ? "과거 데이터 안내 · 실시간 운영 데이터 아님" : status === "no_data" ? "데이터 없음 · 숫자를 만들지 않습니다." : `${statusText} · 데이터 상태를 확인하세요.`);
  setText(elementIds["notice-detail"], fallback ? "운영 데이터가 없어 과거 공개 원본을 표시합니다." : historical ? stateMessages.historical : stateMessages[status] || stateMessages.no_data);
  setText(elementIds["empty-state-note"], status === "no_data" ? "데이터 공급자가 연결되면 확인 가능한 종목이 이곳에 표시됩니다." : "검색 또는 필터 조건과 일치하는 종목이 없습니다.");
  renderRows();
  renderSelected();
  renderDateNavigation();
  setText(document.getElementById("ranking-lede"), data?.meta?.retrospective_evaluation ? "종목별 출처를 확인하세요. 장전 기록이 없는 종목의 사후 기준값은 장전 예측 성과를 의미하지 않습니다." : "종목 평가는 예상 시가→예상 종가 수익률이 이날 전체 종목 중 몇 백분위인지 0–100점(소수 셋째 자리)으로 표시합니다. 예상 시가·예상 종가가 모두 있을 때만 계산하고, 없으면 데이터 없음으로 표시합니다. 실제 수익률은 실제 시가→실제 종가 기준입니다.");
  if (!data?.meta?.retrospective_evaluation) void renderPostClose(data);
}

function currentRouteDate(data = snapshot) {
  const route = requestedRoute();
  return isIsoDate(route.date) ? route.date : (isIsoDate(data?.asOfDate) ? data.asOfDate : currentDate);
}

function calendarStatusText(state) {
  if (state.status === "available") return "결과 있음";
  if (state.status === "holiday") return `${state.label}${state.reason ? ` · ${state.reason}` : ""}`;
  return statusLabel(state.status);
}

function renderDateState(status, date, detail = "") {
  currentDate = isIsoDate(date) ? date : currentDate;
  const label = statusLabel(status);
  if (status !== "available") {
    postCloseToken += 1;
    snapshot = null;
    selectedSymbol = null;
    elementIds["selected-empty"].hidden = false;
    elementIds["selected-content"].hidden = true;
    setText(elementIds["selected-detail-hint"], "종목을 선택하세요");
  }
  setText(elementIds["table-state"], label);
  setText(elementIds["table-count"], status === "available" ? `${formatNumber(snapshot?.rows?.length || 0)}개 종목` : "—");
  if (elementIds["ranking-body"]) elementIds["ranking-body"].replaceChildren();
  if (elementIds["ranking-cards"]) elementIds["ranking-cards"].replaceChildren();
  if (elementIds["ranking-table"]) elementIds["ranking-table"].hidden = true;
  if (elementIds["empty-state"]) elementIds["empty-state"].hidden = false;
  setText(elementIds["empty-state-note"], detail || ({
    loading: "선택한 날짜의 실제 스냅샷을 읽는 중입니다.",
    not_collected: "이 날짜의 스냅샷 파일이 없어 이전 날짜 결과를 표시하지 않습니다.",
    holiday: "한국거래소 휴장일에는 수집·예측 결과가 없습니다.",
    error: "선택한 날짜의 결과를 읽지 못했습니다. 이전 결과는 유지하지 않습니다.",
  }[status] || "선택한 날짜의 상태를 확인하세요."));
  const state = dateState(date, currentDataMode);
  setText(elementIds["calendar-status"], `${formatPlainDate(date)} · ${calendarStatusText({ ...state, status })}`);
  renderDateNavigation();
}

function calendarMonthLabel(date) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long" }).format(date);
}

function isoDateAtOffset(year, month, day) {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function setCalendarFocus(offset) {
  const buttons = [...elementIds["calendar-grid"].querySelectorAll("button[data-date]:not([disabled])")];
  const focused = document.activeElement?.dataset?.date;
  const index = buttons.findIndex((button) => button.dataset.date === focused);
  const next = buttons[index < 0 ? 0 : Math.max(0, Math.min(buttons.length - 1, index + offset))];
  if (next) next.focus();
}

function openDatePopover() {
  const popover = elementIds["ranking-date-popover"];
  if (!popover) return;
  popover.hidden = false;
  elementIds["ranking-date-button"].setAttribute("aria-expanded", "true");
  renderDateNavigation();
  popover.querySelector("button[data-date][aria-selected='true'], button[data-date]:not([disabled])")?.focus();
}

function closeDatePopover({ restoreFocus = true } = {}) {
  const popover = elementIds["ranking-date-popover"];
  if (!popover) return;
  popover.hidden = true;
  elementIds["ranking-date-button"].setAttribute("aria-expanded", "false");
  if (restoreFocus) elementIds["ranking-date-button"]?.focus();
}

function restoreDateTriggerFocus() {
  elementIds["ranking-date-button"]?.focus();
}

function renderDateNavigation() {
  const button = elementIds["ranking-date-button"];
  const grid = elementIds["calendar-grid"];
  if (!button || !grid) return;
  const date = currentDate || currentRouteDate();
  if (!calendarMonthCursor) {
    const source = isIsoDate(date) ? date : new Date().toISOString().slice(0, 10);
    calendarMonthCursor = new Date(`${source.slice(0, 7)}-01T00:00:00Z`);
  }
  const mode = currentDataMode;
  const state = dateState(date, mode);
  setText(elementIds["ranking-date-label"], formatPlainDate(date));
  button.dataset.status = state.status;
  button.setAttribute("aria-label", `조회 날짜 ${formatPlainDate(date)} · ${calendarStatusText(state)}`);
  setText(elementIds["calendar-month"], calendarMonthLabel(calendarMonthCursor));
  grid.replaceChildren();
  const year = calendarMonthCursor.getUTCFullYear();
  const month = calendarMonthCursor.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const totalDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Math.ceil((firstWeekday + totalDays) / 7) * 7;
  for (let index = 0; index < cells; index += 1) {
    const day = index - firstWeekday + 1;
    const dateValue = isoDateAtOffset(year, month, day);
    const dateStateValue = dateState(dateValue, mode);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `date-cell date-cell-${dateStateValue.status}${dateValue.slice(0, 7) !== `${year}-${String(month + 1).padStart(2, "0")}` ? " date-cell-outside" : ""}`;
    cell.dataset.date = dateValue;
    cell.dataset.status = dateStateValue.status;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", `${formatPlainDate(dateValue)} · ${calendarStatusText(dateStateValue)}`);
    cell.setAttribute("aria-selected", String(dateValue === date));
    cell.setAttribute("aria-disabled", String(dateStateValue.status === "holiday"));
    cell.disabled = dateStateValue.status === "holiday";
    cell.innerHTML = `<span class="date-cell-day">${day}</span><span class="date-cell-status">${calendarStatusText(dateStateValue)}</span>`;
    if (dateValue === date) cell.classList.add("date-cell-selected");
    if (dateStateValue.status !== "holiday") cell.addEventListener("click", () => selectDate(dateValue));
    grid.append(cell);
  }
  setText(elementIds["calendar-status"], `${formatPlainDate(date)} · ${calendarStatusText(state)}`);
}

async function selectDate(date) {
  const state = dateState(date, currentDataMode);
  if (state.status === "holiday") return;
  currentDate = date;
  const url = new URL(window.location.href);
  url.searchParams.set("date", date);
  window.history.pushState({}, "", url);
  closeDatePopover({ restoreFocus: false });
  const token = ++dateRequestToken;
  renderDateState("loading", date);
  try { await refresh({ showLoading: false, token }); }
  finally { if (token === dateRequestToken) restoreDateTriggerFocus(); }
}

function moveCalendarMonth(delta) {
  const base = calendarMonthCursor || new Date();
  calendarMonthCursor = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + delta, 1));
  renderDateNavigation();
}

function toneClass(value) { return finite(value) ? value >= 0 ? "positive" : "negative" : ""; }
function sortRows(rows, sortKey = "expectedReturn") { return sortRankingRows(rows, sortKey); }
function openSourceLabel(source) {
  if (source?.kind === "preopen_quote") return "장전 호가 기록";
  if (source?.kind === "preopen_history") return "장전 공개 일봉 계산";
  if (source?.kind === "retrospective_history") return `사후 계산 · 공개 일봉 ${source.history_dates.join(", ")}`;
  return "출처 미확인";
}
function rowMetric(label, value, tone = "", title = "", note = "") { return `<div><span>${label}</span><strong class="${tone}"${title ? ` title="${escapeText(title)}"` : ""}>${value}</strong>${note ? `<small class="evaluation-note">${escapeText(note)}</small>` : ""}</div>`; }
function createMobileCard(row) {
  const card = document.createElement("article");
  card.className = "ranking-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${row.name} ${row.symbol} 상세 보기`);
  card.setAttribute("aria-selected", String(row.symbol === selectedSymbol));
  card.dataset.symbol = row.symbol;
  card.innerHTML = `<div class="ranking-card-head"><span class="ranking-card-rank">#${escapeText(row.rank)}</span><strong class="ranking-card-name">${escapeText(row.name)}</strong><span class="ranking-card-code">${escapeText(row.symbol)}</span></div><span class="row-status ${escapeText(row.status)} ranking-card-status">${escapeText(rowStatusLabel(row))}</span><div class="ranking-card-metrics">${rowMetric(`예상 시가 · ${escapeText(openSourceLabel(row.expectedOpenSource))}`, formatExpectedPrice(row.expectedOpen))}${rowMetric("예상 종가", formatExpectedPrice(row.expectedClose))}${rowMetric("종목 평가", formatEvaluationScore(row.evaluationScore), toneClass(row.expectedReturn), evaluationTitle(row), evaluationNote(row))}${rowMetric("실제 시가", formatPrice(row.actualOpen))}${rowMetric("실제 종가", formatPrice(row.actualClose))}${rowMetric("실제 최고가", formatHigh(row.actualHigh))}${rowMetric("실제 장중 수익률", formatPercent(row.sessionReturn), toneClass(row.sessionReturn))}${rowMetric("오차", formatPercent(row.error), toneClass(row.error))}${rowMetric("거래량", formatNumber(row.actualVolume))}</div>`;
  card.addEventListener("click", () => selectRow(row.symbol, { reveal: true }));
  card.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectRow(row.symbol, { reveal: true }); } });
  return card;
}
// The ranking list has no inner scroll container; ~900 rows are split into
// pages so the page itself stays a sensible length. A new snapshot, search,
// filter or sort returns to page 1; selecting a row keeps the current page.
const RANKING_PAGE_SIZE = 50;
const rankingPager = {
  nav: document.getElementById("ranking-pager"),
  prev: document.getElementById("ranking-page-prev"),
  next: document.getElementById("ranking-page-next"),
  select: document.getElementById("ranking-page-select"),
  status: document.getElementById("ranking-page-status")
};
let rankingPage = 1;
let rankingPageSnapshot = null;
let rankingPageKey = "";
function renderRankingPager(total, pageCount, start, shown) {
  if (!rankingPager.nav) return;
  rankingPager.nav.hidden = total <= RANKING_PAGE_SIZE;
  setText(rankingPager.status, total ? `${formatNumber(start + 1)}–${formatNumber(start + shown)} / 전체 ${formatNumber(total)}개` : "");
  if (rankingPager.select && rankingPager.select.options.length !== pageCount) {
    rankingPager.select.replaceChildren(...Array.from({ length: pageCount }, (_, index) => new Option(`${index + 1} / ${pageCount}쪽`, String(index + 1))));
  }
  if (rankingPager.select) rankingPager.select.value = String(rankingPage);
  if (rankingPager.prev) rankingPager.prev.disabled = rankingPage <= 1;
  if (rankingPager.next) rankingPager.next.disabled = rankingPage >= pageCount;
}
function goToRankingPage(page, trigger) {
  rankingPage = page;
  renderRows();
  if (trigger?.disabled) rankingPager.select?.focus();
  const wrap = document.querySelector(".ranking-table-wrap");
  if (wrap && wrap.getBoundingClientRect().top < 0) wrap.scrollIntoView({ block: "start" });
}
rankingPager.prev?.addEventListener("click", () => goToRankingPage(rankingPage - 1, rankingPager.prev));
rankingPager.next?.addEventListener("click", () => goToRankingPage(rankingPage + 1, rankingPager.next));
rankingPager.select?.addEventListener("change", () => goToRankingPage(Number(rankingPager.select.value) || 1));
function renderRows() {
  const allRows = snapshot?.rows || [];
  const query = elementIds["search-input"].value.trim().toLowerCase();
  const filter = elementIds["status-filter"].value;
  const sortKey = elementIds["sort-select"].value;
  const rows = sortRows(allRows.filter((row) => (!query || `${row.symbol} ${row.name}`.toLowerCase().includes(query)) && (filter === "all" || row.status === filter)), sortKey);
  const pageKey = `${query}\u0000${filter}\u0000${sortKey}`;
  if (rankingPageSnapshot !== snapshot || rankingPageKey !== pageKey) { rankingPage = 1; rankingPageSnapshot = snapshot; rankingPageKey = pageKey; }
  const pageCount = Math.max(1, Math.ceil(rows.length / RANKING_PAGE_SIZE));
  rankingPage = Math.min(Math.max(1, rankingPage), pageCount);
  const pageStart = (rankingPage - 1) * RANKING_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + RANKING_PAGE_SIZE);
  elementIds["ranking-body"].replaceChildren();
  elementIds["ranking-cards"].replaceChildren();
  renderRankingPager(rows.length, pageCount, pageStart, pageRows.length);
  pageRows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.symbol = row.symbol;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `${row.name} ${row.symbol} 상세 보기`);
    tr.setAttribute("aria-selected", String(row.symbol === selectedSymbol));
    tr.innerHTML = `<td>${escapeText(row.rank)}</td><td><strong class="instrument-name">${escapeText(row.name)}</strong><span class="instrument-code">${escapeText(row.symbol)}</span></td><td aria-label="예상 시가 ${formatExpectedPrice(row.expectedOpen)}. 원 단위 정수 표시"><span class="cell-num">${formatExpectedPrice(row.expectedOpen)}</span><small class="cell-sub">${escapeText(openSourceLabel(row.expectedOpenSource))}</small></td><td class="${toneClass(row.expectedReturn)}" title="${escapeText(evaluationTitle(row))}" aria-label="종목 평가 ${formatEvaluationScore(row.evaluationScore)}. 0–100 백분위 점수, 소수 셋째 자리 표시. ${escapeText(evaluationTitle(row))}">${formatEvaluationScore(row.evaluationScore)}</td><td>${formatPrice(row.actualOpen)}</td><td>${formatPrice(row.actualClose)}</td><td>${formatHigh(row.actualHigh)}</td><td class="${toneClass(row.sessionReturn)}" aria-label="실제 시가 대비 실제 종가 장중 수익률">${formatPercent(row.sessionReturn)}</td><td class="${toneClass(row.error)}">${formatPercent(row.error)}</td><td>${formatNumber(row.actualVolume)}</td><td><span class="row-status ${escapeText(row.status)}">${escapeText(rowStatusLabel(row))}</span></td>`;
    tr.addEventListener("click", () => selectRow(row.symbol, { reveal: true }));
    tr.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectRow(row.symbol, { reveal: true }); } });
    elementIds["ranking-body"].append(tr);
    elementIds["ranking-cards"].append(createMobileCard(row));
  });
  elementIds["ranking-table"].hidden = rows.length === 0;
  elementIds["empty-state"].hidden = rows.length !== 0;
}
function selectRow(symbol, { reveal = false } = {}) {
  selectedSymbol = symbol;
  renderRows();
  renderSelected();
  // The detail panel no longer scrolls internally or sticks beside the list,
  // so bring its top into view whenever it is off screen (any width).
  const panel = reveal ? document.querySelector(".detail-panel") : null;
  const panelTop = panel?.getBoundingClientRect().top;
  if (panel && (window.matchMedia?.("(max-width: 1120px)").matches || panelTop < 0 || panelTop > window.innerHeight - 160)) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderEvidence(row) {
  const container = elementIds["selected-evidence"];
  if (!container) return;
  const detail = buildSelectedDetail({ ...row.raw, reasons: row.reasons }, {
    baseline: snapshot?.baseline, pipeline: snapshot?.pipeline, retrospective: snapshot?.retrospective_record || null, runStage: snapshot?.meta?.run_stage,
    providerId: snapshot?.provider?.id, providerLabel: providerDisplayName(snapshot), source: snapshot?.meta?.source || snapshot?.provider?.source || null,
    testOnly: isTestOnly(snapshot), qualityLabel,
  });
  container.replaceChildren();
  if (!detail) return;
  const stateText = { available: "근거 있음", partial: "일부 기록", missing: "근거 데이터 없음", no_trade: NO_TRADE_LABEL };
  for (const section of detail.sections) {
    const block = document.createElement("section");
    block.className = "detail-section";
    block.dataset.section = section.id;
    block.dataset.state = section.state;
    const head = document.createElement("div");
    head.className = "detail-section-head";
    const title = document.createElement("h4");
    title.textContent = section.title;
    const badge = document.createElement("span");
    badge.className = `detail-section-state state-${section.state}`;
    badge.textContent = stateText[section.state] || section.state;
    head.append(title, badge);
    const list = document.createElement("dl");
    list.className = "detail-facts";
    for (const fact of section.items) {
      const wrap = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = fact.label;
      const value = document.createElement("dd");
      value.textContent = fact.value;
      wrap.append(term, value);
      list.append(wrap);
    }
    block.append(head, list);
    for (const warning of section.warnings || []) { const node = document.createElement("p"); node.className = "detail-warning"; node.textContent = warning; block.append(node); }
    if (section.sentences.length) {
      const steps = document.createElement("ul");
      steps.className = "detail-steps";
      for (const sentence of section.sentences) { const li = document.createElement("li"); li.textContent = sentence; steps.append(li); }
      block.append(steps);
    }
    for (const gap of section.missing) { const node = document.createElement("p"); node.className = "detail-missing"; node.textContent = `근거 데이터 없음 — ${gap.label}: ${gap.reason}`; block.append(node); }
    container.append(block);
  }
  const disclaimer = document.createElement("p");
  disclaimer.className = "detail-disclaimer";
  disclaimer.textContent = detail.disclaimer;
  container.append(disclaimer);
}
function renderSelected() {
  const row = snapshot?.rows?.find((candidate) => candidate.symbol === selectedSymbol);
  if (!row) { elementIds["selected-empty"].hidden = false; elementIds["selected-content"].hidden = true; setText(elementIds["selected-detail-hint"], "종목을 선택하세요"); return; }
  elementIds["selected-empty"].hidden = true;
  elementIds["selected-content"].hidden = false;
  setText(elementIds["selected-detail-hint"], `${row.symbol} · 선택됨`);
  setText(elementIds["selected-symbol"], row.symbol);
  setText(elementIds["selected-name"], row.name);
  setStatusPill(elementIds["selected-status"], row.status, rowStatusLabel(row));
  setText(elementIds["selected-expected-open"], formatExpectedPrice(row.expectedOpen));
  setText(elementIds["selected-expected-close"], formatExpectedPrice(row.expectedClose));
  setText(elementIds["selected-expected-return"], formatEvaluationScore(row.evaluationScore));
  elementIds["selected-expected-return"]?.setAttribute("title", evaluationTitle(row));
  setText(document.getElementById("selected-evaluation-note"), evaluationNote(row));
  setText(elementIds["selected-actual-open"], formatPrice(row.actualOpen));
  setText(elementIds["selected-actual-close"], formatPrice(row.actualClose));
  setText(elementIds["selected-actual-return"], formatPercent(row.sessionReturn));
  setText(elementIds["selected-error"], formatPercent(row.error));
  setText(elementIds["selected-confidence"], finite(row.confidence) ? numberFormatter.format(row.confidence) : "—");
  setText(elementIds["selected-quality"], `품질 ${qualityLabel(row.quality)}`);
  setText(elementIds["selected-reasons"], `상태 사유 ${row.reasons?.length ? row.reasons.join(", ") : "기록 없음"}`);
  renderEvidence(row);
}
function updateClock() { const now = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); setText(elementIds["top-clock"], `KST ${now}`); }
async function refresh({ showLoading = false, token = null } = {}) {
  const route = requestedRoute();
  const date = isIsoDate(route.date) ? route.date : currentDate;
  if (showLoading && date) renderDateState("loading", date);
  try {
    const nextSnapshot = await loadSnapshot();
    if (token !== null && token !== dateRequestToken) return;
    renderHeader(nextSnapshot);
  } catch (error) {
    if (token !== null && token !== dateRequestToken) return;
    console.error(error);
    if (error instanceof DateNavigationError) {
      renderDateState(error.status, error.date, error.status === "error" ? `입력한 날짜를 확인하세요: ${error.date || "날짜 없음"}` : error.status === "not_collected" ? "이 날짜의 스냅샷이 아직 수집되지 않아 이전 결과를 표시하지 않습니다." : error.status === "holiday" ? "한국거래소 휴장일입니다. 수집·예측 결과가 없습니다." : "선택한 날짜의 스냅샷을 읽지 못했습니다.");
      return;
    }
    const failed = emptySnapshot("정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요.");
    failed.status = "blocked";
    failed.provider = { status: "blocked", label: "스냅샷 읽기 실패" };
    snapshot = null;
    renderHeader(failed);
    renderDateState("error", date, "정적 스냅샷을 읽지 못했습니다. 이전 결과는 유지하지 않습니다.");
    setText(elementIds["notice-detail"], "정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요.");
  }
}

function initSkipLink() {
  const skipLink = document.querySelector(".skip-link");
  if (!skipLink) return;
  skipLink.addEventListener("click", (event) => {
    const href = skipLink.getAttribute("href") || "";
    const target = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView();
  });
}

initSkipLink();
elementIds["search-input"].addEventListener("input", renderRows);
elementIds["status-filter"].addEventListener("change", renderRows);
elementIds["sort-select"].addEventListener("change", renderRows);
elementIds["refresh-button"].addEventListener("click", refresh);
elementIds["ranking-date-button"].addEventListener("click", () => {
  const expanded = elementIds["ranking-date-button"].getAttribute("aria-expanded") === "true";
  if (expanded) closeDatePopover(); else openDatePopover();
});
elementIds["ranking-date-button"].addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDatePopover();
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDatePopover();
  }
});
elementIds["calendar-prev"].addEventListener("click", () => moveCalendarMonth(-1));
elementIds["calendar-next"].addEventListener("click", () => moveCalendarMonth(1));
elementIds["calendar-grid"].addEventListener("keydown", (event) => {
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (Object.hasOwn(offsets, event.key)) { event.preventDefault(); setCalendarFocus(offsets[event.key]); }
  if (event.key === "Escape") { event.preventDefault(); closeDatePopover(); }
});
elementIds["ranking-date-popover"].addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeDatePopover(); }
});
window.addEventListener("popstate", () => refresh({ showLoading: true }));
updateClock();
setInterval(updateClock, 1000);
(async () => {
  await loadDateMetadata();
  refresh();
})();
