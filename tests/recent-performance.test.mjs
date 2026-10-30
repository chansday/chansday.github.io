import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePerformance, isNegativePerformance } from '../providers/recent-performance.js';
const make = () => ({ asOfDate:'2026-10-29', meta:{run_date:'2026-10-29',run_stage:'close-settlement'}, pipeline:{closeSettlement:{status:'ready'}}, rows:Array.from({length:20},(_,i)=>({symbol:String(i).padStart(2,'0'),expected_open:100,expected_close:120-i,actual_open:100,actual_close:100+i})) });
test('top 10 and 20 use ranking and equal-weight actual open-to-close returns',()=>{ const x=summarizePerformance(make(),'2026-10-29'); assert.ok(Math.abs(x.top10-4.5)<1e-9); assert.ok(Math.abs(x.top20-9.5)<1e-9); });
test('missing top outcome does not replace with lower-ranked stock',()=>{let x=make(); x.rows[0].actual_close=null; assert.equal(summarizePerformance(x,'2026-10-29').top10,null); assert.equal(summarizePerformance(x,'2026-10-29').top20,null);});
test('only matching completed close settlement is eligible',()=>{let x=make(); x.pipeline.closeSettlement.status='pending'; assert.equal(summarizePerformance(x,'2026-10-29'),null); x=make(); assert.equal(summarizePerformance(x,'2026-10-30'),null); x.meta.test_only=true; assert.equal(summarizePerformance(x,'2026-10-29'),null);});

test('retrospective overlay uses the same ranks as the displayed table', async () => {
  const { readFile } = await import('node:fs/promises');
  const { summarizeDisplayedPerformance } = await import('../providers/recent-performance.js');
  const date = '2026-10-27';
  const snapshot = JSON.parse(await readFile(new URL(`../data/runs/${date}/1530.json`, import.meta.url)));
  const record = JSON.parse(await readFile(new URL(`../data/runs/${date}/retrospective-${snapshot.meta.run_id}.json`, import.meta.url)));
  const result = summarizeDisplayedPerformance(snapshot, date, record);
  assert.ok(Math.abs(result.top10 - 2.0711) < 0.001);
  assert.ok(Math.abs(result.top20 - 0.8850) < 0.001);
});

test('negative highlight requires a finite top 10 return below zero', () => {
  assert.equal(isNegativePerformance(-0.001), true);
  for (const value of [0, 0.01, null, undefined, NaN, -Infinity]) assert.equal(isNegativePerformance(value), false);
});
