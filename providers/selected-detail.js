// Builds the "선택한 종목의 상세" panel content from values that are actually
// stored in the snapshot row and snapshot metadata. It never invents reasons,
// news or figures: when a basis field is missing it says so and, where the
// snapshot records one, shows the pipeline's own reason.
import { deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn } from "./evaluation-contract.js";

export const DETAIL_DISCLAIMER = "예상은 기록·비교용이며 수익을 보장하지 않습니다. 투자 조언이 아닙니다.";
export const RETROSPECTIVE_MODEL_ID = "prior_3_sessions_gap_and_session_mean_capped_5pct";
export const HISTORICAL_BASELINE_MODEL_ID = "public_daily_momentum_volatility_v1";
export const PREOPEN_QUOTE_MODEL_ID = "naver_preopen_quote_open_v1";
export const OPEN_GAP_MODEL_ID = "prior_3_sessions_open_gap_mean_capped_5pct";
export const CLOSE_SESSION_MODEL_ID = RETROSPECTIVE_MODEL_ID;
export const CLOSE_SHRUNK_MODEL_ID = "prior_20_sessions_trimmed_shrunk_mean_capped_1pct";
export const RIDGE_MODEL_ID = "ridge_6_features_60_sessions_v1";
export const RANK_MODEL_ID = "ridge_rank_11_features_60_sessions_v1";
const RANK_FEATURE_LABELS = ["20일 절사평균 장중수익률", "5일 평균 장중수익률", "전일 장중수익률", "전일 갭", "20일 모멘텀", "20일 변동성", "20일 평균 일중 변동폭", "전일 거래량 비율(로그)", "전일 종가 위치", "20일 평균 갭", "거래대금 규모(로그)"];
const RIDGE_FEATURE_LABELS = ["20일 절사평균 장중수익률", "5일 평균 장중수익률", "전일 장중수익률", "전일 갭", "20일 모멘텀", "20일 변동성"];

const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const decimal4 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fixed2 = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fixed4 = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const kstTime = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const SOURCE_KIND_LABELS = {
  preopen_quote: "장전 공개 시세 기록",
  preopen_history: "장전 공개 일봉 계산",
  retrospective_history: "장 시작 후 공개 일봉 사후 계산",
};
const STAGE_LABELS = {
  "previous-result": "전일 결과(07:00)", analysis: "기초 분석(08:00)", forecast: "장전 예상(08:20)",
  "open-settlement": "시가 정산(09:00)", "close-settlement": "종가 정산(15:30)", "update-results": "결과 갱신",
};
const PIPELINE_STATUS_LABELS = { ready: "완료", pending: "대기", blocked: "차단됨", degraded: "품질 저하", partial: "부분 결과", no_data: "데이터 없음" };
const MARKET_STATUS_LABELS = { OPEN: "장중", CLOSE: "장 마감", PREOPEN: "장전" };
const LICENSE_LABELS = { confirmed: "이용 조건 확인됨", unconfirmed: "이용 조건 확인 필요" };
// Row prior_close is the regular-market reference price from Naver polling;
// a basis prior_close is the daily-chart close the model used. They can differ.
export const PRIOR_CLOSE_LABEL = "전일 기준가(정규시장)";
export const MODEL_PRIOR_CLOSE_LABEL = "모델 입력 직전 거래일 종가(네이버 일봉)";
export const PRIOR_CLOSE_DIFF_NOTE = "기준가와 일봉 종가는 출처가 달라 다를 수 있습니다.";
export const PRIOR_CLOSE_SOURCE_MISSING = "출처 미기록(과거 수집분, 하락 종목은 부정확할 수 있음)";
const PRIOR_CLOSE_SOURCE_LABELS = { naver_polling_close_minus_change: "네이버 실시간 시세 현재가 − 전일 대비(정규시장 기준가)" };
// The "declining stocks may be wrong" caveat is about older Naver polling rows;
// other providers' prior_close is shown neutrally as their own source value.
function priorCloseSourceText(source, providerId) {
  if (!source) return providerId === "naver-crawl" ? PRIOR_CLOSE_SOURCE_MISSING : `출처: 스냅샷 provider(${providerId || "기록 없음"}) 원본 값`;
  return PRIOR_CLOSE_SOURCE_LABELS[source] || `원본 표기 ${source}`;
}
const MISSING_REASON_LABELS = {
  insufficient_prior_history: "직전 3거래일 이력 중 이 종목의 시가·종가·거래량이 빠진 날이 있어 계산하지 않았습니다.",
};

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function round(value, digits = 2) { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
function signed(text, value) { return value > 0 ? `+${text}` : text; }
export function formatWon(value) { return finite(value) ? `${decimal.format(value)}원` : "—"; }
export function formatPct(value, unit = "%") { return finite(value) ? `${signed(fixed2.format(value), value)}${unit}` : "—"; }
function formatPct4(value) { return finite(value) ? `${signed(decimal4.format(value), value)}%` : "—"; }
function formatSpread4(value) { return finite(value) ? `${decimal4.format(value)}%` : "—"; }
function formatKst(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? `${kstTime.format(date).replaceAll(". ", ".").replace(/\.(\d{2}:\d{2})/, " $1")} KST` : "—";
}
function stageStatus(pipeline, key) { return String(pipeline?.[key]?.status || "").toLowerCase(); }
function stageStatusLabel(status) { return PIPELINE_STATUS_LABELS[status] || (status ? status : "기록 없음"); }
function isHistoryDates(value) { return Array.isArray(value) && value.length > 0 && value.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)); }

