// Timestamped progress lines for the GitHub Actions jobs, which stream stdout
// live while a step runs. Each line carries the UTC time, the KST clock time and
// the time elapsed since the logger was created:
//   [label 2026-10-30T05:12:30.120Z | 14:12:30 KST | +0m34s] message
// Silent under `node --test` (NODE_TEST_CONTEXT) so test output stays readable.
export const PROGRESS_EVERY = 50;

const env = () => globalThis.process?.env || {};
const defaultWrite = (line) => { if (!env().NODE_TEST_CONTEXT) console.log(line); };

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function createProgressLog({ label, now = () => new Date(), write = defaultWrite } = {}) {
  const t0 = now().getTime();
  const log = (message) => {
    const at = now(), kst = new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(11, 19);
    write(`[${label} ${at.toISOString()} | ${kst} KST | +${formatDuration(at.getTime() - t0)}] ${message}`);
  };
  // Times one phase: logs its start, then its end (or failure) with the duration.
  log.phase = async (name, task, summary = () => "") => {
    const started = now().getTime();
    log(`${name} 시작`);
    try {
      const result = await task();
      log(`${name} 완료 (${formatDuration(now().getTime() - started)}) ${summary(result) || ""}`.trimEnd());
      return result;
    } catch (error) {
      log(`${name} 실패 (${formatDuration(now().getTime() - started)}) · ${error.message}`);
      throw error;
    }
  };
  return log;
}

// Per-symbol collection progress (onProgress of collectNaverDailyRows), logged
// every PROGRESS_EVERY symbols and on the last one.
export function collectionProgress(log) {
  let maxMs = 0;
  return ({ done, total, symbol, elapsedMs, lastMs, observations, rejected }) => {
    maxMs = Math.max(maxMs, lastMs ?? 0);
    if (done % PROGRESS_EVERY && done !== total) return;
    const perSymbol = elapsedMs / done;
    log(`수집 ${done}/${total} (${Math.round((done / total) * 100)}%) · 경과 ${formatDuration(elapsedMs)} · 남은 예상 ${formatDuration(perSymbol * (total - done))} · 평균 ${(perSymbol / 1000).toFixed(2)}s/종목 · 마지막 요청 ${lastMs ?? "-"}ms (${symbol}) · 최대 요청 ${maxMs}ms · 일봉 ${observations}행 · 제외 ${rejected}건`);
  };
}
