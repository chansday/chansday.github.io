import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSelectedDetail, DETAIL_DISCLAIMER, RETROSPECTIVE_MODEL_ID } from "../providers/selected-detail.js";
import { mergePostCloseEvaluation } from "../providers/post-close-overlay.js";

const readJson = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const section = (detail, id) => detail.sections.find((entry) => entry.id === id);
const text = (entry) => [...entry.items.map((fact) => `${fact.label} ${fact.value}`), ...entry.sentences, ...entry.missing.map((gap) => `${gap.label} ${gap.reason}`), ...(entry.warnings || [])].join("\n");
const contextOf = (snapshot, extra = {}) => ({ baseline: snapshot.baseline, pipeline: snapshot.pipeline, runStage: snapshot.meta?.run_stage, providerId: snapshot.provider?.id, source: snapshot.meta?.source || snapshot.provider?.source, testOnly: Boolean(snapshot.meta?.test_only), ...extra });

test("historical baseline row explains the stored momentum/volatility calculation in words and numbers", async () => {
  const snapshot = await readJson("data/runs/historical-test/2026-10-23/1530.json");
  const row = snapshot.rows.find((candidate) => candidate.symbol === "003010");
  const detail = buildSelectedDetail(row, contextOf(snapshot));
  const expected = section(detail, "expected");
  const body = text(expected);
  assert.equal(expected.state, "partial");
  assert.match(body, /public_daily_momentum_volatility_v1/);
  assert.match(body, /2026-10-16, 2026-10-19, 2026-10-20, 2026-10-21, 2026-10-22/);
  assert.match(body, /예상 신호 = 0\.6 × 모멘텀 \+11\.341% − 0\.1 × 변동성 11\.4907% = \+5\.66% → 상한 ±5% 적용 → \+5%/);
  assert.match(body, /예상 시가 = 전일 종가 10,860원 × \(1 \+ 5%\) = 11,403원/);
  assert.doesNotMatch(body, /재계산값이 다릅니다/);
  assert.match(body, /당시 08:20에 게시된 예측이 아닙니다/);
  assert.match(body, /예상 종가 이 기준선은 종가를 예측하지 않습니다/);
  assert.match(text(section(detail, "actual")), /실제 장중 수익률 = 실제 종가 9,870원 ÷ 실제 시가 10,200원 − 1 = -3\.24%/);
  assert.equal(section(detail, "error").state, "missing");
  assert.match(text(section(detail, "error")), /예상 수익률 없음/);
  assert.equal(detail.disclaimer, DETAIL_DISCLAIMER);
});

test("retrospective overlay rows show model, history dates, expected-close path and error", async () => {
  const settlement = await readJson("data/runs/2026-10-27/1530.json");
  const record = await readJson("data/runs/2026-10-27/retrospective-40517864324.1.json");
  const merged = mergePostCloseEvaluation(settlement, record);
  const retrospective = { model: record.model, created_at: record.created_at };
  const row = merged.rows.find((candidate) => candidate.symbol === "308170");
  const detail = buildSelectedDetail(row, contextOf(merged, { retrospective }));
  const body = text(section(detail, "expected"));
  assert.equal(record.model, RETROSPECTIVE_MODEL_ID);
  assert.equal(section(detail, "expected").state, "available");
  assert.match(body, /2026-10-26, 2026-10-23, 2026-10-22/);
  assert.match(body, /예상 종가 = 예상 시가 × \(1 \+ 최근 3거래일 평균 장중 수익률, ±5% 제한\) → 3,360\.04원/);
  assert.match(body, /적용된 평균 장중 수익률은 -2\.14%/);
  assert.match(body, /예상 수익률 = 예상 종가 3,360\.04원 ÷ 예상 시가 3,433\.5원 − 1 = -2\.14%/);
  assert.match(body, /장전 예측이 아니며/);
  assert.match(text(section(detail, "error")), /오차 = 실제 장중 수익률 \+30\.77% − 예상 수익률 -2\.14% = \+32\.91%p/);
  assert.match(text(section(detail, "source")), /이용 조건\(라이선스\)이 확인되지 않은 출처/);

  const missingRow = { ...merged.rows.find((candidate) => candidate.symbol === "011155"), retrospective_missing_reason: "insufficient_prior_history" };
  const missingDetail = buildSelectedDetail(missingRow, contextOf(merged, { retrospective }));
  assert.equal(section(missingDetail, "expected").state, "missing");
  assert.match(text(section(missingDetail, "expected")), /직전 3거래일 이력 중 이 종목의 시가·종가·거래량이 빠진 날이 있어 계산하지 않았습니다/);
});

