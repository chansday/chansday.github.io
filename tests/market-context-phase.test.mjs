import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('workflow preserves an explicit phase and maps scheduled and manual runs', () => {
  const workflow = readFileSync('.github/workflows/market-context.yml', 'utf8').replace(/\r\n/g, '\n');
  const block = workflow.match(/          if \[ -z "\$\{MARKET_CONTEXT_PHASE:-\}" \]; then[\s\S]*?          fi\n/);
  assert.ok(block, 'phase-selection shell block must exist');
  const script = `${block[0]}\nprintf '%s' "$MARKET_CONTEXT_PHASE"`;
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const shell = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
  const run = (schedule, phase) => execFileSync(shell, ['-c', script], { encoding: 'utf8', env: { ...process.env, SCHEDULE: schedule, MARKET_CONTEXT_PHASE: phase } });
  assert.equal(run('', 'preopen'), 'preopen');
  assert.equal(run('', ''), 'manual');
  assert.equal(run('30 22 * * 0-4', ''), 'morning');
  assert.equal(run('20 23 * * 0-4', ''), 'preopen');
  assert.equal(run('40 7 * * 1-5', ''), 'after_close');
});
