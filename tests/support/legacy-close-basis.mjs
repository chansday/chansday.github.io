// Test fixture only: the retired 3-session close model
// (prior_3_sessions_gap_and_session_mean_capped_5pct). It is no longer produced
// by the pipeline (providers/forecast-basis.js), but committed snapshots still
// carry it, so the row validators are exercised with rows built here.
import { BASIS_CAP, CLOSE_SESSION_MODEL } from "../../providers/forecast-basis.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function withLegacyThreeSessionClose(estimate, sessions, symbol) {
  const h = sessions.map((session) => session.rows.find((row) => row.symbol === symbol));
  const dates = sessions.map((session) => session.date);
  const sessionReturns = h.map((row, i) => ({ date: dates[i], open: row.open, close: row.close, ratio: row.close / row.open - 1 }));
  const mean = sessionReturns.reduce((sum, item) => sum + item.ratio, 0) / 3;
  const applied = Math.max(-BASIS_CAP, Math.min(BASIS_CAP, mean));
  return {
    ...estimate,
    expected_close: round(estimate.expected_open * (1 + applied)),
    close_basis: { model: CLOSE_SESSION_MODEL, history_dates: dates, inputs: { expected_open: estimate.expected_open, session_returns: sessionReturns, mean_session_return: mean, applied_session_return: applied, cap: BASIS_CAP } },
  };
}
