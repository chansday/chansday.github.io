import { isSnapshot, noDataSnapshot } from "./providers/provider-adapter.js";
import { createDemoProvider } from "./providers/demo-provider.js";

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
const HISTORICAL_TEST_DATES = Object.freeze(["2026-10-23", "2026-10-22"]);
const HISTORICAL_TEST_STAGE = "1530";
const HISTORICAL_TEST_REQUIRED_FIELDS = Object.freeze(["rank", "expected_open", "expected_return", "actual_open", "actual_return", "error"]);
const elementIds = [
  "mode-badge", "data-purpose", "global-status", "status-message", "as-of-date", "published-at", "row-count", "provider-label", "top-clock", "refresh-button",
  "quality-ribbon", "quality-ribbon-label", "quality-ribbon-text", "truth-label", "truth-note-text", "evaluation-status", "evaluation-headline", "evaluation-description", "summary-status", "summary-status-detail", "summary-samples", "summary-samples-detail", "summary-range", "summary-range-detail", "summary-rmse", "summary-rmse-detail", "summary-expected", "summary-expected-detail", "summary-actual", "summary-actual-detail", "summary-error", "summary-error-detail", "summary-scope", "summary-scope-detail",
  "kpi-market", "kpi-market-note", "kpi-market-bar", "kpi-universe", "kpi-valid", "kpi-accuracy", "kpi-accuracy-note", "kpi-model", "kpi-model-note", "kpi-model-time", "kpi-model-quality", "table-state", "table-count", "ranking-table", "ranking-body", "ranking-cards", "empty-state", "empty-state-note", "search-input", "status-filter", "sort-select",
  "selected-empty", "selected-content", "selected-detail-hint", "selected-symbol", "selected-name", "selected-status", "selected-expected-open", "selected-expected-close", "selected-expected-return", "selected-actual-open", "selected-actual-close", "selected-actual-return", "selected-session-return", "selected-error", "selected-confidence", "selected-quality", "selected-reasons",
  "source-name", "source-url", "source-license", "evaluation-scope", "data-timestamp", "snapshot-date", "source-collection", "source-range", "model-name", "baseline-input", "model-note", "limit-title", "quality-summary", "quality-source", "data-notice", "notice-title", "notice-detail", "footer-status",
].reduce((result, id) => ({ ...result, [id]: document.getElementById(id) }), {});

let snapshot = null;
let selectedSymbol = null;

