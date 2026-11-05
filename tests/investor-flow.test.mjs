import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {parseInvestorFlow} from '../providers/investor-flow.js';
import {createPrimaryInvestorSource} from '../providers/investor-primary.js';
import {encryptInvestorData,decryptInvestorData} from '../providers/private-envelope.js';
import {collectInvestorFlow,tradingDates} from '../scripts/collect-investor-flow.mjs';
import {loadMarketCalendar} from '../scripts/market-calendar.mjs';
import {INVESTOR_USER_AGENTS} from '../providers/investor-request.js';
const payload=[{itemCode:'011420',bizdate:'20261102',foreignerPureBuyQuant:'-1,702',organPureBuyQuant:'-32',individualPureBuyQuant:'+1,734',foreignerHoldRatio:'5.31%'},{itemCode:'011420',bizdate:'20261030',foreignerPureBuyQuant:'0',organPureBuyQuant:'-',individualPureBuyQuant:'-',foreignerHoldRatio:'-'}];
const response=(status,body=payload,headers={'content-type':'application/json'})=>({status,ok:status>=200&&status<300,headers:new Headers(headers),text:async()=>JSON.stringify(body)});
const options={usePrimary:false,startDate:'2026-10-30',endDate:'2026-11-02',expectedDates:['2026-10-30','2026-11-02'],now:()=>new Date('2026-11-03T11:15:00Z')};
test('investor values preserve signs, missing values, dates, and units',()=>{
 const r=parseInvestorFlow(payload,'011420','2026-10-30','2026-11-02','2026-11-03');assert.deepEqual(r.rows[0],{date:'2026-11-02',foreign_net_shares:-1702,institution_net_shares:-32,individual_net_shares:1734,foreign_holding_pct:5.31});assert.equal(r.rows[1].foreign_net_shares,0);assert.equal(r.rows[1].individual_net_shares,null);
 assert.throws(()=>parseInvestorFlow(payload,'005930','2026-10-30','2026-11-02','2026-11-03'));assert.throws(()=>parseInvestorFlow(payload,'011420','2026-10-30','2026-11-02','2026-11-01'));
 const one=parseInvestorFlow(payload,'011420','2026-10-30','2026-10-30','2026-11-03');assert.equal(one.rows.length,1);assert.equal(one.rows[0].date,'2026-10-30');
});
test('encrypted files authenticate data and require the matching private key',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),other=generateKeyPairSync('rsa',{modulusLength:2048});const data={stocks:payload};const encrypted=encryptInvestorData(data,publicKey);assert.ok(!encrypted.includes('011420'));assert.deepEqual(decryptInvestorData(encrypted,privateKey),data);assert.throws(()=>decryptInvestorData(encrypted,other.privateKey));let box=JSON.parse(encrypted);box.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>decryptInvestorData(JSON.stringify(box),privateKey));
});
test('collects sequentially and retries one 429 after instructed delay',async()=>{
 let calls=0,waits=[];const result=await collectInvestorFlow(['011420'],{...options,fetchImpl:async()=>++calls===1?response(429,{}, {'retry-after':'7'}):response(200),sleep:async ms=>waits.push(ms)});assert.equal(calls,2);assert.deepEqual(waits,[7000]);assert.equal(result.status,'partial');assert.deepEqual(result.incomplete_symbols,['011420']);assert.equal(result.stocks[0].rows[0].individual_net_shares,1734);
});
test('missing historical dates remain explicit',async()=>{
 const result=await collectInvestorFlow(['011420'],{...options,expectedDates:['2026-10-29','2026-10-30','2026-11-02'],fetchImpl:async()=>response(200),sleep:async()=>{}});assert.deepEqual(result.stocks[0].missing_dates,['2026-10-29']);assert.equal(result.status,'partial');
});
test('access denial rotates every User-Agent, then stops without requesting other symbols',async()=>{
 const agents=[];const result=await collectInvestorFlow(['011420','005930'],{...options,fetchImpl:async(url,init)=>{agents.push(init.headers['User-Agent']);return response(403)},sleep:async()=>{}});assert.equal(agents.length,INVESTOR_USER_AGENTS.length);assert.deepEqual(agents,[...INVESTOR_USER_AGENTS]);assert.equal(result.status,'partial');assert.equal(result.collected,0);assert.equal(result.failures[0].reason,'HTTP_403');
});
test('prevents future and sub-second collection',async()=>{
 await assert.rejects(collectInvestorFlow(['011420'],{...options,delayMs:999}));await assert.rejects(collectInvestorFlow(['../etc'],options));await assert.rejects(collectInvestorFlow(['011420'],{...options,endDate:'2026-11-04'}));
});
test('long Retry-After stops without early retry',async()=>{
 let calls=0;const result=await collectInvestorFlow(['011420'],{...options,fetchImpl:async()=>{calls++;return response(429,{}, {'retry-after':'600'})},sleep:async()=>{throw Error('must not retry early')}});assert.equal(calls,1);assert.equal(result.failures[0].reason,'HTTP_429');
});
test('historical date range includes only covered trading days',async()=>{
 const calendar=await loadMarketCalendar();assert.deepEqual(tradingDates('2026-10-26','2026-11-02',calendar),['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-11-02']);assert.throws(()=>tradingDates('2026-10-31','2026-11-01',calendar));
});
test('collection logs retry, progress and denial without recording response data',async()=>{
 let calls=0;const lines=[];
 await collectInvestorFlow(['011420'],{...options,log:line=>lines.push(line),fetchImpl:async()=>++calls===1?response(429,{}, {'retry-after':'7'}):response(200),sleep:async()=>{}});
 assert.match(lines.join('\n'),/HTTP 429.*7초.*재시도/);assert.match(lines.join('\n'),/진행 1\/1/);assert.doesNotMatch(lines.join('\n'),/1,702|1,734/);
 const denied=[];await collectInvestorFlow(['011420'],{...options,log:line=>denied.push(line),fetchImpl:async()=>response(403),sleep:async()=>{}});assert.match(denied.join('\n'),/HTTP 403.*추가 요청 없음/);
});