test("operational rows without a stored basis say so and quote the pipeline's own reason", async () => {
  // Shape copied from data/runs/2026-10-28/0820.json (rank 1) so scheduler reruns do not change this test.
  const forecast = {
    provider: { id: "naver-crawl" }, meta: { run_stage: "forecast", source: { license_status: "unconfirmed" } },
    pipeline: { forecast: { status: "ready", message: "Collected 913 fresh Naver intraday quotes; expected_open is the current closePriceRaw quote baseline, not a pre-open forecast. Warning: Source license_status is unconfirmed; operational readiness does not confirm licensing or redistribution rights." }, openSettlement: { status: "pending" }, closeSettlement: { status: "pending" } },
  };
  const row = { rank: 1, symbol: "000020", name: "동화약품", expected_open: 5230, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, session_return: null, intraday_reference_return: 0.58, actual_volume: 72363, prior_close: 5200, error: null, confidence: null, quality: "naver_intraday_quote_baseline", status: "valid", quote_at: "2026-10-28T04:03:10.000Z", quote_age_seconds: 1.22, market_status: "OPEN" };
  const body = text(section(buildSelectedDetail(row, contextOf(forecast)), "expected"));
  assert.match(body, /예상 시가 근거 이 행에는 예상 시가의 계산 근거\(expected_open_source 또는 features\)가 저장되지 않았습니다/);
  assert.match(body, /현재가\(closePriceRaw\) 기준값이며 장전 예측이 아닙니다/);
  assert.match(body, /실행 시점 참고 수익률\(전일 기준가 대비\) \+0\.58%/);

  const latest = await readJson("data/latest-snapshot.json");
  const latestRow = latest.rows.find((candidate) => candidate.expected_open === null);
  if (latestRow && latest.pipeline?.forecast?.status !== "ready") {
    const latestDetail = buildSelectedDetail(latestRow, contextOf(latest));
    assert.equal(section(latestDetail, "expected").state, "missing");
    assert.match(text(section(latestDetail, "expected")), /장전 예상 단계 기록이 포함되지 않았습니다 \(장전 예상 단계 상태: 대기\)/);
  }
});

test("expected_open_source history rows describe the gap calculation without inventing missing figures", () => {
  const row = { symbol: "000001", expected_open: 1010, expected_close: null, prior_close: 1000, actual_open: null, actual_close: null, actual_volume: null, quality: "x",
    expected_open_source: { kind: "preopen_history", recorded_at: "2026-10-28T22:10:00.000Z", history_dates: ["2026-10-28", "2026-10-27", "2026-10-26"] } };
  const detail = buildSelectedDetail(row, { pipeline: { openSettlement: { status: "pending" }, closeSettlement: { status: "pending" } } });
  const body = text(section(detail, "expected"));
  assert.match(body, /장전 공개 일봉 계산/);
  assert.match(body, /2026-10-28, 2026-10-27, 2026-10-26/);
  assert.match(body, /최근 두 번의 시가 갭/);
  assert.match(body, /수치\(expected_open_basis\)가 이 행에 저장되지 않아 표시하지 않습니다/);
  assert.match(text(section(detail, "actual")), /시가 정산\(09:00\) 단계가 '대기' 상태입니다/);
  const all = detail.sections.map(text).join("\n");
  assert.doesNotMatch(all, /매수|매도|추천|목표가|수익 보장/);
  assert.equal(buildSelectedDetail(null), null);
});

