import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowAdjustment } from '../scripts/preview-flow.mjs';

function fixture(reverse = false) {
  const dates=Array.from({length:10},(_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`);
  const symbols=Array.from({length:40},(_,i)=>String(i+1).padStart(6,'0'));
  const files={}, histories={};
  for(const day of dates) files[day]={date:day,stocks:{}};
  for(const [i,symbol] of symbols.entries()) {
    const x=i<20?-1:1;
    for(const day of dates) files[day].stocks[symbol]={foreign_net_shares:x*100,institution_net_shares:0};
    histories[symbol]=dates.map((date,j)=>({date,open:100,close:j===0?100:100+(reverse&&j>=8?-1:1)*x,volume:1000}));
  }
  const read=async path=>{const date=path.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];if(!files[date])throw Object.assign(new Error('missing'),{code:'ENOENT'});return JSON.stringify(files[date]);};
  return {history:{return_history:histories,valid_symbols:symbols},read,files};
}
test('flow calibration uses past outcomes and only the requested source day',async()=>{
 const {history,read}=fixture(); const r=await buildFlowAdjustment(history,'2026-10-10','2026-10-11',{read});
 assert.equal(r.status,'applied'); assert.ok(r.adjustments['000040']>0); assert.ok(r.adjustments['000001']<0);
 assert.ok(r.training_last_outcome<='2026-10-10'); assert.ok(r.holdout_mse_ratio<1);
});
test('flow adjustment remains off when source day is missing, sparse, or holdout worsens',async()=>{
 const a=fixture(); delete a.files['2026-10-10']; assert.equal((await buildFlowAdjustment(a.history,'2026-10-10','2026-10-11',{read:a.read})).reason,'source_day_missing');
 const b=fixture(); b.files['2026-10-10'].stocks={}; assert.equal((await buildFlowAdjustment(b.history,'2026-10-10','2026-10-11',{read:b.read})).reason,'source_day_incomplete');
 const c=fixture(true); assert.equal((await buildFlowAdjustment(c.history,'2026-10-10','2026-10-11',{read:c.read})).reason,'holdout_no_improvement');
});
