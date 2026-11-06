import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadMarketCalendar} from '../scripts/market-calendar.mjs';
import {managedStages,planManaged} from '../scripts/scheduler-managed.mjs';
import {runKeeper} from '../scripts/scheduler-keeper.mjs';
const kr=await loadMarketCalendar(),us=JSON.parse(await readFile(new URL('../data/us-market-calendar.json',import.meta.url)));
const ts=s=>Date.parse(s);
const byId=(day,id)=>managedStages(day,kr,us).find(s=>s.id===id);
test('afternoon investor flow is scheduled for 17:45 on trading days',()=>{
 const s=byId('2026-11-06','flow-afternoon'); assert.equal(new Date(s.at).toISOString(),'2026-11-06T08:45:00.000Z'); assert.equal(s.inputs.keeper_mode,'afternoon');
 assert.equal(byId('2026-11-07','flow-afternoon'),undefined);
});
test('US holiday and Saturday early close use the US trading date',()=>{
 assert.equal(byId('2026-11-27','nasdaq-close'),undefined);
 const close=byId('2026-11-28','nasdaq-close');
 assert.equal(new Date(close.at).toISOString(),'2026-11-27T18:05:00.000Z');
 assert.equal(close.inputs.market_date,'2026-11-27');
 assert.equal(byId('2026-11-28','context-morning'),undefined);
 assert.ok(byId('2026-11-28','flow-retry'));
});
test('US regular open and close track DST',()=>{
 assert.equal(new Date(byId('2026-07-06','nasdaq-open').at).toISOString(),'2026-07-06T13:35:00.000Z');
 assert.equal(new Date(byId('2026-11-06','nasdaq-open').at).toISOString(),'2026-11-06T14:35:00.000Z');
 assert.equal(new Date(byId('2026-11-06','nasdaq-close').at).toISOString(),'2026-11-05T21:05:00.000Z');
});
test('each phase deduplicates only its own keeper dispatch',()=>{
 const date='2026-11-06',now=new Date('2026-11-05T23:20:10Z');
 const runs={'market-context.yml':[{display_title:'keeper:context-morning',created_at:'2026-11-05T22:30:10Z',status:'completed',conclusion:'success'}]};
 assert.equal(planManaged(date,now,kr,us,runs).stage.id,'context-preopen');
 runs['market-context.yml'].push({display_title:'keeper:context-preopen',created_at:now.toISOString(),status:'completed',conclusion:'success'});
 assert.notEqual(planManaged(date,now,kr,us,runs).stage?.id,'context-preopen');
});
test('keeper dispatches managed tasks then relays on a KRX holiday',async()=>{
 let clock=ts('2026-11-27T17:59:50Z');const runs=new Map(),sent=[];
 const client={async listRuns(w){return runs.get(w)||[]},async dispatch(w,ref,inputs){sent.push([w,inputs,new Date(clock).toISOString()]);if(inputs){const a=runs.get(w)||[];a.push({display_title:`keeper:${inputs.keeper_slot}`,created_at:new Date(clock).toISOString(),status:'completed',conclusion:'success'});runs.set(w,a);}}};
 const result=await runKeeper({client,calendar:kr,usCalendar:us,stages:[],stayAlive:true,budgetMinutes:15,startedAt:new Date(clock),now:()=>new Date(clock),sleep:async ms=>{clock+=ms},log:()=>{}});
 assert.equal(result.result,'relay');
 const close=sent.find(([w,i])=>w==='nasdaq-sectors.yml'&&i?.phase==='close');
 assert.ok(close);assert.equal(close[1].market_date,'2026-11-27');
 assert.ok(sent.some(([w])=>w==='scheduler-keeper.yml'));
});
test('all automatic workflows are dispatch-only and accept their keeper identifiers',async()=>{
 const fs=await import('node:fs/promises');
 const root=new URL('../.github/workflows/',import.meta.url);
 for(const f of await fs.readdir(root)) {
  const body=await fs.readFile(new URL(f,root),'utf8');
  assert.doesNotMatch(body,/^\s*schedule:\s*$/m,`${f} must not use cron`);
 }
 for(const f of ['market-context.yml','nasdaq-sectors.yml','after-market.yml','personal-investor-flow.yml','update-market-calendar.yml','update-us-market-calendar.yml']) {
  const body=await fs.readFile(new URL(f,root),'utf8');
  assert.match(body,/keeper_slot:/,`${f} accepts keeper identifier`);
  assert.match(body,/run-name:.*inputs\.keeper_slot/,`${f} reports keeper identifier`);
 }
});
test('missed windows are not dispatched and failures retry within window',()=>{
 const date='2026-11-06', now=new Date('2026-11-05T23:20:10Z');
 const failed={'market-context.yml':[{display_title:'keeper:context-preopen',created_at:now.toISOString(),status:'completed',conclusion:'failure'}]};
 assert.equal(planManaged(date,now,kr,us,failed).stage.id,'context-preopen');
 failed['market-context.yml'].push({...failed['market-context.yml'][0]});
 assert.notEqual(planManaged(date,now,kr,us,failed).stage?.id,'context-preopen');
 const after=new Date('2026-11-05T23:51:00Z');
 assert.notEqual(planManaged(date,after,kr,us,{}).stage?.id,'context-preopen');
});
test('expired market calendars never stop the daily update jobs or keeper relay',async()=>{
 const day='2027-01-04',stages=managedStages(day,kr,us);
 assert.ok(stages.some(s=>s.id==='kr-calendar'));
 assert.ok(stages.some(s=>s.id==='us-calendar'));
 assert.equal(stages.some(s=>s.id.startsWith('nasdaq-')),false);
 let clock=ts('2027-01-03T17:59:50Z');const runs=new Map(),sent=[];
 const client={async listRuns(w){return runs.get(w)||[]},async dispatch(w,ref,inputs){sent.push([w,inputs]);if(inputs){runs.set(w,[{display_title:`keeper:${inputs.keeper_slot}`,created_at:new Date(clock).toISOString(),status:'completed',conclusion:'success'}]);}}};
 const result=await runKeeper({client,calendar:kr,usCalendar:us,stages:[],stayAlive:true,budgetMinutes:20,startedAt:new Date(clock),now:()=>new Date(clock),sleep:async ms=>{clock+=ms},log:()=>{}});
 assert.equal(result.result,'relay');assert.ok(sent.some(([w])=>w==='update-market-calendar.yml'));assert.ok(sent.some(([w])=>w==='update-us-market-calendar.yml'));
});
test('keeper reloads newly committed calendars without restarting',async()=>{
 let clock=ts('2027-01-03T22:29:50Z'); const sent=[],runs=new Map();
 const kr2=structuredClone(kr);kr2.coverage.end='2027-12-31';
 const us2=structuredClone(us);us2.coverage.end='2027-12-31';
 const client={async readCalendar(file){return file.startsWith('krx')?kr2:us2},async listRuns(w){return runs.get(w)||[]},async dispatch(w,ref,inputs){sent.push([w,inputs]);if(inputs)runs.set(w,[{display_title:`keeper:${inputs.keeper_slot}`,created_at:new Date(clock).toISOString(),status:'completed',conclusion:'success'}]);}};
 const result=await runKeeper({client,calendar:kr,usCalendar:us,stages:[],stayAlive:true,budgetMinutes:5,startedAt:new Date(clock),now:()=>new Date(clock),sleep:async ms=>{clock+=ms},log:()=>{}});
 assert.equal(result.result,'relay');assert.ok(sent.some(([w,i])=>w==='market-context.yml'&&i?.phase==='morning'));
});
test('temporary API failure is retried without breaking the keeper',async()=>{
 let clock=ts('2026-11-27T17:59:50Z'), calls=0;const sent=[],runs=new Map();
 const client={async listRuns(w){if(!calls++)throw new Error('list runs: HTTP 503');return runs.get(w)||[]},async dispatch(w,ref,inputs){sent.push([w,inputs]);if(inputs)runs.set(w,[{display_title:`keeper:${inputs.keeper_slot}`,created_at:new Date(clock).toISOString(),status:'completed',conclusion:'success'}]);}};
 const result=await runKeeper({client,calendar:kr,usCalendar:us,stages:[],stayAlive:true,budgetMinutes:15,startedAt:new Date(clock),now:()=>new Date(clock),sleep:async ms=>{clock+=ms},log:()=>{}});
 assert.equal(result.result,'relay');assert.ok(sent.some(([w,i])=>w==='nasdaq-sectors.yml'&&i?.phase==='close'));
});