// Basis ratios are stored as fractions (0.0099 = 0.99%).
function ratioPct(ratio) { if (!finite(ratio)) return "—"; const pct = ratio * 100; const shown = Math.abs(pct) < 0.005 ? 0 : pct; return `${shown > 0 ? "+" : ""}${fixed2.format(shown)}%`; }
function shortDate(date) { return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(5) : "날짜 미상"; }
function capText(mean, applied, cap) {
  if (!finite(cap)) return "";
  return finite(mean) && finite(applied) && Math.abs(mean - applied) > 1e-12 ? `(±${decimal.format(cap * 100)}% 제한 적용 → ${ratioPct(applied)})` : `(±${decimal.format(cap * 100)}% 제한 내)`;
}
function basisModel(basis) { return basis && typeof basis === "object" && basis.inputs && typeof basis.inputs === "object" ? basis.model : null; }
function multiplierText(value) { return finite(value) ? fixed4.format(value) : "—"; }

// Renders a stored expected_open_basis. Returns null when the model is unknown.
function describeOpenBasis(basis, row) {
  const model = basisModel(basis), i = basis?.inputs || {}, eo = row.expected_open;
  if (model === PREOPEN_QUOTE_MODEL_ID) {
    const sentences = [`장전 동시호가 예상 체결가(${formatKst(i.quote_at)}, ${i.market_status || "상태 미상"})를 예상 시가로 사용했습니다: ${formatWon(i.open_price)}. 예상 종가 모델은 없습니다.`];
    if (finite(i.open_price) && finite(eo) && Math.abs(i.open_price - eo) > 0.0001) sentences.push(`저장된 예상 시가(${formatWon(eo)})와 근거의 예상 체결가(${formatWon(i.open_price)})가 다릅니다. 화면에는 저장값을 표시합니다.`);
    return { items: [item("예상 시가 모델", model), item("호가 시각", formatKst(i.quote_at)), item("호가 시장 상태", MARKET_STATUS_LABELS[String(i.market_status || "").toUpperCase()] || i.market_status)], sentences };
  }
  if (model === OPEN_GAP_MODEL_ID) {
    const gaps = Array.isArray(i.gaps) ? i.gaps : [];
    const gapText = gaps.map((g) => `${shortDate(g.date)} ${ratioPct(g.ratio)} (시가 ${formatWon(g.open)} ÷ ${shortDate(g.previous_date)} 종가 ${formatWon(g.previous_close)} − 1)`).join(", ");
    const multiplier = finite(i.applied_gap) ? 1 + i.applied_gap : null;
    const recomputed = finite(i.prior_close) && finite(multiplier) ? round(i.prior_close * multiplier, 2) : null;
    const base = finite(i.prior_close) ? decimal.format(i.prior_close) : "—";
    const sentences = [`${MODEL_PRIOR_CLOSE_LABEL} ${shortDate(i.prior_close_date)} ${formatWon(i.prior_close)}. 최근 시가 갭: ${gapText || "기록 없음"} → 평균 ${ratioPct(i.mean_gap)} ${capText(i.mean_gap, i.applied_gap, i.cap)} → 예상 시가 = ${base} × ${multiplierText(multiplier)} = ${formatWon(recomputed)}.`];
    if (finite(recomputed) && finite(eo) && Math.abs(recomputed - eo) > 0.011) sentences.push(`저장된 예상 시가(${formatWon(eo)})와 재계산값(${formatWon(recomputed)})이 다릅니다. 화면에는 저장값을 표시합니다.`);
    const dates = isHistoryDates(basis.history_dates) ? basis.history_dates.join(", ") : "기록 없음";
    return { items: [item("예상 시가 모델", model), item("사용한 이력 날짜", dates), item(MODEL_PRIOR_CLOSE_LABEL, `${formatWon(i.prior_close)} (${i.prior_close_date || "날짜 미상"})`), item("평균 시가 갭 → 적용", `${ratioPct(i.mean_gap)} → ${ratioPct(i.applied_gap)}`)], sentences };
  }
  return null;
}

