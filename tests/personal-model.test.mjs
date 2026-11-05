import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalStats, buildPersonalModel } from '../providers/personal-model.js';
import { applyDaytradeToSnapshot } from '../scripts/daytrade-signal.mjs';

test('personal correction uses sample variance and shrinks by sample size and t statistic', () => {
  const s = personalStats([0.01, 0.03]);
  const t = 0.02 / (Math.sqrt(0.0002) / Math.sqrt(2));
  assert.ok(Math.abs(s.mean - 0.02) < 1e-12);
  assert.ok(Math.abs(s.confidence - (2 / 22) * t ** 2 / (1 + t ** 2)) < 1e-12);
  assert.ok(Math.abs(s.adjustment - s.mean * s.confidence) < 1e-12);
  assert.equal(personalStats([]).adjustment, 0);
  assert.equal(personalStats([0.1, 0.1]).adjustment, 0);
});

test('missing historical training data fails explicitly instead of inventing an adjustment', () => {
  assert.throws(() => buildPersonalModel([], '2026-11-06'), /20 prior sessions/);
});

test('the open-settlement daytrade update preserves a personal pre-open ranking', () => {
  const snapshot = { rows: [{ symbol: '005930', expected_close_basis: { model: 'rank_personal_residual_shrink_v1' } }] };
  assert.equal(applyDaytradeToSnapshot(snapshot, { predictions: {} }), snapshot);
});
