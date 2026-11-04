import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { kstDate } from './market-calendar.mjs';

// Public, unofficial Naver responses. No retries or access-control bypass.
export const SOURCES = {
  us_indices: 'https://api.stock.naver.com/index/nation/USA',
  usd_krw: 'https://api.stock.naver.com/marketindex/exchange/FX_USDKRW',
  us_treasury: 'https://m.stock.naver.com/front-api/marketIndex/bondList?countryCode=USA',
  kospi: 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI',
  kospi200: 'https://api.stock.naver.com/chart/domestic/index/KPI200?periodType=dayCandle',
};

export function selectData(name, value) {
  if (name === 'us_indices') {
    if (!Array.isArray(value)) throw new Error('Expected index array');
    const items = value.filter(x => ['.IXIC', '.INX', '.SOX', '.VIX'].includes(x.reutersCode));
    if (items.length !== 4) throw new Error('Missing US index');
    return items;
  }
  if (name === 'usd_krw') {
    if (!value?.exchangeInfo?.localTradedAt || !value.exchangeInfo.closePrice) throw new Error('Missing FX quote');
    return value.exchangeInfo;
  }
  if (name === 'us_treasury') {
    if (!value?.isSuccess || !Array.isArray(value.result)) throw new Error('Missing bond quotes');
    const items = value.result.filter(x => ['US2YT=RR', 'US10YT=RR'].includes(x.reutersCode));
    if (items.length !== 2) throw new Error('Missing US bond quote');
    return items;
  }
  if (name === 'kospi') {
    const row = value?.datas?.find(x => x.itemCode === 'KOSPI');
    if (!row?.localTradedAt || !row.closePriceRaw) throw new Error('Missing KOSPI quote');
    return row;
  }
  if (name === 'kospi200') {
    if (value?.code !== 'KPI200' || !Array.isArray(value.priceInfos) || !value.priceInfos.length) throw new Error('Missing KOSPI200 bars');
    return { code: value.code, latest: value.priceInfos.at(-1) };
  }
  throw new Error('Unknown source');
}

export function describeData(name, data) {
  if (Array.isArray(data)) return data.map(row => ({ code: row.reutersCode, observed_at: row.localTradedAt || null, delay_minutes: row.delayTime ?? null }));
  if (name === 'kospi200') return [{ code: data.code, observed_date: data.latest.localDate || null }];
  return [{ code: data.reutersCode || data.itemCode || name, observed_at: data.localTradedAt || null, delay_minutes: data.delayTime ?? null }];
}

export async function collect({ fetchImpl = fetch, now = () => new Date(), log = () => {} } = {}) {
  const startedAt = now().toISOString(), sources = {};
  log(`수집 시작: ${startedAt} · 출처 ${Object.keys(SOURCES).length}개`);
  for (const [name, url] of Object.entries(SOURCES)) {
    const requestedAt = now().toISOString();
    let httpStatus = null, contentType = null;
    log(`[${name}] 요청 시작: ${requestedAt} · ${url}`);
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': 'kospi-signal-market-context/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      httpStatus = response.status;
      contentType = response.headers.get('content-type');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(contentType || '').includes('json')) throw new Error('Non-JSON response');
      const data = selectData(name, await response.json());
      const receivedAt = now().toISOString();
      sources[name] = { status: 'ok', url, requested_at: requestedAt, received_at: receivedAt, duration_ms: Math.max(0, Date.parse(receivedAt) - Date.parse(requestedAt)), http_status: httpStatus, content_type: contentType, observations: describeData(name, data), data };
      log(`[${name}] 성공: HTTP ${httpStatus} · ${sources[name].duration_ms}ms · 관측 ${JSON.stringify(sources[name].observations)}`);
    } catch (error) {
      const receivedAt = now().toISOString();
      sources[name] = { status: 'error', url, requested_at: requestedAt, received_at: receivedAt, duration_ms: Math.max(0, Date.parse(receivedAt) - Date.parse(requestedAt)), http_status: httpStatus, content_type: contentType, error: String(error.message || error) };
      log(`[${name}] 실패: HTTP ${httpStatus ?? '응답 없음'} · ${sources[name].duration_ms}ms · ${sources[name].error}`);
      if (/HTTP (403|429)/.test(sources[name].error)) {
        for (const [remaining, remainingUrl] of Object.entries(SOURCES).slice(Object.keys(sources).length)) {
          sources[remaining] = { status: 'skipped', url: remainingUrl, reason: 'source_blocked' };
          log(`[${remaining}] 건너뜀: 앞선 요청이 차단됨`);
        }
        break;
      }
    }
  }
  const success = Object.values(sources).filter(x => x.status === 'ok').length;
  const completedAt = now().toISOString();
  const status = success === Object.keys(SOURCES).length ? 'complete' : success ? 'partial' : 'failed';
  log(`수집 종료: ${completedAt} · ${status} · 성공 ${success}/${Object.keys(SOURCES).length}`);
  return { schema_version: 1, started_at: startedAt, completed_at: completedAt, duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), status, source: 'naver-unofficial', license_status: 'unconfirmed', sources };
}

export function formatSummary(snapshot, path) {
  const lines = ['## 시장 환경 수집 결과', '', `- 단계: ${snapshot.phase}`, `- 상태: ${snapshot.status}`, `- 실제 시작: ${snapshot.started_at}`, `- 종료: ${snapshot.completed_at}`, `- 저장 파일: \`${path}\``, '', '| 출처 | 결과 | HTTP | 소요(ms) | 원천 관측 시각 / 날짜 | 오류 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const [name, row] of Object.entries(snapshot.sources)) {
    const observations = (row.observations || []).map(x => `${x.code}: ${x.observed_at || x.observed_date || '없음'}${x.delay_minutes != null ? ` (지연 ${x.delay_minutes}분)` : ''}`).join('<br>') || '—';
    const error = String(row.error || row.reason || '—').replace(/[|\r\n]/g, ' ');
    lines.push(`| ${name} | ${row.status} | ${row.http_status ?? '—'} | ${row.duration_ms ?? '—'} | ${observations} | ${error} |`);
  }
  lines.push('', '단계명은 예정 시각이며 실제 수집 시각과 다를 수 있습니다.', '');
  return lines.join('\n');
}

export async function run() {
  const phase = process.env.MARKET_CONTEXT_PHASE || 'manual';
  if (!['morning', 'preopen', 'after_close', 'manual'].includes(phase)) throw new Error('Invalid collection phase');
  const snapshot = await collect({ log: line => console.log(line) });
  const date = kstDate(new Date(snapshot.started_at));
  const id = (process.env.GITHUB_RUN_ID || snapshot.started_at.replace(/[^0-9]/g, '')) + '-' + (process.env.GITHUB_RUN_ATTEMPT || '1');
  if (!/^[0-9]+-[0-9]+$/.test(id)) throw new Error('Invalid run identifier');
  const dir = `data/market-context/${date}`;
  const path = `${dir}/${phase}-${id}.json`;
  await mkdir(dir, { recursive: true });
  const record = { ...snapshot, phase, market_date: date };
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ path, status: snapshot.status, sources: Object.fromEntries(Object.entries(snapshot.sources).map(([k,v]) => [k,v.status])) }));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatSummary(record, path));
  if (snapshot.status === 'partial') console.warn('::warning::시장 환경 데이터 일부를 수집하지 못했습니다. 상세 요약을 확인하세요.');
  if (snapshot.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run().catch(e => { console.error(e); process.exitCode = 1; });