// Renders a stored expected_close_basis. Returns null when the model is unknown.
function describeCloseBasis(basis, row) {
  const model = basisModel(basis), i = basis?.inputs || {}, ec = row.expected_close;
  if (model === CLOSE_SHRUNK_MODEL_ID) return describeShrunkCloseBasis(basis, row);
  if (model === RIDGE_MODEL_ID) return describeRidgeCloseBasis(basis, row);
  if (model === RANK_MODEL_ID) return describeRankCloseBasis(basis, row);
  if (model !== CLOSE_SESSION_MODEL_ID) return null;
  const sessions = Array.isArray(i.session_returns) ? i.session_returns : [];
  const multiplier = finite(i.applied_session_return) ? 1 + i.applied_session_return : null;
  const recomputed = finite(i.expected_open) && finite(multiplier) ? round(i.expected_open * multiplier, 2) : null;
  const er = deriveExpectedReturn(row);
  const sessionText = sessions.map((x) => `${shortDate(x.date)} ${ratioPct(x.ratio)}`).join(", ") || "기록 없음";
  const base = finite(i.expected_open) ? decimal.format(i.expected_open) : "—";
  const tail = finite(er) ? ` → 예상 수익률 ${formatPct(er)}` : "";
  const sentences = [`최근 3거래일 장중 수익률: ${sessionText} → 평균 ${ratioPct(i.mean_session_return)} ${capText(i.mean_session_return, i.applied_session_return, i.cap)} → 예상 종가 = ${base} × ${multiplierText(multiplier)} = ${formatWon(recomputed)}${tail}.`];
  if (finite(recomputed) && finite(ec) && Math.abs(recomputed - ec) > 0.011) sentences.push(`저장된 예상 종가(${formatWon(ec)})와 재계산값(${formatWon(recomputed)})이 다릅니다. 화면에는 저장값을 표시합니다.`);
  if (finite(i.expected_open) && finite(row.expected_open) && Math.abs(i.expected_open - row.expected_open) > 0.0001) sentences.push(`예상 종가 근거의 예상 시가(${formatWon(i.expected_open)})가 저장된 예상 시가(${formatWon(row.expected_open)})와 다릅니다.`);
  return { items: [item("예상 종가 모델", model), item("장중 수익률 평균 → 적용", `${ratioPct(i.mean_session_return)} → ${ratioPct(i.applied_session_return)}`)], sentences };
}

function describeRankCloseBasis(basis, row) {
  const i = basis?.inputs || {}, m = i.model_params || {}, ec = row.expected_close;
  const multiplier = finite(i.predicted_return) ? 1 + i.predicted_return : null;
  const recomputed = finite(i.expected_open) && finite(multiplier) ? round(i.expected_open * multiplier, 2) : null;
  const er = deriveExpectedReturn(row);
  const base = finite(i.expected_open) ? decimal.format(i.expected_open) : "—";
  const tail = finite(er) ? ` → 예상 수익률 ${formatPct(er)}` : "";
  const ranks = Array.isArray(i.ranks) ? i.ranks : [], weights = Array.isArray(m.weights) ? m.weights : [];
  const parts = ranks.map((v, k) => (finite(weights[k + 1]) && finite(v) ? { k, v, c: weights[k + 1] * v } : null)).filter(Boolean).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
  const pct = (v) => v >= 0 ? `상위 ${decimal.format(Math.round((0.5 - v) * 1000) / 10)}%` : `하위 ${decimal.format(Math.round((v + 0.5) * 1000) / 10)}%`;
  const featureText = parts.slice(0, 4).map((p) => `${RANK_FEATURE_LABELS[p.k] || `요인 ${p.k + 1}`} ${pct(p.v)}(기여 ${ratioPct(p.c)})`).join(", ") || "기록 없음";
  const sentences = [
    `${m.train_first_date || "—"}~${m.train_last_date || "—"} ${finite(m.train_days) ? m.train_days : "—"}거래일·${finite(m.samples) ? integer.format(m.samples) : "—"}개 표본으로 매일 다시 학습한 순위 리지 회귀(λ=${finite(m.lambda) ? m.lambda : "—"}, 요인 ${ranks.length}개)입니다.`,
    `영향이 큰 요인(당일 전 종목 중 위치): ${featureText}.`,
    `시장 수준 ${ratioPct(m.level)} + 기본값 ${ratioPct(weights[0])} + 요인 기여 합계 → 예상 장중 수익률 ${ratioPct(i.predicted_return)} → 예상 종가 = ${base} × ${multiplierText(multiplier)} = ${formatWon(recomputed)}${tail}.`,
    "요인 값은 그날 전 종목 순위로 바꿔 사용하므로 극단값에 흔들리지 않고, 별도 상한은 두지 않습니다.",
  ];
  if (finite(recomputed) && finite(ec) && Math.abs(recomputed - ec) > 0.011) sentences.push(`저장된 예상 종가(${formatWon(ec)})와 재계산값(${formatWon(recomputed)})이 다릅니다. 화면에는 저장값을 표시합니다.`);
  return { items: [item("예상 종가 모델", RANK_MODEL_ID), item("예상 장중 수익률", ratioPct(i.predicted_return))], sentences };
}

