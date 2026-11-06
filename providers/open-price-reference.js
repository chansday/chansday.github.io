import { compareByExpectedReturn, deriveEvaluationError, deriveExpectedReturn } from './evaluation-contract.js';
import { withEvaluationScores } from './evaluation-score.js';

// Preserve the recorded stages; apply the selected reference to the displayed
// same-day snapshot, including later settlement snapshots.
export function applyOpenPriceReference(snapshot, record) {
  if (snapshot?.mode !== 'provider' || snapshot?.asOfDate !== record?.date || record?.source !== 'naver_polling_openPriceRaw' || !Array.isArray(record.rows) || !Number.isFinite(Date.parse(record.retrieved_at)) || !Array.isArray(snapshot.rows)) return snapshot;
  const bySymbol = new Map();
  for (const row of record.rows) {
    if (!/^\d{6}$/.test(row?.symbol || '') || bySymbol.has(row.symbol) || !(Number.isFinite(row.expected_open) && row.expected_open > 0 && Number.isFinite(row.expected_close) && row.expected_close > 0) || !Number.isFinite(Date.parse(row.quote_at))) return snapshot;
    bySymbol.set(row.symbol, row);
  }
  if (!bySymbol.size) return snapshot;
  const rows = snapshot.rows.map(original => {
    const reference = bySymbol.get(original.symbol);
    if (!reference || original.trading_status === 'no_trade_observed') {
      const row = {...original, expected_open: null, expected_close: null, expected_return: null, error: null};
      delete row.expected_open_source; delete row.expected_open_basis; delete row.expected_close_basis;
      return row;
    }
    const row = {...original, expected_open: reference.expected_open, expected_close: reference.expected_close, quality: 'naver_open_price_reference'};
    delete row.expected_open_source; delete row.expected_open_basis; delete row.expected_close_basis;
    row.expected_return = deriveExpectedReturn(row);
    row.error = deriveEvaluationError(row);
    return row;
  });
  rows.sort(compareByExpectedReturn); rows.forEach((row, i) => { row.rank = i + 1; });
  const next = {...snapshot, rows: withEvaluationScores(rows), meta: {...snapshot.meta, open_price_reference_at: record.retrieved_at}};
  // Stored summaries describe the original rows and cannot be reused.
  delete next.evaluation;
  return next;
}
