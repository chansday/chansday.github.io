import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {parseInvestorFlow} from '../providers/investor-flow.js';
import {encryptInvestorData,decryptInvestorData} from '../providers/private-envelope.js';
import {collectInvestorFlow,tradingDates} from '../scripts/collect-investor-flow.mjs';
import {loadMarketCalendar} from '../scripts/market-calendar.mjs';
const payload=[{itemCode:'011420',bizdate:'20261102',foreignerPureBuyQuant:'-1,702',organPureBuyQuant:'-32',individualPureBuyQuant:'+1,734',foreignerHoldRatio:'5.31%'},{itemCode:'011420',bizdate:'20261030',foreignerPureBuyQuant:'0',organPureBuyQuant:'-',individualPureBuyQuant:'-',foreignerHoldRatio:'-'}];
const response=(status,body=payload,headers={'content-type':'application/json'})=>({status,ok:status>=200&&status<300,headers:new Headers(headers),text:async()=>JSON.stringify(body)});
const options={startDate:'2026-10-30',endDate:'2026-11-02',expectedDates:['2026-10-30','2026-11-02'],now:()=>new Date('2026-11-03T11:15:00Z')};
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
test('access denial stops without rotating or requesting other symbols',async()=>{
 let calls=0;const result=await collectInvestorFlow(['011420','005930'],{...options,fetchImpl:async()=>{calls++;return response(403)},sleep:async()=>{}});assert.equal(calls,1);assert.equal(result.status,'partial');assert.equal(result.collected,0);assert.equal(result.failures[0].reason,'HTTP_403');
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