function describeRidgeCloseBasis(basis, row) {
  const i = basis?.inputs || {}, m = i.model_params || {}, ec = row.expected_close;
  const multiplier = finite(i.predicted_return) ? 1 + i.predicted_return : null;
  const recomputed = finite(i.expected_open) && finite(multiplier) ? round(i.expected_open * multiplier, 2) : null;
  const er = deriveExpectedReturn(row);
  const base = finite(i.expected_open) ? decimal.format(i.expected_open) : "—";
  const tail = finite(er) ? ` → 예상 수익률 ${formatPct(er)}` : "";
  const features = Array.isArray(i.clipped_features) ? i.clipped_features : [];
  const weights = Array.isArray(m.weights) ? m.weights : [];
  const parts = features.map((v, k) => finite(weights[k + 1]) && finite(m.means?.[k]) && finite(m.sds?.[k]) ? weights[k + 1] * ((v - m.means[k]) / m.sds[k]) : null);
  const featureText = features.map((v, k) => `${RIDGE_FEATURE_LABELS[k] || `요인 ${k + 1}`} ${ratioPct(v)}(기여 ${ratioPct(parts[k])})`).join(", ") || "기록 없음";
  const sentences = [
    `${m.train_first_date || "—"}~${m.train_last_date || "—"} ${finite(m.train_days) ? m.train_days : "—"}거래일·${finite(m.samples) ? integer.format(m.samples) : "—"}개 표본으로 매일 다시 학습한 리지 회귀(λ=${finite(m.lambda) ? m.lambda : "—"})입니다.`,
    `요인: ${featureText}. 기본값 ${ratioPct(weights[0])} + 기여 합계 → 예상 장중 수익률 ${ratioPct(i.predicted_return)} → 예상 종가 = ${base} × ${multiplierText(multiplier)} = ${formatWon(recomputed)}${tail}.`,
    "요인 값은 학습 표본의 상하위 1% 범위로 자른 뒤 사용하며, 별도 상한은 두지 않습니다.",
  ];
  if (finite(recomputed) && finite(ec) && Math.abs(recomputed - ec) > 0.011) sentences.push(`저장된 예상 종가(${formatWon(ec)})와 재계산값(${formatWon(recomputed)})이 다릅니다. 화면에는 저장값을 표시합니다.`);
  return { items: [item("예상 종가 모델", RIDGE_MODEL_ID), item("예상 장중 수익률", ratioPct(i.predicted_return))], sentences };
}

function describeShrunkCloseBasis(basis, row) {
  const i = basis?.inputs || {}, ec = row.expected_close;
  const sessions = Array.isArray(i.session_returns) ? i.session_returns : [];
  const multiplier = finite(i.applied_session_return) ? 1 + i.applied_session_return : null;
  const recomputed = finite(i.expected_open) && finite(multiplier) ? round(i.expected_open * multiplier, 2) : null;
  const er = deriveExpectedReturn(row);
  const base = finite(i.expected_open) ? decimal.format(i.expected_open) : "—";
  const tail = finite(er) ? ` → 예상 수익률 ${formatPct(er)}` : "";
  const range = sessions.length ? `${shortDate(sessions[sessions.length - 1].date)}~${shortDate(sessions[0].date)}` : "기록 없음";
  const shrunk = finite(i.trimmed_mean) && finite(i.shrink_weight) ? i.trimmed_mean * i.shrink_weight : null;
  const sentences = [
    `최근 ${sessions.length}거래일(${range}) 장중 수익률에서 위아래 각 ${finite(i.trim_count) ? i.trim_count : "—"}일을 뺀 평균 ${ratioPct(i.trimmed_mean)} × 신뢰도 가중치 ${multiplierText(i.shrink_weight)}(t=${finite(i.t_stat) ? decimal.format(i.t_stat) : "—"}) = ${ratioPct(shrunk)} ${capText(shrunk, i.applied_session_return, i.cap)} → 예상 종가 = ${base} × ${multiplierText(multiplier)} = ${formatWon(recomputed)}${tail}.`,
    "들쭉날쭉한 수익률일수록 가중치가 0에 가까워져 예상 수익률이 작아집니다.",
  ];
  if (finite(recomputed) && finite(ec) && Math.abs(recomputed - ec) > 0.011) sentences.push(`저장된 예상 종가(${formatWon(ec)})와 재계산값(${formatWon(recomputed)})이 다릅니다. 화면에는 저장값을 표시합니다.`);
  if (finite(i.expected_open) && finite(row.expected_open) && Math.abs(i.expected_open - row.expected_open) > 0.0001) sentences.push(`예상 종가 근거의 예상 시가(${formatWon(i.expected_open)})가 저장된 예상 시가(${formatWon(row.expected_open)})와 다릅니다.`);
  return { items: [item("예상 종가 모델", CLOSE_SHRUNK_MODEL_ID), item("절사 평균 → 축소 → 적용", `${ratioPct(i.trimmed_mean)} → ${ratioPct(shrunk)} → ${ratioPct(i.applied_session_return)}`)], sentences };
}

