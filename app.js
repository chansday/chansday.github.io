import { isSnapshot, noDataSnapshot } from "./providers/provider-adapter.js";
import {
  HISTORICAL_TEST_DATES,
  historicalTestRunPath,
  isHistoricalTestSnapshot,
  isLiveNoDataSnapshot,
  markHistoricalTestFallback,
} from "./providers/historical-test-fallback.js";
import { createDemoProvider } from "./providers/demo-provider.js";

const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const integerFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

const stateLabels = {
  ready: "정상", valid: "검증됨", partial: "부분 결과", degraded: "품질 저하", no_data: "데이터 없음",
  pending: "대기", blocked: "차단됨", not_configured: "미설정", demo: "테스트",
};
const rowStateLabels = { valid: "검증됨", pending: "대기", degraded: "품질 저하", blocked: "차단됨", no_data: "데이터 없음", demo: "테스트" };
const stateMessages = {
  ready: "검증된 데이터 스냅샷을 표시하고 있습니다.",
  no_data: "실제 가격·예측값·신뢰도를 임의로 생성하지 않고 데이터 없음 상태로 표시합니다.",
  degraded: "일부 데이터가 지연되거나 품질 기준을 통과하지 못했습니다.",
  partial: "부분 결과입니다. 정상 랭킹으로 해석하지 않습니다.",
  pending: "아직 처리되지 않은 단계입니다.",
  blocked: "데이터 공급자 또는 검증 조건이 준비되지 않았습니다.",
  demo: "DEMO 모드입니다. 금융 실측값이 아닌 UI 계약 확인용입니다.",
  fixture: "FIXTURE 모드입니다. 실제 금융 데이터가 아닌 합성값입니다.",
  replay: "BASELINE REPLAY입니다. 실제 과거 예측이 아닌 합성 시뮬레이션입니다.",
  backfill_test: "TEST ONLY / BACKFILL입니다. 실제 금융 데이터나 과거 예측 성과가 아닙니다.",
  historical: "HISTORICAL-TEST / TEST ONLY · 공개 일봉 모멘텀·변동성 baseline입니다. 장전 호가가 없어 당시 08:20 예측 성과를 주장하지 않습니다.",
};
const historicalFallbackLabel = "TEST ONLY · HISTORICAL BASELINE · NOT LIVE";
const historicalFallbackContract = "isLiveNoDataSnapshot(data) / historical_fallback_source";
const historicalTestDataRoot = "data/runs/historical-test";
const elementIds = [
  "mode-badge", "data-purpose", "global-status", "status-message", "as-of-date", "published-at", "row-count", "provider-label", "top-clock", "refresh-button",
  "quality-ribbon", "quality-ribbon-label", "quality-ribbon-text", "truth-label", "truth-note-text", "summary-expected", "summary-expected-detail", "summary-actual", "summary-actual-detail", "summary-error", "summary-error-detail", "summary-scope", "summary-scope-detail",
  "kpi-market", "kpi-market-note", "kpi-market-bar", "kpi-universe", "kpi-valid", "kpi-accuracy", "kpi-accuracy-note", "kpi-model", "kpi-model-note", "kpi-model-time", "kpi-model-quality", "table-state", "table-count", "ranking-table", "ranking-body", "ranking-cards", "empty-state", "empty-state-note", "search-input", "status-filter", "sort-select",
  "selected-empty", "selected-content", "selected-detail-hint", "selected-symbol", "selected-name", "selected-status", "selected-expected-open", "selected-expected-close", "selected-expected-return", "selected-actual-open", "selected-actual-return", "selected-error", "selected-confidence", "selected-quality", "selected-reasons",
  "source-name", "source-url", "source-license", "evaluation-scope", "data-timestamp", "snapshot-date", "source-collection", "source-range", "model-name", "baseline-input", "model-note", "limit-title", "quality-summary", "quality-source", "data-notice", "notice-title", "notice-detail", "footer-status",
].reduce((result, id) => ({ ...result, [id]: document.getElementById(id) }), {});

let snapshot = null;
let selectedSymbol = null;

