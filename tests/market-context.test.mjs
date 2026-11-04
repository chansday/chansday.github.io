import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, selectData } from '../scripts/collect-market-context.mjs';

test('requires all four US indices and preserves their timestamps', () => {
  const rows = ['.IXIC', '.INX', '.SOX', '.VIX'].map(reutersCode => ({ reutersCode, localTradedAt: '2026-11-03T16:00:00-05:00' }));
  assert.equal(selectData('us_indices', rows).length, 4);
  assert.throws(() => selectData('us_indices', rows.slice(1)));
});
test('records failure and stops requesting after a block', async () => {
  let calls = 0;
  const result = await collect({ fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.sources.us_indices.status, 'error');
  assert.equal(result.sources.usd_krw.status, 'skipped');
});