function item(label, value) { return { label, value: value === null || value === undefined || value === "" ? "—" : String(value) }; }

function expectedSection(row, ctx) {
  const eo = row.expected_open, ec = row.expected_close;
  const er = deriveExpectedReturn(row);
  const src = row.expected_open_source && typeof row.expected_open_source === "object" ? row.expected_open_source : null;
  const features = row.features && typeof row.features === "object" ? row.features : null;
  const baseline = ctx.baseline || null;
  const retroDates = isHistoryDates(row.retrospective_overlay) ? row.retrospective_overlay : null;
  const retro = ctx.retrospective || null;
  const pipeline = ctx.pipeline || {};
  const items = [item("예상 시가", formatWon(eo)), item("예상 종가", formatWon(ec)), item("예상 수익률", formatPct(er)), item(PRIOR_CLOSE_LABEL, formatWon(row.prior_close))];
  if (finite(row.prior_close)) items.push(item("기준가 출처", priorCloseSourceText(row.prior_close_source, ctx.providerId)));
  const sentences = [];
  const missing = [];
  let basis = false;

  if (finite(eo)) {
    if (src) {
      basis = true;
      items.push(item("근거 종류", SOURCE_KIND_LABELS[src.kind] || "근거 종류 확인 필요"), item("근거 기록 시각", formatKst(src.recorded_at)), item("사용한 이력 날짜", isHistoryDates(src.history_dates) ? src.history_dates.join(", ") : "없음"));
      const openBasis = row.expected_open_basis ? describeOpenBasis(row.expected_open_basis, row) : null;
      if (openBasis) {
        items.push(...openBasis.items);
        sentences.push(...openBasis.sentences);
        const modelClose = row.expected_open_basis?.inputs?.prior_close;
        if (finite(modelClose) && finite(row.prior_close) && Math.abs(modelClose - row.prior_close) > 0.0001) sentences.push(PRIOR_CLOSE_DIFF_NOTE);
        if (src.kind === "retrospective_history") sentences.push("장 시작 후 계산된 값이며 장전 예측이 아닙니다.");
      } else if (row.expected_open_basis) {
        missing.push({ label: "예상 시가 근거", reason: "저장된 근거의 모델 식별자를 확인할 수 없어 계산식을 표시하지 않습니다." });
      } else if (src.kind === "preopen_quote") {
        sentences.push(`장전 시각(${formatKst(src.recorded_at)})에 기록된 공개 시세의 시가 ${formatWon(eo)}을 예상 시가로 그대로 사용했습니다. 별도 계산식은 적용하지 않았습니다.`);
      } else if (isHistoryDates(src.history_dates)) {
        sentences.push(`직전 거래일 일봉(${src.history_dates.join(", ")})으로 계산했습니다: 최근 두 번의 시가 갭(당일 시가 ÷ 전일 종가 − 1) 평균을 ±5% 안으로 제한한 뒤 직전 거래일 종가에 반영 → 예상 시가 ${formatWon(eo)}.`);
        sentences.push("갭 비율과 직전 거래일 종가 수치(expected_open_basis)가 이 행에 저장되지 않아 표시하지 않습니다.");
        if (src.kind === "retrospective_history") sentences.push("장 시작 후 계산된 값이며 장전 예측이 아닙니다.");
      }
    } else if (features && baseline?.model) {
      basis = true;
      items.push(item("모델", baseline.model), item("사용한 이력 날짜", isHistoryDates(baseline.input_dates) ? baseline.input_dates.join(", ") : "기록 없음"), item("전일 수익률", formatPct4(features.previous_return)), item("모멘텀(최근 3개 일간 수익률 평균)", formatPct4(features.momentum)), item("변동성(최근 4개 일간 수익률 표준편차)", formatSpread4(features.volatility)), item("조회 거래일 수", finite(features.lookback_sessions) ? `${features.lookback_sessions}일` : "—"));
      const coefficients = baseline.coefficients || {};
      const mw = coefficients.momentum_weight, vp = coefficients.volatility_penalty, cap = coefficients.max_abs_expected_return;
      if (baseline.model === HISTORICAL_BASELINE_MODEL_ID && [mw, vp, cap].every(finite) && finite(features.momentum) && finite(features.volatility)) {
        const raw = round(mw * features.momentum - vp * features.volatility, 2);
        const signal = Math.max(-cap, Math.min(cap, raw));
        const capText = signal !== raw ? ` → 상한 ±${decimal.format(cap)}% 적용 → ${formatPct(signal)}` : "";
        sentences.push(`예상 신호 = ${decimal.format(mw)} × 모멘텀 ${formatPct4(features.momentum)} − ${decimal.format(vp)} × 변동성 ${formatSpread4(features.volatility)} = ${formatPct(raw)}${capText}.`);
        if (finite(row.prior_close)) {
          const implied = round(row.prior_close * (1 + signal / 100), 2);
          sentences.push(`예상 시가 = 전일 종가 ${formatWon(row.prior_close)} × (1 ${signal < 0 ? "−" : "+"} ${decimal.format(Math.abs(signal))}%) = ${formatWon(implied)}.`);
          if (Math.abs(implied - eo) > 0.011) sentences.push(`저장된 예상 시가(${formatWon(eo)})와 재계산값이 다릅니다. 화면에는 저장값을 표시합니다.`);
        }
      }
      if (baseline.value_status === "retrospective_baseline_no_preopen_quote" || /not the historical 08:20 forecast/i.test(String(baseline.note || ""))) sentences.push("장전 호가가 없어 사후에 재현한 공개 일봉 기준선이며, 당시 08:20에 게시된 예측이 아닙니다.");
    } else if (retroDates) {
      basis = true;
      items.push(item("모델", retro?.model || "기록 없음"), item("사용한 이력 날짜", retroDates.join(", ")), item("사후 계산 시각", formatKst(retro?.created_at)));
      if ([RANK_MODEL_ID, RIDGE_MODEL_ID, CLOSE_SHRUNK_MODEL_ID].includes(retro?.model)) {
        sentences.push(`장 마감 후, 그날 아침 일봉 수집에서 쓴 것과 같은 모델(${retro.model})로 계산했습니다. 예상 시가 = 직전 거래일 종가 × (1 + 최근 두 번의 시가 갭 평균, ±5% 제한) → ${formatWon(eo)}.`);
        if (finite(ec)) sentences.push(`예상 종가 = 예상 시가 × (1 + 모델 예상 장중 수익률) → ${formatWon(ec)}.`);
        if (finite(er)) sentences.push(`저장된 예상 시가·종가로 보면 예상 장중 수익률은 ${formatPct(er)}입니다.`);
      } else if (retro?.model === RETROSPECTIVE_MODEL_ID) {
        sentences.push(`장 마감 후 직전 3거래일 일봉(${retroDates.join(", ")})으로 계산했습니다: 예상 시가 = 직전 거래일 종가 × (1 + 최근 두 번의 시가 갭 평균, ±5% 제한) → ${formatWon(eo)}.`);
        if (finite(ec)) sentences.push(`예상 종가 = 예상 시가 × (1 + 최근 3거래일 평균 장중 수익률, ±5% 제한) → ${formatWon(ec)}.`);
        if (finite(er)) sentences.push(`저장된 예상 시가·종가로 보면 적용된 평균 장중 수익률은 ${formatPct(er)}입니다.`);
        sentences.push("갭 비율·직전 거래일 종가 수치는 사후 계산 기록에 저장되지 않아 표시하지 않습니다.");
      } else {
        missing.push({ label: "계산식", reason: "사후 계산 기록의 모델 식별자가 확인되지 않아 계산식을 표시하지 않습니다." });
      }
      sentences.push("장전 예측이 아니며 실전 성과로 해석하지 않습니다.");
    } else {
      missing.push({ label: "예상 시가 근거", reason: "이 행에는 예상 시가의 계산 근거(expected_open_source 또는 features)가 저장되지 않았습니다." });
      const message = String(pipeline.forecast?.message || "");
      if (/closePriceRaw quote baseline/i.test(message)) sentences.push("파이프라인 기록: 이 예상 시가는 실행 시점의 현재가(closePriceRaw) 기준값이며 장전 예측이 아닙니다.");
      if (message) items.push(item("장전 예상 단계 기록(원문)", message));
    }
  } else {
    const reasonKey = row.retrospective_missing_reason || row.missing_reason;
    const forecastStatus = stageStatus(pipeline, "forecast");
    let reason;
    if (reasonKey) reason = MISSING_REASON_LABELS[reasonKey] || `미계산 사유 코드: ${reasonKey}`;
    else if (forecastStatus && forecastStatus !== "ready") reason = `이 스냅샷(${STAGE_LABELS[ctx.runStage] || "단계 정보 없음"})에는 장전 예상 단계 기록이 포함되지 않았습니다 (장전 예상 단계 상태: ${stageStatusLabel(forecastStatus)}).`;
    else reason = "예상 시가가 기록되지 않았습니다 (사유 기록 없음).";
    missing.push({ label: "예상 시가", reason });
  }

  const closeBasis = finite(ec) && row.expected_close_basis ? describeCloseBasis(row.expected_close_basis, row) : null;
  if (closeBasis) { items.push(...closeBasis.items); sentences.push(...closeBasis.sentences); }
  else if (finite(ec) && row.expected_close_basis) missing.push({ label: "예상 종가 근거", reason: "저장된 근거의 모델 식별자를 확인할 수 없어 계산식을 표시하지 않습니다." });
  if (finite(eo) && !finite(ec)) {
    const quoteOpen = basisModel(row.expected_open_basis) === PREOPEN_QUOTE_MODEL_ID;
    missing.push({ label: "예상 종가", reason: quoteOpen ? "장전 호가 기반 예상 시가에는 예상 종가 모델이 없습니다 (expected_close 미기록)." : features && baseline?.model ? "이 기준선은 종가를 예측하지 않습니다 (expected_close 미기록)." : "예상 종가가 저장되지 않았습니다." });
  }
  if (finite(er) && !closeBasis) sentences.push(`예상 수익률 = 예상 종가 ${formatWon(ec)} ÷ 예상 시가 ${formatWon(eo)} − 1 = ${formatPct(er)}.`);
  if (!finite(er) && finite(eo)) missing.push({ label: "예상 수익률", reason: "예상 시가와 예상 종가가 모두 있을 때만 계산합니다." });
  if (finite(row.intraday_reference_return)) {
    items.push(item("실행 시점 참고 수익률(전일 기준가 대비)", formatPct(row.intraday_reference_return)));
    sentences.push("실행 시점 참고 수익률은 예상 수익률과 별개의 참고값입니다.");
  }
  const state = finite(eo) && basis ? (finite(er) ? "available" : "partial") : finite(eo) ? "partial" : "missing";
  return { id: "expected", title: "예상값 근거", state, items, sentences, missing };
}

