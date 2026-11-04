import { compareByExpectedReturn, rankingExpectedReturn } from './evaluation-contract.js';

export function canCompareRankings(snapshot, preview, preopen, date) {
  const stage = snapshot?.meta?.run_stage;
  return snapshot?.mode === 'provider' && snapshot?.meta?.run_date === date &&
    ['forecast', 'open-settlement', 'close-settlement'].includes(stage) &&
    !snapshot?.meta?.test_only && !snapshot?.meta?.historical_test &&
    !snapshot?.meta?.reconstruction && !snapshot?.meta?.retrospective_evaluation &&
    preview?.kind === 'next_preview' && preview.target_date === date &&
    preopen?.kind === 'preopen_ranking' && preopen.target_date === date &&
    /^[A-Za-z0-9._-]+$/.test(preopen.run_id || '') &&
    (stage !== 'forecast' || preopen.run_id === snapshot.meta.run_id);
}

export function rankedRecords(rows) {
  return rows.filter(r => /^\d{6}$/.test(r?.symbol || '') && Number.isFinite(rankingExpectedReturn(r)))
    .sort(compareByExpectedReturn).map((row, index) => ({ symbol: row.symbol, name: row.name || row.symbol, rank: index + 1, expected_open: row.expected_open, expected_close: row.expected_close }));
}
export function rankChanges(preview, preopen, date) {
  if (!preview || !preopen || preview.target_date !== date || preopen.target_date !== date || !Array.isArray(preview.rows) || !Array.isArray(preopen.rows) || !Array.isArray(preview.universe)) return {};
  const prev = new Map(preview.rows.map(r => [r.symbol, r.rank]));
  const universe = new Set(preview.universe);
  return Object.fromEntries(preopen.rows.map(row => {
    if (!Number.isSafeInteger(row.rank) || row.rank < 1) return [row.symbol, { kind: 'unknown' }];
    const before = prev.get(row.symbol);
    if (Number.isSafeInteger(before) && before > 0) return [row.symbol, { kind: 'change', value: before - row.rank }];
    return [row.symbol, { kind: !universe.has(row.symbol) && preview.universe_complete === true ? 'new' : 'unknown' }];
  }));
}
