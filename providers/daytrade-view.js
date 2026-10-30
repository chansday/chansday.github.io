// 단타 패널: the day's 09:00 picks (data/daytrade/D.json), their recorded
// results (ledger.json) and the walk-forward backtest (backtest.json).
// Rendered with textContent only; every file is optional.
const escapeNode = (tag, text, className) => { const el = document.createElement(tag); if (className) el.className = className; el.textContent = text; return el; };
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—");
const share = (v) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");
const tone = (v) => (typeof v === "number" && v > 0 ? "daytrade-up" : typeof v === "number" && v < 0 ? "daytrade-down" : "");

async function readOptional(path) {
  try { const response = await fetch(path, { cache: "no-store" }); return response.ok ? await response.json() : null; } catch { return null; }
}

function table(headers, rows) {
  const t = document.createElement("table"), head = t.createTHead().insertRow(), body = t.createTBody();
  headers.forEach((h) => head.appendChild(escapeNode("th", h)));
  for (const cells of rows) { const tr = body.insertRow(); cells.forEach(([text, className]) => tr.appendChild(escapeNode("td", text, className))); }
  return t;
}

let token = 0;
export async function renderDaytrade(date) {
  const root = document.getElementById("daytrade");
  if (!root) return;
  const mine = ++token;
  const [day, ledger, backtest] = await Promise.all([/^\d{4}-\d{2}-\d{2}$/.test(date || "") ? readOptional(`data/daytrade/${date}.json`) : null, readOptional("data/daytrade/ledger.json"), readOptional("data/daytrade/backtest.json")]);
  if (mine !== token) return;
  const picks = document.getElementById("daytrade-picks"), status = document.getElementById("daytrade-status"), record = document.getElementById("daytrade-record"), tested = document.getElementById("daytrade-backtest");
  picks.replaceChildren(); record.replaceChildren(); tested.replaceChildren();
  if (day?.picks?.length) {
    const r = day.result;
    status.textContent = `${date} 09:00 시가 기준 · ${day.scored}종목 채점 · 시장 시가 갭 ${pct(day.market_gap)} · 거래대금 ${Math.round(day.assumptions.min_turnover_krw / 1e8)}억 원 이상 상위 ${day.picks.length}종목${r ? ` · 결과: 비용 ${day.assumptions.round_trip_cost_pct}% 차감 평균 ${pct(r.net_return)}, 오른 종목 ${share(r.win_rate)}, 시장 평균 ${pct(r.market_return)}` : " · 결과는 15:30 정산 후 기록"}`;
    picks.appendChild(table(["순위", "종목", "시가 갭", "예상 종가", "예상 고가", "예상 저가", ...(r ? ["실제 종가", "실제 고가", "실제 저가"] : [])],
      day.picks.map((p) => [[String(p.rank)], [`${p.name} ${p.symbol}`], [pct(p.open_gap), tone(p.open_gap)], [pct(p.expected_close), tone(p.expected_close)], [pct(p.expected_high)], [pct(p.expected_low)],
        ...(r ? [[pct(p.actual_close), tone(p.actual_close)], [pct(p.actual_high)], [pct(p.actual_low)]] : [])])));
  } else status.textContent = `${date || "선택한 날짜"}의 단타 점수가 없습니다. 09:00 시가 정산 후 기록되며, 모델이 학습된 날부터 표시됩니다.`;
  const days = ledger?.days || [];
  if (days.length) {
    const net = days.map((d) => d.net_return).filter(Number.isFinite), equity = net.reduce((e, v) => e * (1 + v / 100), 1);
    record.appendChild(escapeNode("p", `운영 기록 ${days.length}일 · 일평균 ${pct(net.reduce((s, v) => s + v, 0) / (net.length || 1))} · 누적 ${pct((equity - 1) * 100)} · 이긴 날 ${share(net.filter((v) => v > 0).length / (net.length || 1))}`));
    record.appendChild(table(["날짜", "비용 후 평균", "오른 종목", "시장 평균"], days.slice(-10).reverse().map((d) => [[d.date], [pct(d.net_return), tone(d.net_return)], [share(d.win_rate)], [pct(d.market_return), tone(d.market_return)]])));
  }
  if (backtest?.strategies) {
    tested.appendChild(escapeNode("p", `백테스트 ${backtest.period.first}~${backtest.period.last} · 시가 매수→종가 매도 · 상위 ${backtest.assumptions.top_n} 균등 · 왕복 비용 ${backtest.assumptions.round_trip_cost_pct}% · 과거 성과는 미래 수익을 보장하지 않습니다.`));
    tested.appendChild(table(["전략", "일수", "일평균(비용 후)", "t값", "시장 대비", "이긴 날", "누적", "최대 낙폭", "순위 IC"],
      Object.values(backtest.strategies).filter((s) => s.summary).map(({ label, summary: s }) => [[label], [String(s.days)], [pct(s.mean_net_return), tone(s.mean_net_return)], [String(s.t_net ?? "—")], [pct(s.mean_excess_vs_market), tone(s.mean_excess_vs_market)], [share(s.winning_days)], [pct(s.cumulative_return), tone(s.cumulative_return)], [pct(s.max_drawdown)], [s.mean_ic === null ? "—" : s.mean_ic.toFixed(3)]])));
  }
  root.hidden = false;
}