function actualSection(row, ctx) {
  const pipeline = ctx.pipeline || {};
  const sr = deriveSessionReturn(row);
  const items = [item("실제 시가", formatWon(row.actual_open)), item("실제 종가", formatWon(row.actual_close)), item("실제 장중 수익률", formatPct(sr)), item("거래량", finite(row.actual_volume) ? `${integer.format(row.actual_volume)}주` : "—")];
  if (row.quote_at) items.push(item("시세 시각", formatKst(row.quote_at)));
  if (finite(row.quote_age_seconds)) items.push(item("수집 시점 시세 경과", `${decimal.format(row.quote_age_seconds)}초`));
  if (row.market_status) items.push(item("시장 상태", MARKET_STATUS_LABELS[String(row.market_status).toUpperCase()] || `원본 표기 ${row.market_status}`));
  const sentences = [];
  const missing = [];
  if (finite(sr)) sentences.push(`실제 장중 수익률 = 실제 종가 ${formatWon(row.actual_close)} ÷ 실제 시가 ${formatWon(row.actual_open)} − 1 = ${formatPct(sr)}.`);
  if (!finite(row.actual_open)) {
    const status = stageStatus(pipeline, "openSettlement");
    missing.push({ label: "실제 시가", reason: status && status !== "ready" ? `시가 정산(09:00) 단계가 '${stageStatusLabel(status)}' 상태입니다.` : "실제 시가가 기록되지 않았습니다." });
  }
  if (!finite(row.actual_close)) {
    const status = stageStatus(pipeline, "closeSettlement");
    missing.push({ label: "실제 종가", reason: status && status !== "ready" ? `종가 정산(15:30) 단계가 '${stageStatusLabel(status)}' 상태라 장중 수익률을 계산하지 않았습니다.` : "실제 종가가 기록되지 않았습니다." });
  }
  if (!finite(row.actual_volume)) missing.push({ label: "거래량", reason: "거래량이 기록되지 않았습니다." });
  else if (ctx.providerId === "naver-crawl") sentences.push("거래량은 시세 시각 기준 누적 거래량입니다.");
  const state = finite(sr) ? "available" : finite(row.actual_open) || finite(row.actual_close) ? "partial" : "missing";
  return { id: "actual", title: "실제값", state, items, sentences, missing };
}

