import test from 'node:test';
import assert from 'node:assert/strict';
import { canCompareRankings, rankChanges } from '../providers/rank-change.js';

test('frozen preopen comparison survives settlement while retaining identity guards', () => {
  const date = '2026-11-04';
  const snapshot = {mode: 'provider', meta: {run_date: date, run_stage: 'forecast', run_id: 'forecast.1'}};
  const preview = {kind: 'next_preview', target_date: date, universe: ['000001'], rows: [{symbol: '000001', rank: 3}]};
  const preopen = {kind: 'preopen_ranking', target_date: date, run_id: 'forecast.1', rows: [{symbol: '000001', rank: 2}]};
  assert.equal(canCompareRankings(snapshot, preview, preopen, date), true);
  assert.deepEqual(rankChanges(preview, preopen, date)['000001'], {kind: 'change', value: 1});
  snapshot.meta.run_id = 'settlement.1';
  assert.equal(canCompareRankings(snapshot, preview, preopen, date), false);
  for (const stage of ['open-settlement', 'close-settlement']) {
    snapshot.meta.run_stage = stage;
    assert.equal(canCompareRankings(snapshot, preview, preopen, date), true);
    const currentRanking = {target_date: date, rows: [{symbol: '000001', rank: 5}]};
    assert.deepEqual(rankChanges(preview, currentRanking, date)['000001'], {kind: 'change', value: -2});
  }
  snapshot.meta.test_only = true;
  assert.equal(canCompareRankings(snapshot, preview, preopen, date), false);
  delete snapshot.meta.test_only;
  preopen.target_date = '2026-11-03';
  assert.equal(canCompareRankings(snapshot, preview, preopen, date), false);
});
