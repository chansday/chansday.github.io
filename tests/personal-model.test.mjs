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

test('a short run of extreme residuals is trimmed and the remaining signal is damped, not taken at face value', () => {
  // A stock that just had a single wild speculative-spike day (+30.6%) among
  // 20 otherwise ordinary residuals -- the top/bottom 2 are trimmed out
  // (dropping the spike and the next-largest day), and because the full
  // sample was far more volatile than what's left after trimming, the
  // confidence that survives is damped further rather than trusted outright.
  const residuals = [
    -0.001004180345762027, 0.008140613394086347, -0.014356600930859654, -0.027810126787660972, -0.03190194848148488,
    0.030034094495554588, 0.049702128302044804, -0.023403313290568408, 0.02078021047862641, -0.01912432240485664,
    0.3060191048632643, -0.07312496516468023, 0.004928577800313782, 0.0763895571441805, 0.08242683056626729,
    0.13896828423974367, -0.0194446742083878, 0.14034631374788833, 0.07719011229718838, 0.049694240359193,
  ];
  const s = personalStats(residuals);
  assert.equal(s.n, 20);
  // Untrimmed stats (what the old formula would have produced) for comparison.
  const untrimmedMean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  assert.ok(untrimmedMean > 0.038 && untrimmedMean < 0.039);
  // Trimming drops the +30.6% spike and the next-highest (+14.0%), plus the
  // two most negative days, so the trimmed mean is noticeably smaller.
  assert.ok(s.mean < untrimmedMean * 0.8, `trimmed mean ${s.mean} should be well below the untrimmed ${untrimmedMean}`);
  assert.ok(s.mean > 0, "the trimmed mean is still positive -- this isn't zeroing out a real signal");
  // The extra volatility dampening shrinks confidence further still: the
  // untrimmed sample's dispersion was dominated by the trimmed-out days.
  const rankOnlyConfidence = (() => {
    const trim = 2, sorted = [...residuals].sort((a, b) => a - b), trimmed = sorted.slice(trim, residuals.length - trim);
    const m = trimmed.length, tm = trimmed.reduce((a, b) => a + b, 0) / m;
    const tsd = Math.sqrt(trimmed.reduce((a, b) => a + (b - tm) ** 2, 0) / (m - 1));
    const t = tm / (tsd / Math.sqrt(m));
    return (20 / 40) * (t * t / (1 + t * t));
  })();
  assert.ok(s.confidence < rankOnlyConfidence, "volatility dampening reduces confidence below the trim-only figure");
  assert.ok(s.confidence > 0 && s.confidence < 0.3);
  assert.ok(Math.abs(s.adjustment - s.mean * s.confidence) < 1e-12);
});

test('trimming leaves small samples (fewer than 10 residuals) unchanged, matching the pre-trim formula', () => {
  const residuals = [0.01, -0.3, 0.02, 0.015, 0.4, -0.02];
  const s = personalStats(residuals);
  const n = residuals.length, m = n ? residuals.reduce((a, b) => a + b, 0) / n : 0;
  const sd = Math.sqrt(residuals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const t = m / (sd / Math.sqrt(n));
  assert.ok(Math.abs(s.mean - m) < 1e-12, "fewer than 10 residuals: floor(n/10) = 0, so nothing is trimmed");
  assert.ok(Math.abs(s.confidence - (n / (n + 20)) * (t * t / (1 + t * t))) < 1e-12, "with no trimming, volatility damping is 1");
});

test('missing historical training data fails explicitly instead of inventing an adjustment', () => {
  assert.throws(() => buildPersonalModel([], '2026-11-06'), /20 prior sessions/);
});

test('the open-settlement daytrade update preserves a personal pre-open ranking', () => {
  const snapshot = { rows: [{ symbol: '005930', expected_close_basis: { model: 'rank_personal_residual_shrink_v1' } }] };
  assert.equal(applyDaytradeToSnapshot(snapshot, { predictions: {} }), snapshot);
});