function errorSection(row) {
  const er = deriveExpectedReturn(row), sr = deriveSessionReturn(row), error = deriveEvaluationError(row);
  const items = [item("오차", formatPct(error, "%p")), item("예상 수익률", formatPct(er)), item("실제 장중 수익률", formatPct(sr))];
  const sentences = [];
  const missing = [];
  if (finite(error)) {
    sentences.push(`오차 = 실제 장중 수익률 ${formatPct(sr)} − 예상 수익률 ${formatPct(er)} = ${formatPct(error, "%p")}.`);
    sentences.push(error > 0 ? "실제 장중 수익률이 예상보다 높았습니다." : error < 0 ? "실제 장중 수익률이 예상보다 낮았습니다." : "실제 장중 수익률과 예상이 같았습니다.");
  } else {
    const reasons = [];
    if (!finite(er)) reasons.push("예상 수익률 없음(예상 시가·예상 종가 중 미기록)");
    if (!finite(sr)) reasons.push("실제 장중 수익률 없음(실제 시가·실제 종가 중 미기록)");
    missing.push({ label: "오차 미계산", reason: `${reasons.join(", ")}.` });
  }
  return { id: "error", title: "오차", state: finite(error) ? "available" : "missing", items, sentences, missing };
}

function sourceSection(row, ctx) {
  const source = ctx.source || {};
  const license = String(source.license_status || "").toLowerCase();
  const items = [
    item("데이터 공급자", ctx.providerLabel || ctx.providerId || "기록 없음"),
    item("원천", source.name || "기록 없음"),
    item("이용 조건", LICENSE_LABELS[license] || (license ? `원본 표기 ${license}` : "기록 없음")),
    item("수집 시각", formatKst(source.retrieved_at || source.fetched_at)),
    item("스냅샷 단계", STAGE_LABELS[ctx.runStage] || (ctx.runStage ? ctx.runStage : "기록 없음")),
    item("데이터 품질", ctx.qualityLabel ? ctx.qualityLabel(row.quality) : (row.quality || "기록 없음")),
    item("행 상태 사유", Array.isArray(row.reasons) && row.reasons.length ? row.reasons.join(", ") : "기록 없음"),
  ];
  const warnings = [];
  if (license !== "confirmed") warnings.push("이용 조건(라이선스)이 확인되지 않은 출처입니다. 재배포·이용 권리가 확인되지 않았습니다.");
  if (ctx.providerId === "naver-crawl") warnings.push("네이버 공개 웹 크롤링 값으로 비공식 출처이며 지연될 수 있습니다.");
  if (ctx.testOnly) warnings.push("시험용 데이터입니다. 운영 예측이나 실전 성과가 아닙니다.");
  if (isHistoryDates(row.retrospective_overlay)) warnings.push("장 마감 후 사후 계산된 예상값입니다. 원천 일봉의 최초 발행·수정 여부는 확인되지 않았습니다.");
  return { id: "source", title: "출처·신뢰 정보", state: license === "confirmed" ? "available" : "partial", items, sentences: [], missing: [], warnings };
}

