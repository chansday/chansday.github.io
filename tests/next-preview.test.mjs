import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rankedRecords, rankChanges } from '../providers/rank-change.js';
import { buildPreopenRanking, freezePreopenRanking } from '../scripts/freeze-preopen-ranking.mjs';
import { buildPreview } from '../scripts/preview-ranking.mjs';

const row=(symbol,pct)=>({symbol,name:symbol,expected_open:100,expected_close:100+pct});
test('rank changes compare whole saved universe and distinguish new from missing',()=>{
 const preview={target_date:'2026-11-04',universe_complete:true,universe:['000001','000002','000003'],rows:rankedRecords([row('000001',3),row('000002',2)])};
 const preopen={target_date:'2026-11-04',rows:rankedRecords([row('000002',9),row('000001',8),row('000004',7),row('000003',6)])};
 const changes=rankChanges(preview,preopen,'2026-11-04');
 assert.deepEqual(changes['000002'],{kind:'change',value:1});
 assert.deepEqual(changes['000001'],{kind:'change',value:-1});
 assert.equal(changes['000004'].kind,'new'); assert.equal(changes['000003'].kind,'unknown');
 preview.universe_complete=false; assert.equal(rankChanges(preview,preopen,'2026-11-04')['000004'].kind,'unknown');
 assert.deepEqual(rankChanges(preview,preopen,'2026-11-05'),{});
});
test('preopen freezes only the genuine forecast before 09:00',()=>{
 const snapshot={mode:'provider',asOfDate:'2026-11-04',meta:{run_date:'2026-11-04',run_stage:'forecast',lastAttemptAt:'2026-11-03T23:35:00Z',run_id:'123',source:{retrieved_at:'2026-11-03T23:35:10Z'}},pipeline:{forecast:{status:'ready'}},rows:[row('000001',1),row('000002',2)]};
 const result=buildPreopenRanking(snapshot,'2026-11-04');assert.equal(result.rows[0].symbol,'000002');
 snapshot.meta.lastAttemptAt='2026-11-04T00:00:00Z';assert.throws(()=>buildPreopenRanking(snapshot,'2026-11-04'));
 snapshot.meta.lastAttemptAt='2026-11-03T23:35:00Z';snapshot.meta.source.retrieved_at='2026-11-04T00:00:01Z';assert.throws(()=>buildPreopenRanking(snapshot,'2026-11-04'));
 snapshot.meta.source.retrieved_at='2026-11-03T23:35:10Z';snapshot.meta.retrospective_evaluation=true;assert.throws(()=>buildPreopenRanking(snapshot,'2026-11-04'));
});
test('preopen ranking uses 0835 first and supports a legacy 0820 forecast',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preopen-stage-')); const oldRoot=process.env.KOSPI_DATA_ROOT;
 try {
  process.env.KOSPI_DATA_ROOT=root;
  const dir=join(root,'data','runs','2026-11-04'); await mkdir(dir,{recursive:true});
  const snapshot={mode:'provider',asOfDate:'2026-11-04',meta:{run_date:'2026-11-04',run_stage:'forecast',lastAttemptAt:'2026-11-03T23:35:00Z',run_id:'123',source:{retrieved_at:'2026-11-03T23:35:10Z'}},pipeline:{forecast:{status:'ready'}},rows:[row('000001',1)]};
  await writeFile(join(dir,'0820.json'),JSON.stringify(snapshot));
  snapshot.rows=[row('000002',2)]; await writeFile(join(dir,'0835.json'),JSON.stringify(snapshot));
  const now=()=>new Date('2026-11-03T23:40:00Z'); const output=join(root,'data','preopen-ranking','2026-11-04.json');
  await freezePreopenRanking('2026-11-04',{now}); assert.equal(JSON.parse(await readFile(output,'utf8')).rows[0].symbol,'000002');
  await rm(output); await rm(join(dir,'0835.json'));
  await freezePreopenRanking('2026-11-04',{now}); assert.equal(JSON.parse(await readFile(output,'utf8')).rows[0].symbol,'000001');
 } finally { if(oldRoot===undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT=oldRoot; await rm(root,{recursive:true,force:true}); }
});
test('preview accepts validated evening and early morning history, with explicit recovery',async()=>{
 const make=(date,close)=>({date,rows:[{symbol:'000001',open:100,close,volume:100}]});
 const history={ok:true,partial:false,valid_symbols:['000001'],symbols:['000001'],sessions:[make('2026-11-03',102),make('2026-11-02',101),make('2026-10-30',100)],retrieved_at:'2026-11-03T10:00:00Z'};
 const options={now:()=>new Date('2026-11-03T10:05:00Z'),rawRecord:{collection:'evening',target_date:'2026-11-04',retrieved_at:'2026-11-03T10:00:00Z'},loadHistory:async()=>history,universe:{symbols:[{symbol:'000001',name:'가'}]}};
 const preview=await buildPreview('2026-11-04',options);assert.equal(preview.rows.length,1);assert.equal(preview.source_date,'2026-11-03');assert.equal(preview.rows[0].expected_open,102);
 const withFlow=await buildPreview('2026-11-04',{...options,loadFlow:async()=>({status:'applied',source_date:'2026-11-03',adjustments:{'000001':0.005}})});
 assert.equal(withFlow.investor_flow.status,'applied'); assert.ok(withFlow.rows[0].expected_close>preview.rows[0].expected_close);
 const missingFlow=await buildPreview('2026-11-04',{...options,loadFlow:async()=>{throw new Error('missing');}});
 assert.equal(missingFlow.investor_flow.status,'unavailable'); assert.deepEqual(missingFlow.rows,preview.rows);
 await assert.rejects(buildPreview('2026-11-04',{...options,now:()=>new Date('2026-11-04T00:00:00Z')}));
 await assert.rejects(buildPreview('2026-11-04',{...options,rawRecord:{...options.rawRecord,collection:'morning'}}));
 const morning = {...options, now:()=>new Date('2026-11-03T22:00:00Z'),rawRecord:{collection:'morning',target_date:'2026-11-04',retrieved_at:'2026-11-03T21:40:00Z'},loadHistory:async()=>({...history,retrieved_at:'2026-11-03T21:40:00Z'})};
 const morningPreview = await buildPreview('2026-11-04',morning);
 assert.equal(morningPreview.collection,'morning'); assert.equal(morningPreview.reconstructed,false);
 await assert.rejects(buildPreview('2026-11-04',{...morning,now:()=>new Date('2026-11-04T02:00:00Z')}));
 const repaired = await buildPreview('2026-11-04',{...morning,now:()=>new Date('2026-11-04T02:00:00Z'),recovery:true});
 assert.equal(repaired.reconstructed,true); assert.equal(repaired.generated_at,'2026-11-04T02:00:00.000Z');
 await assert.rejects(buildPreview('2026-11-04',{...morning,recovery:true,rawRecord:{...morning.rawRecord,retrieved_at:'2026-11-03T23:01:00Z'}}));
});
