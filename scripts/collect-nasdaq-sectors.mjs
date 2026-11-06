import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { kstDate } from './market-calendar.mjs';

// NASDAQ's own broad sector indexes (api.nasdaq.com). Public, unofficial. No retries or access-control bypass.
export const SECTORS = {
  IXCO: '컴퓨터',
  IXTC: '통신',
  IXFN: '기타금융',
  IXBK: '은행',
  IXIS: '보험',
  IXHC: '헬스케어',
  IXTR: '운송',
  NBI: '바이오테크',
  IXID: '산업',
  IXF: '금융100',
};

// Finer-grained NASDAQ/PHLX industry indexes, pulled from the same api.nasdaq.com index
// catalog (api/screener/index). Excludes broad composites, bond/volatility/regional indexes.
export const SUB_SECTORS = {
  SOX: '반도체',
  HGX: '주택',
  OSX: '오일서비스',
  UTY: '유틸리티',
  XAU: '금/은',
  QNET: '인터넷',
  NDXT: '나스닥100 기술',
  NDXX: '나스닥100 비기술',
  NBIJR: '중소형 바이오테크',
  NQCYBRT: '사이버보안',
  CELS: '클린에너지',
  CPQ: '클라우드컴퓨팅',
  BKX: '은행(KBW)',
};

export const ALL_SECTORS = { ...SECTORS, ...SUB_SECTORS };
function groupOf(symbol) {
  return symbol in SECTORS ? 'sector' : 'sub_sector';
}

function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function selectData(symbol, value) {
  const data = value?.data;
  if (!data || data.symbol?.toUpperCase() !== symbol) throw new Error('Unexpected quote payload');
  const price = parseNumber(data.primaryData?.lastSalePrice);
  const netChange = parseNumber(data.primaryData?.netChange);
  const percentChange = parseNumber(data.primaryData?.percentageChange);
  const previousClose = parseNumber(data.keyStats?.previousclose?.value);
  const [low, high] = (data.keyStats?.dayrange?.value || '').split(' - ').map(parseNumber);
  if (price === null || previousClose === null || low === null || high === null) throw new Error('Missing sector index fields');
  return {
    name: data.companyName,
    price,
    net_change: netChange,
    percent_change: percentChange,
    previous_close: previousClose,
    day_low: low,
    day_high: high,
    delta_indicator: data.primaryData?.deltaIndicator,
    is_real_time: data.primaryData?.isRealTime ?? null,
    market_status: data.marketStatus,
    last_trade_at: data.primaryData?.lastTradeTimestamp,
  };
}

// NASDAQ publishes this table's "today" row with a lag (sometimes a day or two), so it's
// kept as a best-effort supplement rather than the primary open/close record. It's the only
// source of real OHLC + volume bars, useful later for backtesting/backfilling the sector data.
export function selectHistorical(symbol, value) {
  const data = value?.data;
  if (!data || data.symbol?.toUpperCase() !== symbol) throw new Error('Unexpected historical payload');
  const rows = data.tradesTable?.rows;
  if (!Array.isArray(rows)) throw new Error('Missing historical rows');
  return rows.map(row => ({
    date: row.date,
    open: parseNumber(row.open),
    high: parseNumber(row.high),
    low: parseNumber(row.low),
    close: parseNumber(row.close),
    volume: row.volume === '--' ? null : parseNumber(row.volume),
  }));
}

function historicalWindow(now) {
  const to = now();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const iso = d => d.toISOString().slice(0, 10);
  return { fromdate: iso(from), todate: iso(to) };
}

async function fetchHistorical(symbol, fetchImpl, now) {
  try {
    const { fromdate, todate } = historicalWindow(now);
    const response = await fetchImpl(`https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=INDEX&fromdate=${fromdate}&todate=${todate}&limit=20`, {
      headers: { 'User-Agent': 'kospi-signal-nasdaq-sectors/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return selectHistorical(symbol, await response.json());
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

export async function collect({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const startedAt = now().toISOString(), sectors = {};
  for (const symbol of Object.keys(ALL_SECTORS)) {
    const requestedAt = now().toISOString();
    try {
      const response = await fetchImpl(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=INDEX`, {
        headers: { 'User-Agent': 'kospi-signal-nasdaq-sectors/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('content-type') || '').includes('json')) throw new Error('Non-JSON response');
      sectors[symbol] = { status: 'ok', group: groupOf(symbol), requested_at: requestedAt, received_at: now().toISOString(), data: selectData(symbol, await response.json()) };
      sectors[symbol].historical = await fetchHistorical(symbol, fetchImpl, now);
    } catch (error) {
      sectors[symbol] = { status: 'error', group: groupOf(symbol), requested_at: requestedAt, received_at: now().toISOString(), error: String(error.message || error) };
      if (/HTTP (403|429)/.test(sectors[symbol].error)) {
        for (const remaining of Object.keys(ALL_SECTORS).slice(Object.keys(sectors).length)) sectors[remaining] = { status: 'skipped', group: groupOf(remaining), reason: 'source_blocked' };
        break;
      }
    }
  }
  const success = Object.values(sectors).filter(x => x.status === 'ok').length;
  return { schema_version: 1, started_at: startedAt, completed_at: now().toISOString(), status: success === Object.keys(ALL_SECTORS).length ? 'complete' : success ? 'partial' : 'failed', source: 'nasdaq-unofficial', license_status: 'unconfirmed', sectors };
}

export async function run() {
  const phase = process.env.NASDAQ_SECTORS_PHASE || 'manual';
  if (!['open', 'close', 'manual'].includes(phase)) throw new Error('Invalid collection phase');
  const snapshot = await collect();
  const date = kstDate(new Date(snapshot.started_at));
  const id = (process.env.GITHUB_RUN_ID || snapshot.started_at.replace(/[^0-9]/g, '')) + '-' + (process.env.GITHUB_RUN_ATTEMPT || '1');
  if (!/^[0-9]+-[0-9]+$/.test(id)) throw new Error('Invalid run identifier');
  const dir = `data/nasdaq-sectors/${date}`;
  const path = `${dir}/${phase}-${id}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ ...snapshot, phase, market_date: date }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ path, status: snapshot.status, sectors: Object.fromEntries(Object.entries(snapshot.sectors).map(([k, v]) => [k, v.status])) }));
  if (snapshot.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run().catch(e => { console.error(e); process.exitCode = 1; });
