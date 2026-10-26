import { isSnapshot, noDataSnapshot } from "./providers/provider-adapter.js";
import { createDemoProvider } from "./providers/demo-provider.js";

const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const stateLabels = { ready: "검증됨", valid: "valid", degraded: "degraded", no_data: "no_data", pending: "pending", blocked: "blocked", not_configured: "미연결", demo: "demo" };
const stateMessages = {
  ready: "검증된 데이터 스냅샷을 표시하고 있습니다.",
  no_data: "실제 가격·예측값·신뢰도를 임의로 생성하지 않고 no_data 상태로 표시합니다.",
  degraded: "일부 데이터가 지연되거나 품질 기준을 통과하지 못해 degraded 상태로 표시합니다.",
  pending: "아직 처리되지 않은 단계입니다. 결과가 게시되면 상태가 갱신됩니다.",
  blocked: "데이터 공급자 또는 검증 조건이 준비되지 않아 업데이트가 보류되었습니다.",
  demo: "DEMO 모드입니다. 금융 실측값이 아닌 UI 계약 확인용 상태입니다.",
  fixture: "FIXTURE 모드입니다. 합성값만 표시하며 실제 금융 데이터나 08:30 예측을 재구성한 결과가 아닙니다."
};

const el = Object.fromEntries(["mode-badge", "global-status", "status-message", "as-of-date", "published-at", "row-count", "provider-label", "snapshot-date", "provider-status", "provider-detail", "notice-title", "notice-detail", "data-notice", "table-state", "ranking-body", "empty-state", "footer-status", "top-clock", "search-input", "status-filter", "sort-select", "refresh-button", "ranking-table"].map((id) => [id, document.getElementById(id)]));
let snapshot = null;

function setText(node, value) { if (node) node.textContent = value; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function valueOf(row, ...keys) { for (const key of keys) if (row?.[key] !== undefined) return row[key]; return null; }
function formatPrice(value, isFixture = false) { return finite(value) ? `${isFixture ? "SYN " : ""}${numberFormatter.format(value)}${isFixture ? "" : "원"}` : "—"; }
function formatPercent(value, isFixture = false) { return finite(value) ? `${isFixture ? "SYN " : ""}${value > 0 ? "+" : ""}${numberFormatter.format(value)}%` : "—"; }
function formatConfidence(value) { return finite(value) ? numberFormatter.format(value) : "—"; }
function formatDate(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : dateFormatter.format(d).replaceAll(". ", "."); }
function formatTime(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : `${timeFormatter.format(d)} KST`; }
function normalizeStatus(status) { return String(status || "no_data").toLowerCase().replaceAll("-", "_"); }
function statusBadgeClass(status) { const key = normalizeStatus(status); return ["ready", "valid"].includes(key) ? "badge-ready" : ["degraded", "pending"].includes(key) ? `badge-${key}` : ["blocked"].includes(key) ? "badge-error" : "badge-muted"; }

function normalizeRow(row, index) {
  const rawStatus = normalizeStatus(row?.status || row?.eligibility?.status || "no_data");
  const status = rawStatus === "ready" ? "valid" : rawStatus;
  return {
    rank: valueOf(row, "rank") ?? index + 1,
    symbol: valueOf(row, "symbol", "code", "instrument_id") || "—",
    name: valueOf(row, "name", "instrument_name") || "종목명 미정",
    expectedOpen: valueOf(row, "expected_open"),
    expectedClose: valueOf(row, "expected_close"),
    expectedReturn: valueOf(row, "expected_return"),
    actualOpen: valueOf(row, "actual_open"),
    actualClose: valueOf(row, "actual_close"),
    actualReturn: valueOf(row, "actual_return"),
    error: valueOf(row, "error"),
    confidence: valueOf(row, "confidence", "confidence_score"),
    quality: valueOf(row, "quality", "quality_status") || status,
    status,
  };
}

function demoSnapshot() { return createDemoProvider().getSnapshot(); }

function emptySnapshot() { return noDataSnapshot({ provider: { id: null, status: "not_configured", label: "연결된 데이터 공급자 없음", source: null }, message: "No market data provider is configured." }); }

async function loadSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("mode")?.toLowerCase();
  if (requestedMode === "demo") return demoSnapshot();
  if (requestedMode === "fixture") {
    const fixtureDate = params.get("date") || "2026-10-23";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fixtureDate)) throw new Error("Fixture date is invalid");
    const response = await fetch(`./data/fixtures/${encodeURIComponent(fixtureDate)}.json`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
    const fixture = await response.json();
    if (!isSnapshot(fixture) || fixture.mode !== "fixture" || fixture.meta?.isDemo !== true) throw new Error("Fixture snapshot shape is invalid");
    return fixture;
  }
  const response = await fetch("./data/latest-snapshot.json", { cache: "no-store" });
  if (response.status === 404) return emptySnapshot();
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  const data = await response.json();
  if (!isSnapshot(data)) throw new Error("Snapshot shape is invalid");
  return data;
}

function renderPipeline(data) {
  const pipeline = data?.pipeline || {};
  const steps = { previousResult: pipeline.previousResult, analysis: pipeline.analysis, forecast: pipeline.forecast, closeSettlement: pipeline.closeSettlement || { status: "pending" } };
  document.querySelectorAll(".pipeline-step[data-step]").forEach((card) => { const state = normalizeStatus(steps[card.dataset.step]?.status || (data?.status === "no_data" ? "no_data" : "pending")); const statusNode = card.querySelector("[data-step-status]"); setText(statusNode, stateLabels[state] || state.toUpperCase()); statusNode.className = `step-status status-${state}`; });
}

