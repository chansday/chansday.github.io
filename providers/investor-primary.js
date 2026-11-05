import { checkRobotsUrl } from './robots-policy.js';

// Encoded literals only prevent casual reading; environment values can replace
// them when the caller stores source configuration outside the repository.
const decode = value => Buffer.from(value, 'base64').toString('utf8');
const BASE = process.env.INVESTOR_PRIMARY_ORIGIN || decode('aHR0cHM6Ly9hcGkuYWxwaGFzcXVhcmUuY28ua3I=');
const SUMMARY = decode('L2RhdGEvdjIvc3RvY2svc3VtbWFyeS8=');
const HISTORY = decode('L2RhdGEvdjMvaW52ZXN0b3IvbmV0LXZvbHVtZXMvaGlzdG9yeS8=');
const AGENT = 'kospi-signal-personal-investor-collector/1.0';
const intOrNull = value => Number.isSafeInteger(value) ? value : null;

export function createPrimaryInvestorSource({fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r,ms)), now = () => new Date(), log = () => {}} = {}) {
  let disabled = false, requests = 0;
  const context = {fetchImpl, now};
  async function get(path) {
    if (disabled) throw new Error('primary_disabled');
    const url = new URL(path, BASE);
    const robots = await checkRobotsUrl(context, url.href, AGENT, {allowMissing:true});
    if (!robots.ok) { disabled = true; throw new Error('primary_robots_unavailable_or_disallowed'); }
    if (requests++) await sleep(1000);
    const response = await fetchImpl(url.href, {headers:{Accept:'application/json','User-Agent':AGENT}, redirect:'error', signal:AbortSignal.timeout(12000)});
    if (!response.ok) {
      if ([401,403,429].includes(response.status)) disabled = true;
      throw new Error(`primary_http_${response.status}`);
    }
    if (!/application\/(?:[a-z.+-]*\+)?json/i.test(response.headers.get('content-type') || '')) throw new Error('primary_invalid_content_type');
    const text = await response.text();
    if (text.length > 2000000) throw new Error('primary_response_too_large');
    return JSON.parse(text);
  }
  return async function fetchPrimary(symbol, startDate, endDate, asOfDate) {
    const info = await get(SUMMARY + encodeURIComponent(symbol));
    if (info?.code !== symbol || info.market !== 'kospi' || !Number.isSafeInteger(info.id) || info.id < 1) throw new Error('primary_symbol_mismatch');
    const result = await get(HISTORY + info.id + '?offset=0&limit=60');
    if (!Array.isArray(result?.data)) throw new Error('primary_invalid_history');
    const seen = new Set(), rows = [];
    for (const row of result.data) {
      const date = row?.dt?.slice?.(0,10);
      const parsed = new Date(date+'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date || date > asOfDate || seen.has(date)) throw new Error('primary_invalid_date');
      seen.add(date);
      if (date < startDate || date > endDate) continue;
      rows.push({date, foreign_net_shares:intOrNull(row.net_vol_foreigner), institution_net_shares:intOrNull(row.net_vol_institutional), individual_net_shares:intOrNull(row.net_vol_individual), foreign_holding_pct:null});
    }
    rows.sort((a,b)=>b.date.localeCompare(a.date));
    return {symbol, rows};
  };
}
