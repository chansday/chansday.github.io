import { compareByExpectedReturn, deriveEvaluationError, deriveExpectedReturn } from './evaluation-contract.js';
import { withEvaluationScores } from './evaluation-score.js';

// The per-row expected_close_basis is dropped below once the open-price
// reference overrides the estimate (the basis no longer describes the
// displayed value), but which model actually produced today's forecast is
// still a fact worth keeping. Summarize it once, from the rows as recorded,
// into the same top-level shape the frontend already reads for previews.
function summarizeModel(rows) {
  const counts = new Map();
  for (const row of rows) {
    const basis = row?.expected_close_basis;
    if (!basis?.model) continue;
    const entry = counts.get(basis.model) || { n: 0, params: basis.inputs?.model_params || null };
    entry.n += 1; counts.set(basis.model, entry);
  }
  if (!counts.size) return null;
  const [model, { params }] = [...counts].sort((a, b) => b[1].n - a[1].n)[0];
  return { model, model_trained_at: params?.trained_at || null, model_train_last_date: typeof params?.train_last_date === 'string' ? params.train_last_date : null };
}

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
  const modelSummary = summarizeModel(snapshot.rows);
  const next = {...snapshot, ...modelSummary, rows: withEvaluationScores(rows), meta: {...snapshot.meta, open_price_reference_at: record.retrieved_at}};
  // Stored summaries describe the original rows and cannot be reused.
  delete next.evaluation;
  return next;
}
