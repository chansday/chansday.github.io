import { isSnapshot } from "./providers/provider-adapter.js";
import { createDemoProvider } from "./providers/demo-provider.js";

const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

const STATUS_LABELS = {
  ready: "READY",
  demo: "DEMO",
  no_data: "NO DATA",
  blocked: "BLOCKED",
  pending: "PENDING",
  not_configured: "NOT CONNECTED",
};

const STATUS_MESSAGES = {
  no_data: "실제 가격이나 예측 성과를 임의로 채우지 않고, 연결 대기 상태를 표시합니다.",
  demo: "DEMO 모드입니다. 화면과 스키마 확인용이며 금융 실측값이나 예측 성과를 의미하지 않습니다.",
  blocked: "데이터 공급자 또는 검증 조건이 준비되지 않아 업데이트가 보류되었습니다.",
  ready: "검증된 데이터 스냅샷을 표시하고 있습니다.",
};

const elements = {
  globalStatus: document.querySelector("#global-status"),
  modeBadge: document.querySelector("#mode-badge"),
  asOfDate: document.querySelector("#as-of-date"),
  rowCount: document.querySelector("#row-count"),
  providerStatus: document.querySelector("#provider-status"),
  providerLabel: document.querySelector("#provider-label"),
  lastUpdated: document.querySelector("#last-updated"),
  snapshotLabel: document.querySelector("#snapshot-label"),
  dataNotice: document.querySelector("#data-notice"),
  dataNoticeDetail: document.querySelector("#data-notice-detail"),
  tableState: document.querySelector("#table-state"),
  rankingTable: document.querySelector("#ranking-table"),
  rankingBody: document.querySelector("#ranking-body"),
  emptyState: document.querySelector("#empty-state"),
  footerStatus: document.querySelector("#footer-status"),
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status || "NO DATA").replaceAll("_", " ").toUpperCase();
}

function formatPrice(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${numberFormatter.format(value)}원` : "—";
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${numberFormatter.format(value)}%`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTimestamp(value) {
  if (!value) return "업데이트 대기";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "업데이트 대기";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll(". ", ".");
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function createCell(text, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.append(createCell(row.rank ?? "—", "rank-cell"));

  const symbolCell = document.createElement("td");
  symbolCell.className = "symbol-cell";
  const symbol = document.createElement("strong");
  symbol.textContent = row.symbol || "—";
  const name = document.createElement("span");
  name.textContent = row.name || "종목명 미정";
  symbolCell.append(symbol, name);
  tr.append(symbolCell);

  tr.append(
    createCell(formatPrice(row.expectedOpen)),
    createCell(formatPrice(row.expectedClose)),
    createCell(formatPercent(row.expectedReturn), typeof row.expectedReturn === "number" && row.expectedReturn >= 0 ? "positive" : ""),
    createCell(formatPrice(row.actualOpen)),
    createCell(formatPrice(row.actualClose)),
    createCell(formatPercent(row.actualReturn), typeof row.actualReturn === "number" && row.actualReturn >= 0 ? "positive" : ""),
    createCell(formatPercent(row.error), typeof row.error === "number" && row.error >= 0 ? "positive" : "negative"),
  );
  return tr;
}

function renderRows(rows) {
  elements.rankingBody.replaceChildren();
  const hasRows = rows.length > 0;
  elements.rankingTable.hidden = !hasRows;
  elements.emptyState.hidden = hasRows;
  if (hasRows) rows.forEach((row) => elements.rankingBody.append(renderRow(row)));
}

function render(snapshot) {
  const status = snapshot.status || "no_data";
  const mode = snapshot.mode || "provider";
  const label = statusLabel(status);
  const providerStatus = snapshot.provider?.status || (mode === "demo" ? "demo" : "not_configured");
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];

  document.documentElement.dataset.mode = mode;
  setText(elements.globalStatus, label);
  setText(elements.modeBadge, mode === "demo" ? "DEMO / UI ONLY" : status === "ready" ? "DATA CONNECTED" : "DATA NOT CONNECTED");
  setText(elements.asOfDate, formatDate(snapshot.asOfDate));
  setText(elements.rowCount, String(rows.length));
  setText(elements.providerStatus, providerStatus === "demo" ? "DEMO" : providerStatus === "ready" ? "연결됨" : "미연결");
  setText(elements.providerLabel, snapshot.provider?.label || "연결된 데이터 공급자 없음");
  setText(elements.lastUpdated, formatTimestamp(snapshot.publishedAt || snapshot.meta?.lastAttemptAt));
  setText(elements.snapshotLabel, snapshot.asOfDate ? `기준일 ${formatDate(snapshot.asOfDate)}` : "스냅샷 미수신");
  setText(elements.tableState, label);
  setText(elements.footerStatus, mode === "demo" ? "DEMO / UI ONLY" : label);
  setText(elements.dataNoticeDetail, STATUS_MESSAGES[status] || STATUS_MESSAGES.no_data);

  elements.modeBadge.className = `status-badge ${mode === "demo" ? "status-badge-demo" : status === "ready" ? "status-badge-ready" : "status-badge-muted"}`;
  elements.dataNotice.hidden = status === "ready" && mode !== "demo";
  renderRows(rows);
}

function renderError(error) {
  console.error(error);
  render({
    status: "blocked",
    mode: "provider",
    provider: { status: "not_configured", label: "스냅샷을 읽을 수 없음" },
    rows: [],
    meta: { lastAttemptAt: null },
  });
  setText(elements.dataNoticeDetail, "정적 스냅샷을 읽지 못했습니다. 로컬 서버에서 다시 확인해 주세요.");
}

async function loadSnapshot() {
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode?.toLowerCase() === "demo") return createDemoProvider().getSnapshot();

  const response = await fetch("./data/latest-snapshot.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  const snapshot = await response.json();
  if (!isSnapshot(snapshot)) throw new Error("Snapshot shape is invalid");
  return snapshot;
}

loadSnapshot().then(render).catch(renderError);

