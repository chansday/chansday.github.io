import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isKoreanSymbol} from '../providers/korean-symbol.js';
import {createProgressLog,formatDuration} from '../providers/progress-log.js';
import {parseInvestorFlow} from '../providers/investor-flow.js';
import {createPrimaryInvestorSource} from '../providers/investor-primary.js';
import {createInvestorRequester,formatRequestStats,INVESTOR_USER_AGENTS} from '../providers/investor-request.js';
import {kstDate,isValidDate,loadMarketCalendar,classifyMarketDate} from './market-calendar.mjs';
const BASE=process.env.INVESTOR_SECONDARY_ORIGIN || Buffer.from('aHR0cHM6Ly9tLnN0b2NrLm5hdmVyLmNvbS9hcGkvc3RvY2sv','base64').toString('utf8');
export function tradingDates(start,end,calendar){
  if(!isValidDate(start)||!isValidDate(end)||start>end)throw new Error('Invalid date range');
  const d=new Date(`${start}T00:00:00Z`),last=new Date(`${end}T00:00:00Z`),days=[];
  if((last-d)/86400000>366)throw new Error('Date range exceeds one year');
  while(d<=last){const date=d.toISOString().slice(0,10),state=classifyMarketDate(date,calendar);if(state.status==='error')throw new Error(state.message);if(state.status==='run')days.push(date);d.setUTCDate(d.getUTCDate()+1);}
  if(!days.length)throw new Error('Date range has no trading days');return days;
}
// Publication probe: with several symbols, PROBE_SYMBOL (traded every session)
// is requested first; if the source has no row for endDate yet, collection
// stops after that one request with status 'not_published' (not a failure).
export const PROBE_SYMBOL='005930';
export async function collectInvestorFlow(symbols,{probeSymbol=PROBE_SYMBOL,startDate,endDate,expectedDates,fetchImpl=globalThis.fetch,now=()=>new Date(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),delayMs=1500,log=createProgressLog({label:'투자자 수집',now}),usePrimary=true,primaryFetch=null}={}){
  if(!Array.isArray(symbols)||!symbols.length||symbols.some(s=>!isKoreanSymbol(s))||new Set(symbols).size!==symbols.length)throw new Error('Invalid or duplicate stock codes');
  const asOfDate=kstDate(now());if(!isValidDate(startDate)||!isValidDate(endDate)||startDate>endDate||endDate>asOfDate||!Array.isArray(expectedDates)||!expectedDates.length)throw new Error('Invalid date range');
  if(delayMs<1000)throw new Error('Request interval must be at least one second');
  const startedAt=now().toISOString(),collected=[],failures=[],incomplete=[],request=createInvestorRequester({fetchImpl,sleep,log});
  const primary=primaryFetch || createPrimaryInvestorSource({fetchImpl,sleep,now,log,requestIntervalMs:delayMs/2});
  const fields=['foreign_net_shares','institution_net_shares','individual_net_shares'];
  log(`시작 · 기간 ${startDate}~${endDate} · 대상 ${symbols.length}종목 · 우선 수집 후 누락값 보조 수집 · 종목당 대기 약 ${delayMs}ms`);
  if(symbols.length>1&&symbols.includes(probeSymbol))symbols=[probeSymbol,...symbols.filter(s=>s!==probeSymbol)];
  let notPublished=false;
  for(let i=0;i<symbols.length;i++){
    const symbol=symbols[i];if(i&&!usePrimary)await sleep(delayMs);
    try{
      let item={symbol,rows:[]};
      if(usePrimary) {
        try { item=await primary(symbol,startDate,endDate,asOfDate); }
        catch(error) { log(`우선 수집 실패 · ${symbol} · ${String(error.message||error).slice(0,100)} · 보조 수집 시도`); }
      }
      const primaryByDate=new Map(item.rows.map(row=>[row.date,row]));
      const fieldSources=new Map(item.rows.map(row=>[row.date,Object.fromEntries(fields.filter(field=>Number.isSafeInteger(row[field])).map(field=>[field,'primary']))]));
      const needsFallback=expectedDates.some(date=>{const row=primaryByDate.get(date);return !row||fields.some(field=>!Number.isSafeInteger(row[field]));});
      if(needsFallback){
      if(usePrimary) await sleep(delayMs);
      try {
      const result=await request(`${BASE}${symbol}/trend`,symbol);
      if(result.error)throw result.error;
      const response=result.response;
      if(!response.ok)throw new Error(`HTTP_${response.status}`);
      if(!/application\/(?:[a-z.+-]*\+)?json/i.test(response.headers.get('content-type')||''))throw new Error('unexpected_content_type');
      const text=await response.text();if(text.length>2_000_000)throw new Error('response_too_large');
      const fallback=parseInvestorFlow(JSON.parse(text),symbol,startDate,endDate,asOfDate);
      for(const row of fallback.rows){
        const prior=primaryByDate.get(row.date);
        if(!prior){primaryByDate.set(row.date,row);fieldSources.set(row.date,Object.fromEntries(fields.filter(field=>Number.isSafeInteger(row[field])).map(field=>[field,'naver'])));continue;}
        for(const field of fields) if(!Number.isSafeInteger(prior[field]) && Number.isSafeInteger(row[field])) {prior[field]=row[field]; const sources=fieldSources.get(row.date)||{};sources[field]='naver';fieldSources.set(row.date,sources);}
      }
      item.rows=[...primaryByDate.values()].sort((a,b)=>b.date.localeCompare(a.date));
      } catch(error) {
        if(!item.rows.length) {log(`수집 중단 · ${symbol} · ${String(error.message||error).replace('_',' ')} · 추가 요청 없음`);failures.push({symbol,reason:String(error.message||error)});break;}
        log(`보조 수집 실패 · ${symbol} · 우선 수집 값은 보존`);
      }
      }
      const available=new Set(item.rows.map(r=>r.date));
      item.missing_dates=expectedDates.filter(date=>!available.has(date));
      for(const row of item.rows) log(`종목 결과 · ${symbol} · ${row.date} · 외국인 ${row.foreign_net_shares ?? '-'} (${fieldSources.get(row.date)?.foreign_net_shares || '-'}) · 개인 ${row.individual_net_shares ?? '-'} (${fieldSources.get(row.date)?.individual_net_shares || '-'}) · 기관 ${row.institution_net_shares ?? '-'} (${fieldSources.get(row.date)?.institution_net_shares || '-'})`);
      if(item.missing_dates.length||item.rows.some(r=>r.foreign_net_shares===null||r.institution_net_shares===null||r.individual_net_shares===null))incomplete.push(symbol);
      if(i===0&&symbols.length>1&&symbol===probeSymbol&&!available.has(endDate)){notPublished=true;log(`게시 전 · 확인 종목 ${symbol}에 ${endDate} 행이 없음(최신 ${item.rows[0]?.date??'-'}) · 소스가 아직 게시하지 않은 것으로 보고 나머지 ${symbols.length-1}종목은 요청하지 않음`);break;}
      collected.push(item);
      if((i+1)%25===0||i+1===symbols.length){const elapsed=Math.max(0,now().getTime()-Date.parse(startedAt)),st=request.stats();log(`진행 ${i+1}/${symbols.length} (${Math.round((i+1)*100/symbols.length)}%) · 경과 ${formatDuration(elapsed)} · 남은 예상 ${formatDuration(elapsed/(i+1)*(symbols.length-i-1))} · 누락 ${incomplete.length}종목 · 보조 요청 ${st.requests} · UA 전환 ${st.ua_switches} · 재시도 ${st.rate_limit_waits+st.transient_retries} · ${st.current_user_agent}`);}
    }catch(error){log(`수집 중단 · ${symbol} · ${error.name==='TimeoutError'?'시간 초과':'요청 또는 응답 오류'} (${error.name}: ${String(error.message||'').slice(0,120)}) · 추가 요청 없음`);failures.push({symbol,reason:error.name==='TimeoutError'?'timeout':'request_or_response_error'});break;}
  }
  const requestStats=request.stats();
  log(`종료 · 수집 ${collected.length}/${symbols.length}종목 · 누락 ${incomplete.length} · 오류 ${failures.length}${failures.length?` (${failures.map(f=>`${f.symbol} ${f.reason}`).join(', ')})`:''}`);
  log(`보조 출처 요청 통계 · ${formatRequestStats(requestStats)}`);
  if(incomplete.length)log(`누락 종목 ${incomplete.length}개 · ${incomplete.slice(0,30).join(', ')}${incomplete.length>30?' …':''}`);
  return {schema_version:1,kind:'personal_investor_flow',status:notPublished?'not_published':failures.length||incomplete.length?'partial':'ready',started_at:startedAt,completed_at:now().toISOString(),collection_date:asOfDate,start_date:startDate,end_date:endDate,expected_dates:expectedDates,source:'primary-secondary',unit:'shares',exchange_basis:'unconfirmed',request_stats:requestStats,requested:symbols.length,collected:collected.length,incomplete_symbols:incomplete,failures,stocks:collected};
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
    await writeFile(path,JSON.stringify({date,unit:'shares',source:result.source || 'naver-mobile-trend',stocks:existing})+'\n');
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
  const saved=result.status!=='not_published';
  if(saved)await saveInvestorDays(result);
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`saved=${saved}\nstatus=${result.status}\ncount=${result.collected}\nrequested=${result.requested}\nincomplete=${result.incomplete_symbols.length}\n`);
  console.log(saved?`Collection ${result.status}: ${result.collected}/${result.requested}; saved public daily investor flow`:`Collection not_published: the source has no ${endDate} row yet; nothing saved`);
  if(process.env.GITHUB_STEP_SUMMARY){const st=result.request_stats,lines=['### 매매동향 수집 요청 통계',`- 기간: ${startDate}~${endDate} · 수집 ${result.collected}/${result.requested} · 상태 ${result.status}`,`- 보조 출처: ${formatRequestStats(st)}`,`- 실패: ${result.failures.map(f=>`${f.symbol} ${f.reason}`).join(', ')||'없음'}`,'','| User-Agent | 성공 |','| --- | --- |',...Object.entries(st.ua_success).map(([k,v])=>`| ${k} | ${v} |`)];await appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');}
  if(result.failures.length)process.exitCode=2;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
