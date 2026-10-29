import { isDailyExperiment } from "./daily-experiment-contract.js";
let currentToken = 0;
let saved = [];
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "—";
function showRows() {
  const container = document.getElementById("daily-experiment-results");
  const query = document.getElementById("daily-experiment-search").value.trim().toLowerCase();
  container.replaceChildren();
  for (const record of saved) {
    const heading = document.createElement("h3"); heading.textContent = record.phase === "before-open" ? "장전 실험" : "장중 실험"; container.append(heading);
    const info = document.createElement("p");
    info.textContent = `예측 ${record.predicted_at} · 이력 ${record.history_dates.join(", ")} · 수집 ${record.history_retrieved_at} · ${record.stale ? `지연/누락 ${record.unavailable_dates.join(", ")}` : "최근 확인 이력"} · 공급자 확정 표기, 독립 확인 안 됨 · 최초 발행·수정·조정 여부 및 이용 권리 미확인 · 정산 대기`;
    container.append(info);
    const links = document.createElement("p"); links.append("출처: 한국주식데이터 · 원천 금융위원회/KRX · ");
    record.history_urls.forEach((url, index) => { const a = document.createElement("a"); a.href = url; a.textContent = record.history_dates[index]; a.rel = "noopener noreferrer"; links.append(a, " "); });
    container.append(links);
    const table = document.createElement("table"), caption = document.createElement("caption"), head = document.createElement("thead"), body = document.createElement("tbody"), tr = document.createElement("tr");
    caption.textContent = "종목별 일봉 기준가 실험 결과"; table.append(caption);
    for (const title of ["종목", "추정 기준가", "예상 종가", "기준가 대비 추정 수익률"]) { const th = document.createElement("th"); th.textContent = title; tr.append(th); }
    head.append(tr); table.append(head);
    for (const row of record.rows.filter((r) => `${r.symbol} ${r.name}`.toLowerCase().includes(query))) {
      const line = document.createElement("tr");
      for (const value of [`${row.name} (${row.symbol})`, number(row.reference_price), number(row.estimated_close), row.estimated_return == null ? "—" : `${number(row.estimated_return)}%`]) { const td = document.createElement("td"); td.textContent = value; line.append(td); }
      body.append(line);
    }
    table.append(body); container.append(table);
  }
}
export async function renderDailyExperiments(date) {
  const token = ++currentToken, status = document.getElementById("daily-experiment-status");
  saved = []; showRows();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) { status.textContent = "조회 날짜가 없어 실험 기록을 표시할 수 없습니다."; return; }
  const statusRequest = (async () => {
    try {
      const response = await fetch(`./data/experiments/${date}-status.json`, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) return { readError: true };
      const x = await response.json();
      const reasons = { experimental: ["saved", "updated"], preserved: "existing_forecast_preserved", blocked: ["robots_blocked", "source_blocked"], no_data: "data_unavailable", failed: "collection_error" };
      if (x.schema_version !== 1 || x.target_date !== date || !Object.hasOwn(reasons, x.status) || ![reasons[x.status]].flat().includes(x.reason) || !Number.isFinite(Date.parse(x.attempted_at)) || ![null, "before-open", "during-market"].includes(x.phase)) return { readError: true };
      return x;
    } catch { return { readError: true }; }
  })();
  const records = await Promise.all(["before-open", "during-market"].map(async (phase) => {
    try {
      const response = await fetch(`./data/experiments/${date}-${phase}.json`, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) return { readError: true };
      const x = await response.json();
      if (!isDailyExperiment(x, date, phase)) return { readError: true };
      return x;
    } catch { return { readError: true }; }
  }));
  const latest = await statusRequest;
  if (token !== currentToken) return;
  saved = records.filter((record) => record && !record.readError);
  const error = records.some((record) => record?.readError);
  const labels = { experimental: latest?.reason === "updated" ? "최근 실행: 새 실험으로 갱신" : "최근 실행: 실험 저장", preserved: "최근 실행: 기존 실험 보존", blocked: latest?.reason === "robots_blocked" ? "최근 실행: robots 정책으로 차단" : "최근 실행: 수집 출처 차단", no_data: "최근 실행: 수집 데이터 부족 또는 실행 조건 불충족", failed: "최근 실행: 수집 또는 검증 실패" };
  const last = latest?.readError ? "최근 실행 상태 읽기 오류" : latest ? `${labels[latest.status]} (${latest.attempted_at})` : "실행 상태 기록 없음 (미실행 또는 상태 기록 누락)";
  status.textContent = `${date} 실험 기록 ${saved.length}개 · ${last}${error ? " · 일부 실험 기록 읽기 오류" : ""} · 실제 시세 및 정산 아님`;
  showRows();
}
document.getElementById("daily-experiment-search").addEventListener("input", showRows);
const dateInput = document.getElementById("daily-experiment-date");
dateInput.value = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
dateInput.addEventListener("change", () => renderDailyExperiments(dateInput.value));
renderDailyExperiments(dateInput.value);
