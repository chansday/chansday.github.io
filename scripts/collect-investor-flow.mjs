import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isKoreanSymbol} from '../providers/korean-symbol.js';
import {createProgressLog,formatDuration} from '../providers/progress-log.js';
import {parseInvestorFlow} from '../providers/investor-flow.js';
import {createInvestorRequester,INVESTOR_USER_AGENTS} from '../providers/investor-request.js';
import {kstDate,isValidDate,loadMarketCalendar,classifyMarketDate} from './market-calendar.mjs';
const BASE='https://m.stock.naver.com/api/stock/',USER_AGENT=INVESTOR_USER_AGENTS[0];
export function tradingDates(start,end,calendar){
  if(!isValidDate(start)||!isValidDate(end)||start>end)throw new Error('Invalid date range');
  const d=new Date(`${start}T00:00:00Z`),last=new Date(`${end}T00:00:00Z`),days=[];
  if((last-d)/86400000>366)throw new Error('Date range exceeds one year');
  while(d<=last){const date=d.toISOString().slice(0,10),state=classifyMarketDate(date,calendar);if(state.status==='error')throw new Error(state.message);if(state.status==='run')days.push(date);d.setUTCDate(d.getUTCDate()+1);}
  if(!days.length)throw new Error('Date range has no trading days');return days;
}
export async function collectInvestorFlow(symbols,{startDate,endDate,expectedDates,fetchImpl=globalThis.fetch,now=()=>new Date(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),delayMs=1000,log=createProgressLog({label:'투자자 수집',now})}={}){
  if(!Array.isArray(symbols)||!symbols.length||symbols.some(s=>!isKoreanSymbol(s))||new Set(symbols).size!==symbols.length)throw new Error('Invalid or duplicate stock codes');
  const asOfDate=kstDate(now());if(!isValidDate(startDate)||!isValidDate(endDate)||startDate>endDate||endDate>asOfDate||!Array.isArray(expectedDates)||!expectedDates.length)throw new Error('Invalid date range');
  if(delayMs<1000)throw new Error('Request interval must be at least one second');
  const startedAt=now().toISOString(),collected=[],failures=[],incomplete=[],request=createInvestorRequester({fetchImpl,sleep,log});
  log(`시작 · 기간 ${startDate}~${endDate} · 대상 ${symbols.length}종목 · 요청 간격 ${delayMs}ms`);
  for(let i=0;i<symbols.length;i++){
    const symbol=symbols[i];if(i)await sleep(delayMs);
    try{
      const result=await request(`${BASE}${symbol}/trend`,symbol);
      if(result.error)throw result.error;
      const response=result.response;
      if(!response.ok){log(`수집 중단 · ${symbol} · HTTP ${response.status} · 추가 요청 없음`);failures.push({symbol,reason:`HTTP_${response.status}`});break;}
      if(!/application\/(?:[a-z.+-]*\+)?json/i.test(response.headers.get('content-type')||'')){log(`수집 중단 · ${symbol} · 예상과 다른 응답 형식`);failures.push({symbol,reason:'unexpected_content_type'});break;}
      const text=await response.text();if(text.length>2_000_000){failures.push({symbol,reason:'response_too_large'});break;}
      const item=parseInvestorFlow(JSON.parse(text),symbol,startDate,endDate,asOfDate),available=new Set(item.rows.map(r=>r.date));
      item.missing_dates=expectedDates.filter(date=>!available.has(date));
      if(item.missing_dates.length||item.rows.some(r=>r.foreign_net_shares===null||r.institution_net_shares===null||r.individual_net_shares===null))incomplete.push(symbol);
      collected.push(item);
      if((i+1)%25===0||i+1===symbols.length){const elapsed=Math.max(0,now().getTime()-Date.parse(startedAt));log(`진행 ${i+1}/${symbols.length} (${Math.round((i+1)*100/symbols.length)}%) · 경과 ${formatDuration(elapsed)} · 남은 예상 ${formatDuration(elapsed/(i+1)*(symbols.length-i-1))} · 누락 ${incomplete.length}종목`);}
    }catch(error){log(`수집 중단 · ${symbol} · ${error.name==='TimeoutError'?'시간 초과':'요청 또는 응답 오류'} · 추가 요청 없음`);failures.push({symbol,reason:error.name==='TimeoutError'?'timeout':'request_or_response_error'});break;}
  }
  log(`종료 · 수집 ${collected.length}/${symbols.length}종목 · 누락 ${incomplete.length} · 오류 ${failures.length}`);
  return {schema_version:1,kind:'personal_investor_flow',status:failures.length||incomplete.length?'partial':'ready',started_at:startedAt,completed_at:now().toISOString(),collection_date:asOfDate,start_date:startDate,end_date:endDate,expected_dates:expectedDates,source:'naver-mobile-trend',unit:'shares',exchange_basis:'unconfirmed',requested:symbols.length,collected:collected.length,incomplete_symbols:incomplete,failures,stocks:collected};
}
export async function saveInvestorDays(result, directory='data/investor-flow') {
  const days=new Map();
  for (const stock of result.stocks) for (const row of stock.rows) {
    if (!isValidDate(row.date) || !isKoreanSymbol(stock.symbol)) throw new Error('Invalid investor row');
    if (!days.has(row.date)) days.set(row.date,{});
    days.get(row.date)[stock.symbol]={foreign_net_shares:row.foreign_net_shares,individual_net_shares:row.individual_net_shares,institution_net_shares:row.institution_net_shares};
  }
  await mkdir(directory,{recursive:true});
  for (const [date, incoming] of days) {
    const path=`${directory}/${date}.json`;
    let existing={};
    try { const previous=JSON.parse(await readFile(path,'utf8')); if(previous.date!==date || !previous.stocks || typeof previous.stocks!=='object') throw new Error('Invalid previous daily data'); existing=previous.stocks; }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    for(const [symbol,row] of Object.entries(incoming)) {
      const prior=existing[symbol] || {};
      for(const field of ['foreign_net_shares','individual_net_shares','institution_net_shares']) if(Number.isSafeInteger(row[field])) prior[field]=row[field];
      existing[symbol]=prior;
    }
    await writeFile(path,JSON.stringify({date,unit:'shares',source:'naver-mobile-trend',stocks:existing})+'\n');
  }
}
export async function main(argv=process.argv.slice(2)){
  let mode=null,symbol=null,startDate=null,endDate=null;
  for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--all')mode='all';else if(a==='--symbol'){mode='symbol';symbol=argv[++i]?.toUpperCase();}else if(a==='--date'){startDate=endDate=argv[++i];}else if(a==='--from')startDate=argv[++i];else if(a==='--to')endDate=argv[++i];else throw new Error(`Unknown argument: ${a}`);}
  if(!mode)throw new Error('Specify --all or --symbol 011420');
  if(!startDate&&!endDate)startDate=endDate=kstDate();if(!startDate||!endDate)throw new Error('Specify both --from and --to');
  const expectedDates=tradingDates(startDate,endDate,await loadMarketCalendar());
  const universe=mode==='all'?JSON.parse(await readFile('data/kospi-universe.json','utf8')):null,symbols=mode==='all'?universe.symbols.map(x=>x.symbol):[symbol];
  const result=await collectInvestorFlow(symbols,{startDate,endDate,expectedDates});
  await saveInvestorDays(result);
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`saved=true\nstatus=${result.status}\ncount=${result.collected}\nrequested=${result.requested}\nincomplete=${result.incomplete_symbols.length}\n`);
  console.log(`Collection ${result.status}: ${result.collected}/${result.requested}; saved public daily investor flow`);
  if(result.failures.length)process.exitCode=2;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