function renderHeader(data) {
  const status = normalizeStatus(data?.status || "no_data");
  const providerStatus = normalizeStatus(data?.provider?.status || (data?.mode === "demo" ? "demo" : "not_configured"));
  const isFixture = data?.mode === "fixture" || data?.provider?.id === "fixture";
  const rows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
  const label = stateLabels[status] || status.toUpperCase();
  document.documentElement.dataset.status = status;
  setText(el["mode-badge"], isFixture ? "FIXTURE / SYNTHETIC ONLY" : data?.mode === "demo" ? "DEMO / UI ONLY" : label);
  el["mode-badge"].className = `badge ${statusBadgeClass(status)}`;
  setText(el["global-status"], isFixture ? "FIXTURE 테스트" : status === "ready" ? "데이터 연결됨" : status === "demo" ? "DEMO 모드" : "데이터 대기");
  setText(el["status-message"], isFixture ? stateMessages.fixture : stateMessages[status] || stateMessages.no_data);
  setText(el["as-of-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(el["published-at"], formatTime(data?.publishedAt || data?.meta?.lastAttemptAt));
  setText(el["row-count"], String(rows.length));
  setText(el["provider-label"], data?.provider?.label || "미연결");
  setText(el["snapshot-date"], formatDate(data?.asOfDate || data?.trade_date));
  setText(el["provider-status"], stateLabels[providerStatus] || providerStatus);
  setText(el["provider-detail"], data?.provider?.label || "공개 데이터 공급자 대기");
  setText(el["table-state"], label);
  el["table-state"].className = `badge ${statusBadgeClass(status)}`;
  setText(el["footer-status"], `${label} · KST`);
  setText(el["notice-title"], isFixture ? "합성 fixture를 표시하고 있습니다." : status === "ready" ? "검증된 스냅샷을 표시하고 있습니다." : status === "degraded" ? "일부 데이터의 품질 상태를 확인하세요." : "데이터 공급자가 연결되지 않았습니다.");
  setText(el["notice-detail"], isFixture ? stateMessages.fixture : stateMessages[status] || stateMessages.no_data);
  el["data-notice"]?.toggleAttribute("hidden", status === "ready" && data?.mode !== "demo");
  snapshot = { ...data, rows };
  renderPipeline(data);
  renderRows();
}

function renderRows() {
  const allRows = snapshot?.rows || [];
  const isFixture = snapshot?.mode === "fixture";
  const query = el["search-input"].value.trim().toLowerCase();
  const statusFilter = el["status-filter"].value;
  const sortKey = el["sort-select"].value;
  const rows = allRows.filter((row) => (!query || `${row.symbol} ${row.name}`.toLowerCase().includes(query)) && (statusFilter === "all" || row.status === statusFilter));
  rows.sort((a, b) => { if (sortKey === "name") return a.name.localeCompare(b.name, "ko"); const av = a[sortKey]; const bv = b[sortKey]; if (!finite(av) && !finite(bv)) return 0; if (!finite(av)) return 1; if (!finite(bv)) return -1; return sortKey === "name" ? String(av).localeCompare(String(bv)) : sortKey === "rank" ? av - bv : sortKey === "error" ? Math.abs(av) - Math.abs(bv) : bv - av; });
  el["ranking-body"].replaceChildren();
  rows.forEach((row) => { const tr = document.createElement("tr"); const cells = [row.rank, null, formatPrice(row.expectedOpen, isFixture), formatPrice(row.expectedClose, isFixture), formatPercent(row.expectedReturn, isFixture), formatPrice(row.actualOpen, isFixture), formatPrice(row.actualClose, isFixture), formatPercent(row.actualReturn, isFixture), formatPercent(row.error, isFixture), formatConfidence(row.confidence), null]; const numericValues = [null, null, row.expectedOpen, row.expectedClose, row.expectedReturn, row.actualOpen, row.actualClose, row.actualReturn, row.error, row.confidence, null]; cells.forEach((value, index) => { const td = document.createElement("td"); if (index === 0) { td.className = "rank"; td.textContent = value; } else if (index === 1) { td.className = "instrument"; const strong = document.createElement("strong"); strong.textContent = row.name; const sub = document.createElement("span"); sub.textContent = row.symbol; td.append(strong, sub); } else if (index === 10) { td.className = "status-cell"; const state = document.createElement("span"); state.className = `row-status ${row.status}`; state.textContent = `${row.quality || row.status} · ${stateLabels[row.status] || row.status}`; td.append(state); } else { td.textContent = value; if ([4, 7, 8].includes(index) && finite(numericValues[index])) td.classList.add(numericValues[index] >= 0 ? "positive" : "negative"); } tr.append(td); }); el["ranking-body"].append(tr); });
  el["ranking-table"].hidden = rows.length === 0;
  el["empty-state"].hidden = rows.length !== 0;
}

function updateClock() { const now = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); setText(el["top-clock"], `KST ${now}`); }
async function refresh() { try { renderHeader(await loadSnapshot()); } catch (error) { console.error(error); renderHeader({ status: "blocked", mode: "provider", provider: { status: "blocked", label: "스냅샷 읽기 실패" }, pipeline: {}, rows: [], meta: { lastAttemptAt: null } }); setText(el["notice-detail"], "정적 스냅샷을 읽지 못했습니다. 로컬 HTTP 서버에서 다시 확인해 주세요."); } }

el["search-input"].addEventListener("input", renderRows); el["status-filter"].addEventListener("change", renderRows); el["sort-select"].addEventListener("change", renderRows); el["refresh-button"].addEventListener("click", refresh); updateClock(); setInterval(updateClock, 1000); refresh();
