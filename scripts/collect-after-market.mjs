import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { checkRobotsUrl } from '../providers/robots-policy.js';
import { isKoreanSymbol } from '../providers/korean-symbol.js';
import { kstDate } from './market-calendar.mjs';

const BASE = 'https://polling.finance.naver.com/api/realtime/domestic/stock/';
const AGENT = 'kospi-signal-board/1.0 (+https://kospi-signal.github.io/)';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function collectAfterMarket({ symbols, fetchImpl = fetch, now = () => new Date(), sleep = pause } = {}) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.some(s => !isKoreanSymbol(s)) || new Set(symbols).size !== symbols.length) throw new Error('Invalid symbols');
  const started = now(), date = kstDate(started);
  const kstHour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Seoul', hour:'2-digit', hourCycle:'h23'}).format(started));
  if (kstHour < 20) throw new Error('After-market collection requires 20:00 KST or later');
  const context = {fetchImpl, now}, batches = [];
  let error = null;
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100), url = BASE + batch.join(',');
    const policy = await checkRobotsUrl(context, url, AGENT, {allowMissing:true});
    if (!policy.ok) { error = `robots: ${policy.reason}`; break; }
    if (i) await sleep(500);
    if (kstDate(now()) !== date) { error = 'Date changed during collection'; break; }
    try {
      const response = await fetchImpl(url, {headers:{Accept:'application/json','User-Agent':AGENT},redirect:'error',signal:AbortSignal.timeout(8000)});
      if (!response.ok || response.headers.get('retry-after')) { error = `HTTP ${response.status}${response.headers.get('retry-after') ? ' Retry-After' : ''}`; break; }
      if (!/application\/(?:[a-z.+-]*\+)?json/i.test(response.headers.get('content-type') || '')) { error = 'Unexpected content type'; break; }
      const payload = await response.json();
      if (!Array.isArray(payload.datas)) { error = 'Malformed response'; break; }
      const returned = payload.datas.map(r => r?.symbolCode || r?.itemCode);
      if (returned.some(s => !batch.includes(s)) || new Set(returned).size !== returned.length) { error = 'Unexpected or duplicate symbols'; break; }
      batches.push({requested:batch, retrieved_at:now().toISOString(), payload});
    } catch (e) { error = `Request failed: ${e.name}`; break; }
  }
  const returned = batches.reduce((n,b) => n + b.payload.datas.length, 0);
  return {schema_version:1, date, started_at:started.toISOString(), completed_at:now().toISOString(), source:BASE, venue:'unconfirmed', license_status:'unconfirmed', requested:symbols.length, returned, status:error ? 'failed' : returned === symbols.length ? 'complete' : 'partial', error, batches};
}

async function main() {
  const universe = JSON.parse(await readFile('data/kospi-universe.json','utf8'));
  const result = await collectAfterMarket({symbols:universe.symbols.map(x => x.symbol)});
  const id = String(process.env.KOSPI_LOCAL_RUN === '1' ? `local-${Date.now()}` : process.env.GITHUB_RUN_ID || `manual-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g,'');
  const attempt = String(process.env.GITHUB_RUN_ATTEMPT || '1').replace(/[^0-9]/g,'') || '1';
  const dir = `data/after-market/${result.date}`;
  await mkdir(dir,{recursive:true});
  const path = `${dir}/${id}-${attempt}.json`;
  await writeFile(path,JSON.stringify(result)+'\n',{flag:'wx'});
  console.log(`After-market ${result.status}: ${result.returned}/${result.requested}; ${path}${result.error ? `; ${result.error}` : ''}`);
  if (result.status !== 'complete') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exitCode=1; });

