import { mkdir, writeFile } from 'node:fs/promises';
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

export async function collect({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const startedAt = now().toISOString(), sources = {};
  for (const [name, url] of Object.entries(SOURCES)) {
    const requestedAt = now().toISOString();
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': 'kospi-signal-market-context/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('content-type') || '').includes('json')) throw new Error('Non-JSON response');
      sources[name] = { status: 'ok', url, requested_at: requestedAt, received_at: now().toISOString(), data: selectData(name, await response.json()) };
    } catch (error) {
      sources[name] = { status: 'error', url, requested_at: requestedAt, received_at: now().toISOString(), error: String(error.message || error) };
      if (/HTTP (403|429)/.test(sources[name].error)) {
        for (const [remaining, remainingUrl] of Object.entries(SOURCES).slice(Object.keys(sources).length)) sources[remaining] = { status: 'skipped', url: remainingUrl, reason: 'source_blocked' };
        break;
      }
    }
  }
  const success = Object.values(sources).filter(x => x.status === 'ok').length;
  return { schema_version: 1, started_at: startedAt, completed_at: now().toISOString(), status: success === Object.keys(SOURCES).length ? 'complete' : success ? 'partial' : 'failed', source: 'naver-unofficial', license_status: 'unconfirmed', sources };
}

export async function run() {
  const phase = process.env.MARKET_CONTEXT_PHASE || 'manual';
  if (!['morning', 'preopen', 'after_close', 'manual'].includes(phase)) throw new Error('Invalid collection phase');
  const snapshot = await collect();
  const date = kstDate(new Date(snapshot.started_at));
  const id = (process.env.GITHUB_RUN_ID || snapshot.started_at.replace(/[^0-9]/g, '')) + '-' + (process.env.GITHUB_RUN_ATTEMPT || '1');
  if (!/^[0-9]+-[0-9]+$/.test(id)) throw new Error('Invalid run identifier');
  const dir = `data/market-context/${date}`;
  const path = `${dir}/${phase}-${id}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ ...snapshot, phase, market_date: date }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ path, status: snapshot.status, sources: Object.fromEntries(Object.entries(snapshot.sources).map(([k,v]) => [k,v.status])) }));
  if (snapshot.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run().catch(e => { console.error(e); process.exitCode = 1; });