test('stops after the probe symbol when the source has not published the end date yet',async()=>{
 const urls=[];const rows=(code,date)=>[{itemCode:code,bizdate:date,foreignerPureBuyQuant:'+1',organPureBuyQuant:'-1',individualPureBuyQuant:'0',foreignerHoldRatio:'1.00%'}];
 const fetchImpl=async(url)=>{urls.push(url);const code=url.split('/').at(-2);return response(200,rows(code,'20261030'))};
 const result=await collectInvestorFlow(['011420','005930','000660'],{...options,fetchImpl,sleep:async()=>{}});
 assert.equal(result.status,'not_published');assert.equal(urls.length,1);assert.match(urls[0],/005930\/trend$/);assert.equal(result.collected,0);
});
test('continues with every symbol once the probe symbol has the end date',async()=>{
 const urls=[];const fetchImpl=async(url)=>{urls.push(url);const code=url.split('/').at(-2);return response(200,[{itemCode:code,bizdate:'20261102',foreignerPureBuyQuant:'+1',organPureBuyQuant:'-1',individualPureBuyQuant:'0',foreignerHoldRatio:'1.00%'},{itemCode:code,bizdate:'20261030',foreignerPureBuyQuant:'+1',organPureBuyQuant:'-1',individualPureBuyQuant:'0',foreignerHoldRatio:'1.00%'}])};
 const result=await collectInvestorFlow(['011420','005930','000660'],{...options,fetchImpl,sleep:async()=>{}});
 assert.equal(urls.length,3);assert.match(urls[0],/005930\/trend$/);assert.equal(result.collected,3);assert.equal(result.status,'ready');
});
test('primary data is preferred and fallback fills only missing fields',async()=>{
 const primaryFetch=async symbol=>({symbol,rows:[{date:'2026-11-02',individual_net_shares:99,institution_net_shares:null,foreign_net_shares:-9}]});
 let calls=0;const result=await collectInvestorFlow(['011420'],{...options,usePrimary:true,primaryFetch,fetchImpl:async()=>{calls++;return response(200)},sleep:async()=>{}});
 assert.equal(calls,1); const row=result.stocks[0].rows.find(x=>x.date==='2026-11-02');
 assert.equal(row.individual_net_shares,99); assert.equal(row.foreign_net_shares,-9); assert.equal(row.institution_net_shares,-32);
 assert.equal(result.stocks[0].rows.some(x=>x.date==='2026-10-30'),true);
});
test('complete primary result needs no fallback and a failed primary uses fallback',async()=>{
 const primaryFetch=async symbol=>({symbol,rows:['2026-10-30','2026-11-02'].map(date=>({date,individual_net_shares:1,institution_net_shares:2,foreign_net_shares:3}))});
 let calls=0;let result=await collectInvestorFlow(['011420'],{...options,usePrimary:true,primaryFetch,fetchImpl:async()=>{calls++;return response(200)},sleep:async()=>{}});
 assert.equal(calls,0);assert.equal(result.status,'ready');
 result=await collectInvestorFlow(['011420'],{...options,usePrimary:true,primaryFetch:async()=>{throw Error('unavailable')},fetchImpl:async()=>{calls++;return response(200)},sleep:async()=>{}});
 assert.equal(calls,1);assert.equal(result.stocks[0].rows[0].individual_net_shares,1734);
});
test('primary source checks robots, symbol identity and parses signed share counts',async()=>{
 const urls=[], waits=[];
 const fetchImpl=async url=>{
   urls.push(url);
   if(url.endsWith('/robots.txt'))return response(404,{});
   if(url.includes('/summary/'))return response(200,{id:1014,code:'005930',market:'kospi'});
   return response(200,{data:[{dt:'2026-11-02',net_vol_individual:5,net_vol_institutional:-8,net_vol_foreigner:3}]});
 };
 const primary=createPrimaryInvestorSource({fetchImpl,now:()=>new Date('2026-11-03T00:00:00Z'),sleep:async ms=>waits.push(ms)});
 const result=await primary('005930','2026-11-02','2026-11-02','2026-11-03');
 assert.equal(result.rows[0].individual_net_shares,5);assert.equal(result.rows[0].institution_net_shares,-8);
 assert.equal(urls.length,3);assert.deepEqual(waits,[1000]);
});
