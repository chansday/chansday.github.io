import test from 'node:test';
import assert from 'node:assert/strict';
import { compoundPerformance } from '../providers/recent-performance.js';

test('compound returns chronologically from the start and keeps only the latest window', () => {
  const rows = compoundPerformance([
    { date: '2026-10-28', top10: 3, top20: 0 },
    { date: '2026-10-25', top10: 99, top20: 99 },
    { date: '2026-10-26', top10: 2, top20: 2 },
    { date: '2026-10-27', top10: -1, top20: -1 },
  ], '2026-10-26', 2);
  assert.deepEqual(rows.map(r => r.date), ['2026-10-27', '2026-10-28']);
  assert.ok(Math.abs(rows[0].top10 - 0.98) < 1e-9);
  assert.ok(Math.abs(rows[1].top10 - 4.0094) < 1e-9);
});

test('missing daily return stops only its own cumulative series', () => {
  const rows = compoundPerformance([
    {date:'2026-10-26',top10:1,top20:1},
    {date:'2026-10-27',top10:null,top20:2},
    {date:'2026-10-28',top10:2,top20:3},
  ]);
  assert.equal(rows[2].top10, null);
  assert.ok(Math.abs(rows[2].top20 - 6.1106) < 1e-9);
});

test('returns at most the last 10 values without resetting the starting amount', () => {
  const rows = Array.from({length: 35}, (_, i) => ({date:new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0,10), top10:1, top20:0}));
  const result = compoundPerformance(rows);
  assert.equal(result.length, 10);
  assert.equal(result[0].date, rows[25].date);
  assert.ok(Math.abs(result.at(-1).top10 - (1.01 ** 35 - 1) * 100) < 1e-9);
});