export const NO_TRADE_LABEL = "거래 없음(정지 추정)";
const NO_TRADE_SOURCE_LABELS = { naver_polling_quote: "네이버 시세의 거래정지(HALTED) 표시", naver_daily_candle: "네이버 일봉의 거래량 0", naver_daily_history: "직전 일봉의 거래량 0" };

// A no_trade row has no prices because the source reported zero trade, not
// because data is missing: its gaps are stated as "거래 없음(정지 추정)".
function noTradeSection(section, row) {
  const evidence = row.no_trade_evidence || {};
  const basis = `${NO_TRADE_SOURCE_LABELS[evidence.source] || "원천의 거래량 0"}${Array.isArray(evidence.dates) && evidence.dates.length ? ` (${evidence.dates.join(", ")})` : evidence.observed_at ? ` (${formatKst(evidence.observed_at)})` : ""}`;
  if (!section.missing.length) return section;
  return { ...section, state: section.state === "missing" ? "no_trade" : section.state,
    sentences: [...section.sentences, ...section.missing.map((gap) => `${NO_TRADE_LABEL} — ${gap.label}: ${basis} 보고로 값을 기록하지 않았습니다.`)], missing: [] };
}

// row: raw snapshot row (snake_case), optionally with retrospective_overlay /
// retrospective_missing_reason attached by the post-close overlay step.
export function buildSelectedDetail(row, context = {}) {
  if (!row || typeof row !== "object") return null;
  const ctx = {
    baseline: context.baseline || null,
    pipeline: context.pipeline || {},
    retrospective: context.retrospective || null,
    runStage: context.runStage || null,
    providerId: context.providerId || null,
    providerLabel: context.providerLabel || null,
    source: context.source || null,
    testOnly: Boolean(context.testOnly),
    qualityLabel: typeof context.qualityLabel === "function" ? context.qualityLabel : null,
  };
  const sections = [expectedSection(row, ctx), actualSection(row, ctx), errorSection(row), sourceSection(row, ctx)];
  return { sections: row.trading_status === "no_trade_observed" ? sections.map((section) => noTradeSection(section, row)) : sections, disclaimer: DETAIL_DISCLAIMER };
}
