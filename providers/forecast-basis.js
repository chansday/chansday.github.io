// Shared prior-history estimate and the provenance ("basis") stored with it.
// Every number in a basis is an input or intermediate value actually used in
// the calculation; nothing is synthesized. Sessions are newest first and never
// include the target date.
export const PREOPEN_QUOTE_MODEL = "naver_preopen_quote_open_v1";
export const OPEN_GAP_MODEL = "prior_3_sessions_open_gap_mean_capped_5pct";
// Same identifier as the post-close retrospective: expected_close applies the
// capped mean of the three prior session returns to the gap-based opening.
export const CLOSE_SESSION_MODEL = "prior_3_sessions_gap_and_session_mean_capped_5pct";
export const BASIS_CAP = 0.05;

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value) => Math.max(-BASIS_CAP, Math.min(BASIS_CAP, value));
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

export function priorHistoryEstimate(sessions, symbol) {
  if (!Array.isArray(sessions) || sessions.length !== 3) return null;
  const h = sessions.map((session) => session?.rows?.find((row) => row.symbol === symbol));
  if (h.some((row) => !row || !positive(row.open) || !positive(row.close) || !positive(row.volume))) return null;
  const dates = sessions.map((session) => session.date);
  const gaps = [0, 1].map((i) => ({ date: dates[i], open: h[i].open, previous_date: dates[i + 1], previous_close: h[i + 1].close, ratio: h[i].open / h[i + 1].close - 1 }));
  const meanGap = (gaps[0].ratio + gaps[1].ratio) / 2;
  const appliedGap = clamp(meanGap);
  const expectedOpen = round(h[0].close * (1 + appliedGap));
  const sessionReturns = h.map((row, i) => ({ date: dates[i], open: row.open, close: row.close, ratio: row.close / row.open - 1 }));
  const meanSession = sessionReturns.reduce((sum, item) => sum + item.ratio, 0) / 3;
  const appliedSession = clamp(meanSession);
  const expectedClose = round(expectedOpen * (1 + appliedSession));
  return {
    expected_open: expectedOpen,
    expected_close: expectedClose,
    open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } },
    close_basis: { model: CLOSE_SESSION_MODEL, history_dates: dates, inputs: { expected_open: expectedOpen, session_returns: sessionReturns, mean_session_return: meanSession, applied_session_return: appliedSession, cap: BASIS_CAP } },
  };
}

export function preopenQuoteBasis({ openPrice, quoteAt, marketStatus }) {
  return { model: PREOPEN_QUOTE_MODEL, history_dates: [], inputs: { open_price: openPrice, quote_at: quoteAt, market_status: marketStatus } };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Stored ratios are recomputed from their own stored prices; the tolerance only
// absorbs floating-point representation, not rounding of the inputs.
const RATIO_TOLERANCE = 1e-9;
const near = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= RATIO_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join(",") === [...keys].sort().join(",");

function validHistoryDates(dates, length) {
  return Array.isArray(dates) && dates.length === length && dates.every((d, i) => typeof d === "string" && DATE.test(d) && (i === 0 || d < dates[i - 1]));
}

// Structural validation used by the snapshot contract.
export function isOpenBasis(basis, row, { asOfDate = null } = {}) {
  if (!exactKeys(basis, ["model", "history_dates", "inputs"]) || !positive(row?.expected_open) || !row.expected_open_source) return false;
  const src = row.expected_open_source, i = basis.inputs;
  if (basis.model === PREOPEN_QUOTE_MODEL) {
    return src.kind === "preopen_quote" && validHistoryDates(basis.history_dates, 0) && exactKeys(i, ["open_price", "quote_at", "market_status"])
      && positive(i.open_price) && i.open_price === row.expected_open && typeof i.quote_at === "string" && Number.isFinite(Date.parse(i.quote_at)) && i.market_status === "PREOPEN";
  }
  if (basis.model === OPEN_GAP_MODEL) {
    if (src.kind === "preopen_quote" || !validHistoryDates(basis.history_dates, 3) || basis.history_dates.join() !== src.history_dates.join()) return false;
    if (!exactKeys(i, ["prior_close_date", "prior_close", "gaps", "mean_gap", "applied_gap", "cap"]) || i.prior_close_date !== basis.history_dates[0] || !positive(i.prior_close) || !finite(i.mean_gap) || !finite(i.applied_gap) || i.cap !== BASIS_CAP) return false;
    if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
    if (!Array.isArray(i.gaps) || i.gaps.length !== 2 || !i.gaps.every((g, k) => exactKeys(g, ["date", "open", "previous_date", "previous_close", "ratio"]) && g.date === basis.history_dates[k] && g.previous_date === basis.history_dates[k + 1] && positive(g.open) && positive(g.previous_close) && near(g.ratio, g.open / g.previous_close - 1))) return false;
    return near(i.mean_gap, (i.gaps[0].ratio + i.gaps[1].ratio) / 2) && i.applied_gap === clamp(i.mean_gap) && row.expected_open === round(i.prior_close * (1 + i.applied_gap));
  }
  return false;
}

export function isCloseBasis(basis, row, { asOfDate = null } = {}) {
  if (!exactKeys(basis, ["model", "history_dates", "inputs"]) || basis.model !== CLOSE_SESSION_MODEL || !positive(row?.expected_close) || !validHistoryDates(basis.history_dates, 3)) return false;
  const i = basis.inputs;
  if (!exactKeys(i, ["expected_open", "session_returns", "mean_session_return", "applied_session_return", "cap"]) || i.cap !== BASIS_CAP || !positive(i.expected_open) || i.expected_open !== row.expected_open) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  if (!Array.isArray(i.session_returns) || i.session_returns.length !== 3 || !i.session_returns.every((s, k) => exactKeys(s, ["date", "open", "close", "ratio"]) && s.date === basis.history_dates[k] && positive(s.open) && positive(s.close) && near(s.ratio, s.close / s.open - 1))) return false;
  if (!near(i.mean_session_return, i.session_returns.reduce((sum, s) => sum + s.ratio, 0) / 3) || i.applied_session_return !== clamp(i.mean_session_return) || row.expected_close !== round(i.expected_open * (1 + i.applied_session_return))) return false;
  // Both bases describe the same three daily bars: prices must agree across them.
  const o = row.expected_open_basis?.inputs;
  if (!o || !Array.isArray(o.gaps) || o.gaps.length !== 2) return false;
  const [s0, s1, s2] = i.session_returns;
  return o.prior_close === s0.close && o.gaps[0].open === s0.open && o.gaps[0].previous_close === s1.close && o.gaps[1].open === s1.open && o.gaps[1].previous_close === s2.close;
}