function setText(node, value) { if (node) node.textContent = value; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function valueOf(row, ...keys) { for (const key of keys) if (row?.[key] !== undefined) return row[key]; return null; }
function normalizeStatus(status) { return String(status || "no_data").toLowerCase().replaceAll("-", "_"); }
function formatPrice(value) { return finite(value) ? `${numberFormatter.format(value)}원` : "—"; }
function formatPercent(value) { return finite(value) ? `${value > 0 ? "+" : ""}${numberFormatter.format(value)}%` : "—"; }
function formatExpectedPrice(value) { return finite(value) ? `${integerFormatter.format(Math.round(value))}원` : "—"; }
function formatExpectedPercent(value) { return finite(value) ? `${value > 0 ? "+" : ""}${integerFormatter.format(Math.round(value))}%` : "—"; }
function formatNumber(value) { return finite(value) ? integerFormatter.format(value) : "—"; }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date).replaceAll(". ", "."); }
function formatTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${timeFormatter.format(date).replaceAll(". ", ".")} KST`; }
function formatShortTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} KST`; }
function statusClass(status) { const key = normalizeStatus(status); if (["ready", "valid"].includes(key)) return "status-valid"; if (["degraded", "partial", "pending"].includes(key)) return `status-${key}`; if (key === "blocked") return "status-blocked"; return "status-muted"; }
function escapeText(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function isHistorical(data) { return data?.mode === "historical_test" || data?.provider?.id === "historical-test" || data?.meta?.historical_test === true; }
function isSynthetic(data) { return ["fixture", "replay", "backfill_test"].includes(data?.mode) || ["fixture", "replay_baseline", "backfill-test"].includes(data?.provider?.id); }
function isTestOnlySnapshot(data) { return Boolean(data?.meta?.test_only || data?.meta?.historical_test || data?.meta?.backfill || isHistorical(data) || isSynthetic(data)); }
const isTestOnly = isTestOnlySnapshot;

function testLabel(data) {
  if (data?.meta?.historical_fallback === true || data?.meta?.fallback_from_no_data) return historicalFallbackLabel;
  if (isHistorical(data)) return "HISTORICAL-TEST / TEST ONLY";
  if (data?.mode === "backfill_test") return "TEST ONLY / BACKFILL";
  if (data?.mode === "replay") return "TEST ONLY / BASELINE REPLAY";
  if (data?.mode === "fixture") return "TEST ONLY / FIXTURE";
  return "TEST ONLY";
}

function normalizeRow(row, index) {
  const rawStatus = normalizeStatus(row?.status || row?.eligibility?.status || "no_data");
  return {
    rank: valueOf(row, "rank") ?? index + 1,
    symbol: valueOf(row, "symbol", "code", "instrument_id") || "—",
    name: valueOf(row, "name", "instrument_name") || "종목명 미정",
    expectedOpen: valueOf(row, "expected_open"), expectedClose: valueOf(row, "expected_close"), expectedReturn: valueOf(row, "expected_return"),
    actualOpen: valueOf(row, "actual_open"), actualClose: valueOf(row, "actual_close"), actualReturn: valueOf(row, "actual_return"), actualVolume: valueOf(row, "actual_volume"),
    error: valueOf(row, "error"), confidence: valueOf(row, "confidence", "confidence_score"), quality: valueOf(row, "quality", "quality_status") || rawStatus,
    reasons: row?.eligibility?.reasons || row?.reasons || [], status: rawStatus === "ready" ? "valid" : rawStatus,
  };
}
function emptySnapshot(message = "연결된 데이터 공급자가 없습니다.") { return noDataSnapshot({ provider: { id: null, status: "not_configured", label: "연결된 데이터 공급자 없음", source: null }, message }); }
function validateRequestedDate(date, label) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} date is invalid`); return date; }
async function fetchSnapshot(path, errorLabel) { const response = await fetch(path, { cache: "no-store" }); if (!response.ok) throw new Error(`${errorLabel}: ${response.status}`); return response.json(); }

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
function rowStatusLabel(row) { if (isHistorical(snapshot)) return row.status === "valid" ? "검증됨" : (rowStateLabels[row.status] || row.status); return rowStateLabels[row.status] || row.quality || row.status; }
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
  const label = fallback ? historicalFallbackLabel : historical ? "HISTORICAL-TEST / TEST ONLY" : isTestOnly(data) ? testLabel(data) : status === "ready" ? "운영 스냅샷" : "평가 대기";
  const expectedText = historical ? "사후 baseline" : rows.some((row) => finite(row.expectedReturn)) ? "예상값 기록" : "예상값 없음";
  const actualText = settled.length ? "09:00 시가 정산" : "정산 대기";
  const scopeText = historical ? "KOSPI 전체 행" : rows.length ? "현재 표시 행" : "평가 대기";
  setText(elementIds["truth-label"], label);
  setText(elementIds["data-purpose"], historical ? "사후 계산된 비교용 baseline" : isTestOnly(data) ? "테스트 전용 산출값" : status === "ready" ? "운영 스냅샷" : "운영 데이터 대기");
  setText(elementIds["summary-expected"], expectedText);
  setText(elementIds["summary-expected-detail"], historical ? `직전 ${data?.baseline?.lookback_sessions || 5}개 거래일 종가 · 장전 호가 없음` : "장전 기준값이 있는 행");
  setText(elementIds["summary-actual"], actualText);
  setText(elementIds["summary-actual-detail"], settled.length ? `${formatNumber(settled.length)}개 행의 실제 시가` : "09:00 정규장 공식 시작가");
  setText(elementIds["summary-error"], meanError === null ? "—" : `${numberFormatter.format(meanError)}%`);
  setText(elementIds["summary-error-detail"], meanError === null ? "오차 산출을 위한 정산 대기" : `평균 절대오차 · 표본 ${formatNumber(settled.length)}개`);
  setText(elementIds["summary-scope"], scopeText);
  setText(elementIds["summary-scope-detail"], rows.length ? `평가 표본 ${formatNumber(settled.length)} / 전체 ${formatNumber(rows.length)}개` : "표시할 행이 없습니다.");
  setText(elementIds["truth-note-text"], historical ? "HISTORICAL TEST / TEST ONLY입니다. 당시 08:20에 게시된 예측이 아니며, 과거 예측 성과나 수익을 보장하지 않습니다." : isTestOnly(data) ? "TEST ONLY입니다. 합성·재생·backfill 값은 금융 실측값이나 예측 성과가 아닙니다." : stateMessages[status] || stateMessages.no_data);
}
function renderRibbon(data, status) {
  const historicalFallback = data?.meta?.historical_fallback === true;
  const show = Boolean(historicalFallback || data?.meta?.fallback_from_no_data || (isTestOnly(data) && status !== "no_data"));
  elementIds["quality-ribbon"].hidden = !show;
  if (!show) return;
  setText(elementIds["quality-ribbon-label"], historicalFallback ? historicalFallbackLabel : testLabel(data));
  setText(elementIds["quality-ribbon-text"], historicalFallback ? `${historicalFallbackLabel} — live provider가 no_data일 때만 선택한 historical-test 원본입니다. 숫자를 합성하지 않았습니다.` : data?.meta?.fallback_from_no_data ? "운영 snapshot이 no_data여서 과거 공개 일봉 기준선을 표시합니다. 실전 데이터로 해석하지 마세요." : stateMessages[isHistorical(data) ? "historical" : data?.mode] || "테스트 전용 산출값입니다. 금융 실측값이나 예측 성과로 해석하지 마세요.");
  if (historicalFallback) {
    setStatusPill(elementIds["mode-badge"], "pending", historicalFallbackLabel);
    setText(elementIds["global-status"], historicalFallbackLabel);
    setText(elementIds["status-message"], `${historicalFallbackLabel} — live provider 상태 ${data?.meta?.live_snapshot_status || "no_data"}에 대한 테스트 fallback입니다.`);
  }
}
function renderKpis(data, rows, status) {
  const validRows = rows.filter((row) => row.status === "valid");
  const { settled, meanError } = evaluationStats(rows);
  const baseline = data?.baseline || {};
  const model = baseline.model || data?.meta?.model || data?.model?.name || "미설정";
  const quality = isHistorical(data) ? "historical baseline" : data?.meta?.source?.license_status || data?.provider?.status || "—";
  setText(elementIds["kpi-market"], isHistorical(data) ? "테스트 전용" : (stateLabels[status] || status));
  setText(elementIds["kpi-market-note"], data?.provider?.label || stateMessages[status] || stateMessages.no_data);
  elementIds["kpi-market"].className = `kpi-value ${statusClass(isHistorical(data) ? "pending" : status)}`;
  elementIds["kpi-market-bar"].style.width = status === "ready" ? (isHistorical(data) ? "72%" : "100%") : "12%";
  setText(elementIds["kpi-universe"], formatNumber(rows.length));
  setText(elementIds["kpi-valid"], formatNumber(validRows.length));
  setText(elementIds["kpi-accuracy"], meanError === null ? "—" : `${numberFormatter.format(meanError)}%`);
  setText(elementIds["kpi-accuracy-note"], settled.length ? `정산 표본 ${formatNumber(settled.length)}개` : "정산 표본 대기");
  setText(elementIds["kpi-model"], model);
  setText(elementIds["kpi-model-note"], baseline.value_status || (isHistorical(data) ? "사후 계산 · 장전 호가 없음" : "baseline/model 메타데이터 없음"));
  setText(elementIds["kpi-model-time"], formatShortTime(data?.publishedAt || data?.meta?.lastAttemptAt));
  setText(elementIds["kpi-model-quality"], quality);
}
function renderProvenance(data, source, status) {
  const baseline = data?.baseline || {};
  const model = baseline.model || data?.meta?.model || data?.model?.name || "미설정";
  const historical = isHistorical(data);
  const sourceRows = data?.meta?.source_rows || data?.rows?.length || 0;
  const range = historical ? "KOSPI 공개 원본 행 전체" : data?.meta?.source_range || (sourceRows ? `${formatNumber(sourceRows)}개 행` : "—");
  const limitation = historical ? "장전 호가·예상체결가·호가잔량 없음" : data?.status === "no_data" ? "데이터 없음 · 숫자를 만들지 않음" : "결측·지연·품질 상태 공개";
  setText(elementIds["source-name"], source?.name || data?.provider?.label || "출처 미연결");
  setText(elementIds["source-license"], source?.license_status ? `라이선스: ${source.license_status}` : "라이선스 상태 —");
  const urlNode = elementIds["source-url"];
  if (source?.url) { urlNode.textContent = "원천 파일 열기 ↗"; urlNode.href = source.url; urlNode.removeAttribute("aria-disabled"); } else { urlNode.textContent = "원천 파일 링크 —"; urlNode.href = "#"; urlNode.setAttribute("aria-disabled", "true"); }
  setText(elementIds["evaluation-scope"], historical ? "KOSPI 전체 공개 행" : status === "ready" ? "운영 스냅샷 행" : "평가 대기");
  setText(elementIds["snapshot-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["source-collection"], data?.meta?.source_collection_date || formatDate(source?.retrieved_at));
  setText(elementIds["source-range"], range);
  setText(elementIds["model-name"], model);
  setText(elementIds["baseline-input"], historical ? `공개 일봉 momentum + volatility · ${baseline.input_through_date || "기준일 미상"}` : "연결된 provider 기준");
  setText(elementIds["model-note"], baseline.note || (historical ? "당시 08:20 예측이 아닌 사후 재현 가능한 baseline" : `예상 기준 상태: ${model === "미설정" ? "미설정" : status}`));
  setText(elementIds["limit-title"], historical ? "장전 입력 없음" : "NO FABRICATED VALUES");
  setText(elementIds["quality-summary"], historical ? `${limitation}. expected 값은 실제 과거 예측이 아닙니다.` : stateMessages[status] || stateMessages.no_data);
  setText(elementIds["quality-source"], `${source?.name || data?.provider?.label || "출처 미연결"} · 갱신 ${formatShortTime(data?.publishedAt || data?.meta?.lastAttemptAt)}`);
  setText(elementIds["data-timestamp"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
}
function renderHeader(data) {
  const status = normalizeStatus(data?.status);
  const rows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
  const source = data?.meta?.source || data?.provider?.source || null;
  const test = isTestOnly(data);
  const historical = isHistorical(data);
  const fallback = data?.meta?.historical_fallback === true;
  const statusText = fallback ? historicalFallbackLabel : historical ? "HISTORICAL-TEST / TEST ONLY" : stateLabels[status] || status;
  document.documentElement.dataset.status = status;
  snapshot = { ...data, rows };
  if (!selectedSymbol || !rows.some((row) => row.symbol === selectedSymbol)) selectedSymbol = rows[0]?.symbol || null;
  setStatusPill(elementIds["mode-badge"], historical || test ? "pending" : status, statusText);
  setText(elementIds["global-status"], fallback ? historicalFallbackLabel : historical ? "HISTORICAL TEST" : status === "ready" ? "시장 데이터 연결" : status === "demo" ? "테스트 모드" : status === "no_data" ? "데이터 대기" : statusText);
  setText(elementIds["status-message"], data?.meta?.fallback_from_no_data ? "운영 snapshot이 no_data여서 historical-test 기준선을 표시합니다." : historical ? stateMessages.historical : stateMessages[data?.mode] || stateMessages[status] || stateMessages.no_data);
  setText(elementIds["as-of-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(elementIds["published-at"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
  setText(elementIds["row-count"], formatNumber(rows.length));
  setText(elementIds["provider-label"], data?.provider?.label || "미연결");
  setText(elementIds["table-state"], test ? testLabel(data) : stateLabels[status] || status);
  setText(elementIds["table-count"], `${formatNumber(rows.length)}개 행`);
  setText(elementIds["footer-status"], `${statusText} · KST`);
  renderEvaluationSummary(data, rows, status);
  renderRibbon(data, status);
  renderKpis(data, rows, status);
  renderPipeline(data);
  renderProvenance(data, source, status);
  elementIds["data-notice"].hidden = status === "ready" && !test;
  setText(elementIds["notice-title"], fallback ? `${historicalFallbackLabel} · 운영 데이터가 아닙니다.` : historical ? "HISTORICAL-TEST · 실제 과거 08:20 예측이 아닙니다." : status === "no_data" ? "데이터 없음 · 숫자를 만들지 않습니다." : `${statusText} · 데이터 상태를 확인하세요.`);
  setText(elementIds["notice-detail"], fallback ? `latest-snapshot.json의 no_data 상태에서만 선택되는 fallback입니다. ${historicalFallbackContract}.` : historical ? stateMessages.historical : stateMessages[status] || stateMessages.no_data);
  setText(elementIds["empty-state-note"], status === "no_data" ? "데이터 공급자가 연결되면 검증된 행이 이곳에 표시됩니다." : "검색 또는 필터 조건과 일치하는 행이 없습니다.");
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
  card.innerHTML = `<div class="ranking-card-head"><span class="ranking-card-rank">#${escapeText(row.rank)}</span><strong class="ranking-card-name">${escapeText(row.name)}</strong><span class="ranking-card-code">${escapeText(row.symbol)}</span></div><span class="row-status ${escapeText(row.status)} ranking-card-status">${escapeText(rowStatusLabel(row))}</span><div class="ranking-card-metrics">${rowMetric("예상 시가 · 정수 원", formatExpectedPrice(row.expectedOpen))}${rowMetric("예상 종가 · 정수 원", formatExpectedPrice(row.expectedClose))}${rowMetric("예상 수익률 · 정수 %", formatExpectedPercent(row.expectedReturn), toneClass(row.expectedReturn))}${rowMetric("실제 시가", formatPrice(row.actualOpen))}${rowMetric("실제 수익률", formatPercent(row.actualReturn), toneClass(row.actualReturn))}${rowMetric("오차", formatPercent(row.error), toneClass(row.error))}${rowMetric("거래량", formatNumber(row.actualVolume))}</div>`;
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
    tr.innerHTML = `<td>${escapeText(row.rank)}</td><td><strong class="instrument-name">${escapeText(row.name)}</strong><span class="instrument-code">${escapeText(row.symbol)}</span></td><td aria-label="예상 시가 ${formatExpectedPrice(row.expectedOpen)}. 원 단위 정수 표시">${formatExpectedPrice(row.expectedOpen)}</td><td class="${toneClass(row.expectedReturn)}" aria-label="예상 수익률 ${formatExpectedPercent(row.expectedReturn)}. 퍼센트 단위 정수 표시">${formatExpectedPercent(row.expectedReturn)}</td><td>${formatPrice(row.actualOpen)}</td><td class="${toneClass(row.actualReturn)}">${formatPercent(row.actualReturn)}</td><td class="${toneClass(row.error)}">${formatPercent(row.error)}</td><td>${formatNumber(row.actualVolume)}</td><td><span class="row-status ${escapeText(row.status)}">${escapeText(rowStatusLabel(row))}</span></td>`;
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
  setText(elementIds["selected-actual-return"], formatPercent(row.actualReturn));
  setText(elementIds["selected-error"], formatPercent(row.error));
  setText(elementIds["selected-confidence"], finite(row.confidence) ? numberFormatter.format(row.confidence) : "—");
  setText(elementIds["selected-quality"], `품질 ${row.quality || "—"}`);
  setText(elementIds["selected-reasons"], `상태 사유 ${row.reasons?.length ? row.reasons.join(", ") : "기록 없음"}`);
}
function updateClock() { const now = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); setText(elementIds["top-clock"], `KST ${now}`); }
async function refresh() {
  try { renderHeader(await loadSnapshot()); }
  catch (error) { console.error(error); const failed = emptySnapshot("정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요."); failed.status = "blocked"; failed.provider = { status: "blocked", label: "스냅샷 읽기 실패" }; renderHeader(failed); setText(elementIds["notice-detail"], "정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요."); }
}

elementIds["search-input"].addEventListener("input", renderRows);
elementIds["status-filter"].addEventListener("change", renderRows);
elementIds["sort-select"].addEventListener("change", renderRows);
elementIds["refresh-button"].addEventListener("click", refresh);
updateClock();
setInterval(updateClock, 1000);
refresh();
