// Loaded by operational workflows after checkout and Node setup. Keep this
// observer independent of response bodies and URL credentials/query strings.
const enabled = !process.env.NODE_TEST_CONTEXT && process.env.KOSPI_REQUEST_AUDIT === '1';
if (enabled) {
  const started = Date.now();
  const script = process.argv[1]?.split(/[\\/]/).pop() || 'node';
  const run = process.env.GITHUB_RUN_ID || 'local';
  let count = 0;
  const log = message => process.stderr.write(`[작업 추적 ${new Date().toISOString()}] run=${run} 작업=${script} ${message}\n`);
  log('시작');
  if (typeof globalThis.fetch === 'function') {
    const original = globalThis.fetch;
    globalThis.fetch = async function(input, init) {
      const requestId = ++count, requestedAt = new Date().toISOString(), start = Date.now();
      let host = 'unknown';
      try { host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host; } catch {}
      const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      log(`요청=${requestId} 시작=${requestedAt} 대상=${host} 방식=${method}`);
      try {
        const response = await original.call(this, input, init);
        log(`요청=${requestId} 대상=${host} HTTP=${response.status} 소요=${Date.now()-start}ms`);
        return response;
      } catch (error) {
        log(`요청=${requestId} 대상=${host} 오류=${error?.name || 'Error'} 소요=${Date.now()-start}ms`);
        throw error;
      }
    };
  }
  process.on('exit', code => log(`종료 코드=${code} 요청=${count} 소요=${Date.now()-started}ms`));
}
