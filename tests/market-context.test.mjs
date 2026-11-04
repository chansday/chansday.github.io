import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, selectData, formatSummary } from '../scripts/collect-market-context.mjs';

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
  assert.equal(result.sources.us_indices.http_status, 403);
  assert.equal(result.sources.usd_krw.status, 'skipped');
  const summary = formatSummary({ ...result, phase: 'manual' }, 'test.json');
  assert.match(summary, /HTTP 403/);
  assert.match(summary, /source_blocked/);
});

test('diagnostics retain observation timestamps and per-source failures', async () => {
  let calls = 0;
  const messages = [];
  const rows = ['.IXIC', '.INX', '.SOX', '.VIX'].map(reutersCode => ({ reutersCode, localTradedAt: '2026-11-03T16:00:00-05:00', delayTime: 15 }));
  const result = await collect({ log: x => messages.push(x), fetchImpl: async () => {
    calls++;
    if (calls === 1) return Response.json(rows);
    return new Response('unavailable', { status: 500 });
  } });
  assert.equal(result.status, 'partial');
  assert.equal(result.sources.us_indices.observations[0].observed_at, rows[0].localTradedAt);
  assert.equal(result.sources.usd_krw.http_status, 500);
  assert.ok(messages.some(line => line.includes('[us_indices] 성공')));
  assert.ok(messages.some(line => line.includes('[usd_krw] 실패')));
});