function setText(node, value) { if (node) node.textContent = value; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function valueOf(row, ...keys) { for (const key of keys) if (row?.[key] !== undefined) return row[key]; return null; }
function normalizeStatus(status) { return String(status || "no_data").toLowerCase().replaceAll("-", "_"); }
function normalizeDisplayZero(value, precision = 2) { if (!finite(value)) return value; return Math.abs(value) < (0.5 * (10 ** -precision)) ? 0 : value; }
function formatPrice(value) { return finite(value) ? `${numberFormatter.format(normalizeDisplayZero(value))}원` : "—"; }
function formatPercent(value) { const displayValue = normalizeDisplayZero(value); return finite(displayValue) ? `${displayValue > 0 ? "+" : ""}${numberFormatter.format(displayValue)}%` : "—"; }
function roundExpectedHalfUp(value) { if (!finite(value)) return value; const magnitude = Math.floor(Math.abs(value) + 0.5); const rounded = value < 0 ? -magnitude : magnitude; return rounded === 0 ? 0 : rounded; }
function formatExpectedPrice(value) { if (!finite(value)) return "—"; const displayValue = normalizeDisplayZero(roundExpectedHalfUp(value), 0); return `${integerFormatter.format(displayValue)}원`; }
function formatExpectedPercent(value) { if (!finite(value)) return "—"; const displayValue = normalizeDisplayZero(roundExpectedHalfUp(value), 0); return `${displayValue > 0 ? "+" : ""}${integerFormatter.format(displayValue)}%`; }
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
  const labels = { "historical-test": "과거 기준 데이터", "public-csv": "공개 일별 데이터", "public-json": "공개 데이터", fixture: "합성 시험 데이터", replay_baseline: "합성 재생 기준선", "backfill-test": "시험용 보충 데이터", demo: "화면 확인용 데이터" };
  return labels[providerId] || "데이터 공급자 정보";
}
function sourceDisplayName(source, data) { const sourceName = String(source?.name || "").trim(); return sourceName && !/^[a-z0-9_-]+$/i.test(sourceName) ? sourceName : providerDisplayName(data); }
function modelDisplayName(data) {
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
  return {
    rank: valueOf(row, "rank") ?? index + 1,
    symbol: valueOf(row, "symbol", "code", "instrument_id") || "—",
    name: valueOf(row, "name", "instrument_name") || "종목명 미정",
    expectedOpen: valueOf(row, "expected_open"), expectedClose: valueOf(row, "expected_close"), expectedReturn: valueOf(row, "expected_return"),
    actualOpen: valueOf(row, "actual_open"), actualClose: valueOf(row, "actual_close"), actualReturn: valueOf(row, "actual_return"), sessionReturn: valueOf(row, "session_return") ?? (finite(valueOf(row, "actual_open")) && finite(valueOf(row, "actual_close")) && valueOf(row, "actual_open") > 0 ? Math.round(((valueOf(row, "actual_close") / valueOf(row, "actual_open") - 1) * 100 + Number.EPSILON) * 100) / 100 : null), actualVolume: valueOf(row, "actual_volume"),
    error: valueOf(row, "error"), confidence: valueOf(row, "confidence", "confidence_score"), quality: valueOf(row, "quality", "quality_status") || rawStatus,
    reasons: row?.eligibility?.reasons || row?.reasons || [], status: rawStatus === "ready" ? "valid" : rawStatus,
  };
}
function emptySnapshot(message = "연결된 데이터 공급자가 없습니다.") { return noDataSnapshot({ provider: { id: null, status: "not_configured", label: "연결된 데이터 공급자 없음", source: null }, message }); }
function validateRequestedDate(date, label) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} date is invalid`); return date; }
async function fetchSnapshot(path, errorLabel) { const response = await fetch(path, { cache: "no-store" }); if (!response.ok) throw new Error(`${errorLabel}: ${response.status}`); return response.json(); }
function historicalTestRunPath(date, stage = HISTORICAL_TEST_STAGE) { if (!HISTORICAL_TEST_DATES.includes(date)) throw new Error(`Historical-test date is not supported: ${date}`); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Historical-test date is invalid: ${date}`); if (!/^\d{4}$/.test(stage)) throw new Error(`Historical-test stage is invalid: ${stage}`); return `${historicalTestDataRoot}/${date}/${stage}.json`; }
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
  for (const date of HISTORICAL_TEST_DATES) {
    try { return await loadHistoricalTestSnapshot(date, liveSnapshot); } catch (error) { if (!String(error?.message || error).includes("404")) console.warn(error.message); }
  }
  return null;
}
async function loadSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("mode")?.toLowerCase();
  if (requestedMode === "demo") return createDemoProvider().getSnapshot();
  if (requestedMode === "fixture") { const date = validateRequestedDate(params.get("date") || "2026-10-23", "Fixture"); const fixture = await fetchSnapshot(`./data/fixtures/${encodeURIComponent(date)}.json`, "Fixture request failed"); if (!isSnapshot(fixture) || fixture.mode !== "fixture" || fixture.meta?.isDemo !== true) throw new Error("Fixture snapshot shape is invalid"); return fixture; }
  if (requestedMode === "replay") { const date = params.get("date") || "2026-10-23"; if (!["2026-10-22", "2026-10-23"].includes(date)) throw new Error("Replay date is not supported"); const replay = await fetchSnapshot(`./data/replays/${encodeURIComponent(date)}.json`, "Replay request failed"); if (!isSnapshot(replay) || replay.mode !== "replay" || replay.meta?.isDemo !== true || replay.meta?.replay_type !== "replay_baseline") throw new Error("Replay snapshot shape is invalid"); return replay; }
  if (requestedMode === "backfill-test" || requestedMode === "backfill_test") { const date = params.get("date") || "2026-10-23"; if (!["2026-10-22", "2026-10-23"].includes(date)) throw new Error("Backfill date is not supported"); const backfill = await fetchSnapshot(`./data/backfill-test/${encodeURIComponent(date)}.json`, "Backfill request failed"); if (!isSnapshot(backfill) || backfill.mode !== "backfill_test" || backfill.provider?.id !== "backfill-test" || backfill.meta?.isDemo !== true || backfill.meta?.backfill !== true) throw new Error("Backfill snapshot shape is invalid"); return backfill; }
  if (requestedMode === "historical-test" || requestedMode === "historical_test") { const date = params.get("date") || "2026-10-23"; if (!HISTORICAL_TEST_DATES.includes(date)) throw new Error("Historical-test date is not supported"); return loadHistoricalTestSnapshot(date); }
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
function rowStatusLabel(row) { if (isHistorical(snapshot)) return row.status === "valid" ? "정상 확인" : (rowStateLabels[row.status] || row.status); return rowStateLabels[row.status] || qualityLabel(row.quality); }
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
  const label = fallback ? historicalFallbackLabel : historical ? historicalFallbackLabel : isTestOnly(data) ? testLabel(data) : status === "ready" ? "운영 데이터" : "평가 대기";
  const range = evaluation.evaluation_range || {};
  const inputRange = range.input_range || {};
  const rangeHeadline = range.forecast_date ? formatPlainDate(range.forecast_date) : "—";
  const rangeDetail = inputRange.start && inputRange.end ? `입력 기준 ${formatPlainDate(inputRange.start)} ~ ${formatPlainDate(inputRange.end)}` : "검증 대상 기간 정보 없음";
  const expectedText = historical ? "사후 기준값" : rows.some((row) => finite(row.expectedReturn)) ? "예상값 기록" : "예상값 없음";
  const actualText = settled.length ? "09:00 시가 정산" : "정산 대기";
  const scopeText = historical ? "KOSPI 전체 행" : rows.length ? "현재 표시 행" : "평가 대기";
  setText(elementIds["evaluation-status"], evaluated ? "검증 완료" : "평가 대기");
  setText(elementIds["evaluation-headline"], evaluated ? `예상과 실제를 ${formatNumber(evaluatedSampleCount)}개 종목으로 비교했습니다.` : "아직 비교할 정산값이 없습니다.");
  setText(elementIds["evaluation-description"], historical ? "과거 공개 일봉으로 사후 계산한 기준선입니다. 당시 장전 예측이나 실전 성과를 복원한 결과는 아닙니다." : evaluated ? "평균 절대오차와 제곱근 평균오차를 함께 보며 결과의 크기를 가늠하세요." : "정산이 끝나면 예상값·실제값·오차를 같은 기준으로 보여드립니다.");
  setText(elementIds["summary-status"], evaluation.status === "evaluated" ? "검증 완료" : evaluated ? "비교 가능" : "평가 대기");
  setText(elementIds["summary-status-detail"], historical ? "검증용 과거 데이터" : "현재 스냅샷 기준");
  setText(elementIds["summary-samples"], formatNumber(evaluatedSampleCount));
  setText(elementIds["summary-samples-detail"], `전체 ${formatNumber(sampleCount)}개 · 제외 ${formatNumber(missingSampleCount)}개`);
  setText(elementIds["summary-range"], rangeHeadline);
  setText(elementIds["summary-range-detail"], rangeDetail);
  setText(elementIds["truth-label"], label);
  setText(elementIds["data-purpose"], historical ? "과거 공개 데이터" : isTestOnly(data) ? "시험용 데이터" : status === "ready" ? "운영 데이터" : "운영 데이터 대기");
  setText(elementIds["summary-expected"], expectedText);
  setText(elementIds["summary-expected-detail"], historical ? `직전 ${data?.baseline?.lookback_sessions || 5}개 거래일 종가 · 장전 호가 없음` : "장전 기준값이 있는 종목");
  setText(elementIds["summary-actual"], actualText);
  setText(elementIds["summary-actual-detail"], settled.length ? `${formatNumber(evaluatedSampleCount)}개 종목의 실제 시가` : "09:00 정규장 공식 시작가");
  setText(elementIds["summary-error"], finite(meanAbsoluteError) ? `${numberFormatter.format(meanAbsoluteError)}%` : "—");
  setText(elementIds["summary-error-detail"], finite(meanAbsoluteError) ? `오차 절대값의 평균 · 표본 ${formatNumber(evaluatedSampleCount)}개` : "오차 산출을 위한 정산 대기");
  setText(elementIds["summary-rmse"], finite(rootMeanSquaredError) ? `${numberFormatter.format(rootMeanSquaredError)}%` : "—");
  setText(elementIds["summary-rmse-detail"], finite(rootMeanSquaredError) ? "큰 오차를 더 민감하게 반영" : "평가 메타데이터 없음");
  setText(elementIds["summary-scope"], scopeText);
  setText(elementIds["summary-scope-detail"], rows.length ? `평가 표본 ${formatNumber(evaluatedSampleCount)} / 전체 ${formatNumber(sampleCount)}개` : "표시할 행이 없습니다.");
  setText(elementIds["truth-note-text"], historical ? "테스트 전용 과거 검증 데이터입니다. 당시 08:20에 게시된 예측이 아니며, 과거 예측 성과나 수익을 보장하지 않습니다." : isTestOnly(data) ? "검증 전용 데이터입니다. 합성·재생·보충 값은 금융 실측값이나 예측 성과가 아닙니다." : stateMessages[status] || stateMessages.no_data);
}
function renderRibbon(data, status) {
  const historicalFallback = data?.meta?.historical_fallback === true;
  const show = Boolean(historicalFallback || data?.meta?.fallback_from_no_data || (isTestOnly(data) && status !== "no_data"));
  elementIds["quality-ribbon"].hidden = !show;
  if (!show) return;
  setText(elementIds["quality-ribbon-label"], historicalFallback ? historicalFallbackLabel : testLabel(data));
  setText(elementIds["quality-ribbon-text"], historicalFallback ? "운영 데이터가 없을 때만 선택하는 과거 공개 원본입니다. 숫자를 합성하지 않았습니다." : data?.meta?.fallback_from_no_data ? "운영 데이터가 없어 과거 공개 일봉을 표시합니다. 실전 데이터로 해석하지 마세요." : stateMessages[isHistorical(data) ? "historical" : data?.mode] || "시험용 데이터입니다. 금융 실측값이나 예측 성과로 해석하지 마세요.");
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
  setText(elementIds["kpi-accuracy-note"], settled.length ? `정산 표본 ${formatNumber(settled.length)}개` : "정산 표본 대기");
  setText(elementIds["kpi-model"], model);
  setText(elementIds["kpi-model-note"], isHistorical(data) ? "사후 계산 · 장전 호가 없음" : displayEnumLabel(baseline.value_status, "예상 기준 정보 없음"));
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
  const limitation = historical ? "장전 호가·예상체결가·호가잔량은 원천 데이터에 없습니다." : data?.status === "no_data" ? "데이터 없음 · 숫자를 만들지 않습니다." : "결측·지연·품질 상태를 공개합니다.";
  setText(elementIds["source-name"], sourceDisplayName(source, data));
  setText(elementIds["source-license"], source?.license_status ? `이용 조건: ${displayEnumLabel(source.license_status, "확인 필요")}` : "이용 조건 —");
  const urlNode = elementIds["source-url"];
  if (source?.url) { urlNode.textContent = "원천 파일 열기 ↗"; urlNode.href = source.url; urlNode.removeAttribute("aria-disabled"); } else { urlNode.textContent = "원천 파일 링크 —"; urlNode.href = "#"; urlNode.setAttribute("aria-disabled", "true"); }
  setText(elementIds["evaluation-scope"], evaluation.evaluation_range?.forecast_date ? `${formatPlainDate(evaluation.evaluation_range.forecast_date)} 예상·정산` : historical ? "KOSPI 전체 공개 행" : status === "ready" ? "운영 스냅샷 행" : "평가 대기");
  setText(elementIds["snapshot-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["source-collection"], data?.meta?.source_collection_date || formatDate(source?.retrieved_at));
  setText(elementIds["source-range"], range);
  setText(elementIds["model-name"], model);
  setText(elementIds["baseline-input"], historical ? `직전 ${baseline.lookback_sessions || 5}개 거래일 종가 기반 · ${baseline.input_through_date || "기준일 미상"}` : "연결된 데이터 기준");
  setText(elementIds["model-note"], historical ? "당시 08:20 예측이 아닌 사후 재현 가능한 기준선" : `예상 기준 상태: ${model === "미설정" ? "미설정" : status}`);
  setText(elementIds["limit-title"], historical ? "장전 정보가 없습니다" : "없는 값은 만들지 않습니다");
  setText(elementIds["quality-summary"], historical ? `${limitation} 예상값은 실제 과거 예측이 아닙니다.` : stateMessages[status] || stateMessages.no_data);
  setText(elementIds["quality-source"], `${sourceDisplayName(source, data)} · 갱신 ${formatShortTime(data?.publishedAt || data?.meta?.lastAttemptAt)}`);
  setText(elementIds["data-timestamp"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
}
function renderHeader(data) {
  const status = normalizeStatus(data?.status);
  const rows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
  const source = data?.meta?.source || data?.provider?.source || null;
  const test = isTestOnly(data);
  const historical = isHistorical(data);
  const fallback = data?.meta?.historical_fallback === true;
  const statusText = fallback ? "과거 공개 데이터" : historical ? "과거 시험 데이터" : stateLabels[status] || status;
  document.documentElement.dataset.status = status;
  snapshot = { ...data, rows };
  if (!selectedSymbol || !rows.some((row) => row.symbol === selectedSymbol)) selectedSymbol = rows[0]?.symbol || null;
  setStatusPill(elementIds["mode-badge"], historical || test ? "pending" : status, statusText);
  setText(elementIds["global-status"], fallback ? "과거 공개 데이터" : historical ? "과거 공개 데이터" : status === "ready" ? "시장 데이터 연결" : status === "demo" ? "화면 확인 모드" : status === "no_data" ? "데이터 대기" : statusText);
  setText(elementIds["status-message"], data?.meta?.fallback_from_no_data ? "운영 데이터가 없어 과거 공개 일봉 기준선을 표시합니다." : historical ? stateMessages.historical : stateMessages[data?.mode] || stateMessages[status] || stateMessages.no_data);
  setText(elementIds["as-of-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["published-at"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
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
}
function toneClass(value) { return finite(value) ? value >= 0 ? "positive" : "negative" : ""; }
function sortRows(rows, sortKey) { return rows.sort((a, b) => { if (sortKey === "name") return a.name.localeCompare(b.name, "ko"); const av = a[sortKey]; const bv = b[sortKey]; if (!finite(av) && !finite(bv)) return 0; if (!finite(av)) return 1; if (!finite(bv)) return -1; if (sortKey === "rank") return av - bv; if (sortKey === "error") return Math.abs(av) - Math.abs(bv); return bv - av; }); }
function rowMetric(label, value, tone = "") { return `<div><span>${label}</span><strong class="${tone}">${value}</strong></div>`; }
function createMobileCard(row) {
  const card = document.createElement("article");
  card.className = "ranking-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${row.name} ${row.symbol} 상세 보기`);
  card.setAttribute("aria-selected", String(row.symbol === selectedSymbol));
  card.dataset.symbol = row.symbol;
  card.innerHTML = `<div class="ranking-card-head"><span class="ranking-card-rank">#${escapeText(row.rank)}</span><strong class="ranking-card-name">${escapeText(row.name)}</strong><span class="ranking-card-code">${escapeText(row.symbol)}</span></div><span class="row-status ${escapeText(row.status)} ranking-card-status">${escapeText(rowStatusLabel(row))}</span><div class="ranking-card-metrics">${rowMetric("예상 시가", formatExpectedPrice(row.expectedOpen))}${rowMetric("예상 종가", formatExpectedPrice(row.expectedClose))}${rowMetric("예상 수익률", formatExpectedPercent(row.expectedReturn), toneClass(row.expectedReturn))}${rowMetric("실제 시가", formatPrice(row.actualOpen))}${rowMetric("실제 종가", formatPrice(row.actualClose))}${rowMetric("시가 수익률", formatPercent(row.actualReturn), toneClass(row.actualReturn))}${rowMetric("장중 수익률", formatPercent(row.sessionReturn), toneClass(row.sessionReturn))}${rowMetric("오차", formatPercent(row.error), toneClass(row.error))}${rowMetric("거래량", formatNumber(row.actualVolume))}</div>`;
  card.addEventListener("click", () => selectRow(row.symbol));
  card.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectRow(row.symbol); } });
  return card;
}
function renderRows() {
  const allRows = snapshot?.rows || [];
  const query = elementIds["search-input"].value.trim().toLowerCase();
  const filter = elementIds["status-filter"].value;
  const rows = sortRows(allRows.filter((row) => (!query || `${row.symbol} ${row.name}`.toLowerCase().includes(query)) && (filter === "all" || row.status === filter)), elementIds["sort-select"].value);
  elementIds["ranking-body"].replaceChildren();
  elementIds["ranking-cards"].replaceChildren();
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.symbol = row.symbol;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `${row.name} ${row.symbol} 상세 보기`);
    tr.setAttribute("aria-selected", String(row.symbol === selectedSymbol));
    tr.innerHTML = `<td>${escapeText(row.rank)}</td><td><strong class="instrument-name">${escapeText(row.name)}</strong><span class="instrument-code">${escapeText(row.symbol)}</span></td><td aria-label="예상 시가 ${formatExpectedPrice(row.expectedOpen)}. 원 단위 정수 표시">${formatExpectedPrice(row.expectedOpen)}</td><td class="${toneClass(row.expectedReturn)}" aria-label="예상 수익률 ${formatExpectedPercent(row.expectedReturn)}. 퍼센트 단위 정수 표시">${formatExpectedPercent(row.expectedReturn)}</td><td>${formatPrice(row.actualOpen)}</td><td>${formatPrice(row.actualClose)}</td><td class="${toneClass(row.actualReturn)}" aria-label="전일 종가 대비 실제 시가 수익률">${formatPercent(row.actualReturn)}</td><td class="${toneClass(row.sessionReturn)}" aria-label="실제 시가 대비 실제 종가 수익률">${formatPercent(row.sessionReturn)}</td><td class="${toneClass(row.error)}">${formatPercent(row.error)}</td><td>${formatNumber(row.actualVolume)}</td><td><span class="row-status ${escapeText(row.status)}">${escapeText(rowStatusLabel(row))}</span></td>`;
    tr.addEventListener("click", () => selectRow(row.symbol));
    tr.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectRow(row.symbol); } });
    elementIds["ranking-body"].append(tr);
    elementIds["ranking-cards"].append(createMobileCard(row));
  });
  elementIds["ranking-table"].hidden = rows.length === 0;
  elementIds["empty-state"].hidden = rows.length !== 0;
}
function selectRow(symbol) { selectedSymbol = symbol; renderRows(); renderSelected(); }
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
  setText(elementIds["selected-expected-return"], formatExpectedPercent(row.expectedReturn));
  setText(elementIds["selected-actual-open"], formatPrice(row.actualOpen));
  setText(elementIds["selected-actual-close"], formatPrice(row.actualClose));
  setText(elementIds["selected-actual-return"], formatPercent(row.actualReturn));
  setText(elementIds["selected-session-return"], formatPercent(row.sessionReturn));
  setText(elementIds["selected-error"], formatPercent(row.error));
  setText(elementIds["selected-confidence"], finite(row.confidence) ? numberFormatter.format(row.confidence) : "—");
  setText(elementIds["selected-quality"], `품질 ${qualityLabel(row.quality)}`);
  setText(elementIds["selected-reasons"], `상태 사유 ${row.reasons?.length ? row.reasons.join(", ") : "기록 없음"}`);
}
function updateClock() { const now = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); setText(elementIds["top-clock"], `KST ${now}`); }
async function refresh() {
  try { renderHeader(await loadSnapshot()); }
  catch (error) { console.error(error); const failed = emptySnapshot("정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요."); failed.status = "blocked"; failed.provider = { status: "blocked", label: "스냅샷 읽기 실패" }; renderHeader(failed); setText(elementIds["notice-detail"], "정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요."); }
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
updateClock();
setInterval(updateClock, 1000);
refresh();
