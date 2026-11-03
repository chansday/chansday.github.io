import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveInvestorDays} from '../scripts/collect-investor-flow.mjs';
import {loadInvestorDays,formatInvestorShares} from '../providers/investor-view.js';
test('daily collection preserves older valid values and browser reads by exact date and symbol',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'investor-days-'));
 try {
  const collection=row=>({stocks:[{symbol:'011420',rows:[{date:'2026-10-26',...row}]}]});
  await saveInvestorDays(collection({foreign_net_shares:100,individual_net_shares:-10,institution_net_shares:0}),dir);
  await saveInvestorDays(collection({foreign_net_shares:null,individual_net_shares:-20,institution_net_shares:null}),dir);
  const data=JSON.parse(await readFile(join(dir,'2026-10-26.json'),'utf8'));
  const index=await loadInvestorDays(['2026-10-26'],async()=>({ok:true,json:async()=>data}));
  assert.deepEqual(index.get('011420:2026-10-26'),{foreign_net_shares:100,individual_net_shares:-20,institution_net_shares:0});
  assert.equal(index.get('011420:2026-10-27'),undefined);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('missing investor values use a hyphen and signed share counts are formatted',()=>{
 assert.equal(formatInvestorShares(1200),'+1,200'); assert.equal(formatInvestorShares(-30),'-30');assert.equal(formatInvestorShares(null),'-');assert.equal(formatInvestorShares(0),'0');
});