test("ranking table scrolls inside its own region with sticky header and identity columns", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(css, /\.ranking-table-wrap\s*\{[^}]*max-height:\s*min\(76vh, 820px\)[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.ranking-table-wrap thead th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
  assert.match(css, /\.ranking-table-wrap th:nth-child\(2\), \.ranking-table-wrap td:nth-child\(2\)\s*\{[^}]*position:\s*sticky[^}]*left:\s*var\(--rank-col\)/s);
  assert.match(css, /\.ranking-table-wrap td\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.detail-facts dd\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  // the placeholder must disappear once a stock is selected (display:grid used to override [hidden])
  assert.match(css, /\.detail-empty\[hidden\][^{]*\{\s*display:\s*none/);
  assert.match(html, /class="ranking-table-wrap glass-panel" role="region" aria-label="[^"]+" tabindex="0"/);
  assert.match(html, /id="selected-evidence"/);
  assert.match(app, /import \{ buildSelectedDetail \} from "\.\/providers\/selected-detail\.js/);
  assert.match(app, /"selected-evidence"/);
  assert.match(app, /node\.textContent = `근거 데이터 없음 — \$\{gap\.label\}: \$\{gap\.reason\}`/);
});

// Same example sessions as tests/forecast-basis.test.mjs (newest first; target 2026-10-27).
const basisBar = (date, open, close) => ({ symbol: "005930", date, open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 1000 });
const BASIS_SESSIONS = [
  { date: "2026-10-26", rows: [basisBar("2026-10-26", 102, 104)] },
  { date: "2026-10-23", rows: [basisBar("2026-10-23", 99, 101)] },
  { date: "2026-10-22", rows: [basisBar("2026-10-22", 100, 98)] },
];
const historyRow = (estimate, extra = {}) => ({ symbol: "005930", name: "A", expected_open: estimate.expected_open, expected_close: estimate.expected_close, actual_open: null, actual_close: null,
  expected_open_source: { kind: "preopen_history", recorded_at: "2026-10-26T22:55:00Z", history_dates: estimate.open_basis.history_dates }, expected_open_basis: estimate.open_basis, expected_close_basis: estimate.close_basis, ...extra });

test("stored open/close basis renders as readable sentences with the stored numbers", async () => {
  const { priorHistoryEstimate } = await import("../providers/forecast-basis.js");
  const estimate = priorHistoryEstimate(BASIS_SESSIONS, "005930");
  const expected = section(buildSelectedDetail(historyRow(estimate), {}), "expected");
  const body = text(expected);
  assert.equal(expected.state, "available");
  assert.match(body, /모델 입력 직전 거래일 종가\(네이버 일봉\) 10-26 104원\. 최근 시가 갭: 10-26 \+0\.99% \(시가 102원 ÷ 10-23 종가 101원 − 1\), 10-23 \+1\.02% \(시가 99원 ÷ 10-22 종가 98원 − 1\) → 평균 \+1\.01% \(±5% 제한 내\) → 예상 시가 = 104 × 1\.0101 = 105\.05원\./);
  assert.match(body, /최근 3거래일 장중 수익률: 10-26 \+1\.96%, 10-23 \+2\.02%, 10-22 -2\.00% → 평균 \+0\.66% \(±5% 제한 내\) → 예상 종가 = 105\.05 × 1\.0066 = 105\.74원 → 예상 수익률 \+0\.66%\./);
  assert.match(body, /prior_3_sessions_open_gap_mean_capped_5pct/);
  assert.match(body, /prior_3_sessions_gap_and_session_mean_capped_5pct/);
  assert.doesNotMatch(body, /저장되지 않아/);
  assert.doesNotMatch(body, /다릅니다/);
  assert.equal(expected.missing.length, 0);

  const capped = priorHistoryEstimate([{ date: "2026-10-26", rows: [basisBar("2026-10-26", 130, 131)] }, BASIS_SESSIONS[1], BASIS_SESSIONS[2]], "005930");
  assert.match(text(section(buildSelectedDetail(historyRow(capped), {}), "expected")), /평균 \+14\.87% \(±5% 제한 적용 → \+5\.00%\) → 예상 시가 = 131 × 1\.0500 = 137\.55원/);
});

test("row reference price and the model's daily close are labelled separately", async () => {
  const { priorHistoryEstimate } = await import("../providers/forecast-basis.js");
  const estimate = priorHistoryEstimate(BASIS_SESSIONS, "005930");
  // Reference price from polling differs from the daily-chart close the model used.
  const sourced = section(buildSelectedDetail(historyRow(estimate, { prior_close: 103, prior_close_source: "naver_polling_close_minus_change" }), {}), "expected");
  const body = text(sourced);
  assert.match(body, /전일 기준가\(정규시장\) 103원/);
  assert.match(body, /기준가 출처 네이버 실시간 시세 현재가 − 전일 대비\(정규시장 기준가\)/);
  assert.match(body, /모델 입력 직전 거래일 종가\(네이버 일봉\) 104원 \(2026-10-26\)/);
  assert.match(body, /기준가와 일봉 종가는 출처가 달라 다를 수 있습니다\./);
  assert.doesNotMatch(body, /전일 종가\(기준가\)/);
  // Same value: no difference note.
  assert.doesNotMatch(text(section(buildSelectedDetail(historyRow(estimate, { prior_close: 104, prior_close_source: "naver_polling_close_minus_change" }), {}), "expected")), /출처가 달라/);
  // Older Naver rows without prior_close_source.
  assert.match(text(section(buildSelectedDetail(historyRow(estimate, { prior_close: 104 }), { providerId: "naver-crawl" }), "expected")), /기준가 출처 출처 미기록\(과거 수집분, 하락 종목은 부정확할 수 있음\)/);
});

test("non-Naver snapshots show prior_close neutrally without the Naver decline caveat", async () => {
  const snapshot = await readJson("data/runs/historical-test/2026-10-23/1530.json");
  const row = snapshot.rows.find((candidate) => candidate.symbol === "003010");
  assert.equal(Object.hasOwn(row, "prior_close_source"), false);
  const body = text(section(buildSelectedDetail(row, contextOf(snapshot)), "expected"));
  assert.match(body, /전일 기준가\(정규시장\) 10,860원/);
  assert.match(body, /기준가 출처 출처: 스냅샷 provider\(historical-test\) 원본 값/);
  assert.doesNotMatch(body, /하락 종목은 부정확할 수 있음/);
});

test("pre-open quote basis says the auction price was used and that no close model exists", () => {
  const row = { symbol: "005930", expected_open: 103, expected_close: null, expected_open_source: { kind: "preopen_quote", recorded_at: "2026-10-26T23:19:50Z", history_dates: [] },
    expected_open_basis: { model: "naver_preopen_quote_open_v1", history_dates: [], inputs: { open_price: 103, quote_at: "2026-10-26T23:19:50.000Z", market_status: "PREOPEN" } } };
  const body = text(section(buildSelectedDetail(row, {}), "expected"));
  assert.match(body, /장전 동시호가 예상 체결가\(2026\.10\.27 08:19:50 KST, PREOPEN\)를 예상 시가로 사용했습니다: 103원\. 예상 종가 모델은 없습니다\./);
  assert.match(body, /예상 종가 장전 호가 기반 예상 시가에는 예상 종가 모델이 없습니다/);
  assert.doesNotMatch(body, /저장되지 않아 표시하지 않습니다/);
});

test("basis that does not reproduce the stored values is flagged; rows without basis keep the missing-basis note", async () => {
  const { priorHistoryEstimate } = await import("../providers/forecast-basis.js");
  const estimate = priorHistoryEstimate(BASIS_SESSIONS, "005930");
  const body = text(section(buildSelectedDetail(historyRow(estimate, { expected_open: 106, expected_close: 106.7 }), {}), "expected"));
  assert.match(body, /저장된 예상 시가\(106원\)와 재계산값\(105\.05원\)이 다릅니다/);
  assert.match(body, /저장된 예상 종가\(106\.7원\)와 재계산값\(105\.74원\)이 다릅니다/);
  const legacy = historyRow(estimate);
  delete legacy.expected_open_basis; delete legacy.expected_close_basis;
  assert.match(text(section(buildSelectedDetail(legacy, {}), "expected")), /갭 비율과 직전 거래일 종가 수치\(expected_open_basis\)가 이 행에 저장되지 않아 표시하지 않습니다/);
  const unknown = historyRow(estimate, { expected_open_basis: { model: "other", history_dates: [], inputs: {} } });
  assert.match(text(section(buildSelectedDetail(unknown, {}), "expected")), /모델 식별자를 확인할 수 없어/);
});

// Every browser-loaded provider module is versioned once, through the import
// map, so app.js and provider-to-provider imports resolve to the same URL
// (one module instance) and Node keeps importing plain file paths.
test("import map versions every browser-loaded module with one cache key", async () => {
  const root = new URL("../", import.meta.url);
  const source = (file) => readFile(new URL(file, root), "utf8");
  const html = await source("index.html");
  const mapMatch = html.match(/<script type="importmap">(.*?)<\/script>/s);
  assert.ok(mapMatch, "index.html declares an import map");
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), "import map precedes module scripts");
  const imports = JSON.parse(mapMatch[1]).imports;

  const graph = new Set();
  const queue = ["app.js", "providers/daily-experiment-view.js"];
  while (queue.length) {
    const file = queue.shift();
    const code = await source(file);
    for (const match of code.matchAll(/^\s*import\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gms)) {
      assert.doesNotMatch(match[1], /\?/, `${file} imports ${match[1]} without its own query; the import map adds it`);
      const dep = new URL(match[1], new URL(file, root)).href.slice(root.href.length);
      if (dep.startsWith("providers/") && !graph.has(dep)) { graph.add(dep); queue.push(dep); }
    }
  }
  graph.add("providers/daily-experiment-view.js");

  const keys = new Set();
  for (const file of graph) {
    const target = imports[`./${file}`];
    assert.ok(target, `import map is missing ${file}`);
    const [, path, key] = target.match(/^\.\/(.+)\?v=([0-9a-z]+)$/) || [];
    assert.equal(path, file);
    keys.add(key);
  }
  keys.add(html.match(/\.\/styles\.css\?v=([0-9a-z]+)/)[1]);
  keys.add(html.match(/<script type="module" src="\.\/app\.js\?v=([0-9a-z]+)"/)[1]);
  keys.add(html.match(/<script type="module" src="\.\/providers\/daily-experiment-view\.js\?v=([0-9a-z]+)"/)[1]);
  assert.equal(keys.size, 1, `one cache key across page assets: ${[...keys].join(", ")}`);
});

test("hidden attribute always wins over author display rules (test ribbon on operational data)", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(css, /\[hidden\][^{]*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.test-ribbon\[hidden\]/);
  assert.match(html, /id="quality-ribbon" class="test-ribbon"[^>]*\shidden/);
  // Any class given a display value must be covered when the element carries hidden.
  const hiddenClasses = [...html.matchAll(/<[a-z]+\s[^>]*class="([^"]+)"[^>]*\shidden[\s>]/g)].flatMap((m) => m[1].split(/\s+/));
  for (const name of hiddenClasses) {
    const shows = new RegExp(`\\.${name}\\s*\\{[^}]*display:\\s*(?!none)`).test(css);
    if (shows) assert.match(css, /\[hidden\][^{]*\{\s*display:\s*none\s*!important/, `.${name} sets display but is hidden in markup`);
  }
});
