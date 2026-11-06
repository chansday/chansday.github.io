import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {holidayForDate} from '../providers/date-navigation.js';

const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
const pipelineCode=source.slice(source.indexOf('function renderPipeline('),source.indexOf('function evaluationStats('));
const riskCode=source.slice(source.indexOf('async function renderTodayRisk()'));
function setup(date,calendar={holidays:[]}) {
 const ids=['pipeline-day-note','risk-day-note','risk-score','risk-grade','risk-index','risk-market','risk-local','risk-stocks','risk-flow','risk-market-bar','risk-local-bar','risk-stocks-bar','risk-flow-bar','risk-summary','risk-time'];
 const nodes=Object.fromEntries(ids.map(id=>[id,{textContent:'',dataset:{level:'high'},style:{width:'80%'}}]));
 const badges=Array.from({length:5},()=>({textContent:'정상',title:'old'}));
 const steps=['analysis','forecast','openSettlement','closeSettlement','nextPreview'].map((name,i)=>({dataset:{step:name},querySelector:()=>badges[i]}));
 let requests=0;
 const context={holidayForDate,marketCalendar:calendar,todayKst:()=>date,document:{getElementById:id=>nodes[id],querySelectorAll:()=>steps},setText:(node,text)=>{if(node)node.textContent=text;},requestedRoute:()=>({date:null}),latestPreview:null,previewState:null,normalizeStatus:x=>x,statusClass:()=>'',stateLabels:{ready:'정상',pending:'대기'},riskRenderToken:0,fetch:async()=>{requests++;return {ok:false};}};
 vm.createContext(context);
 return {context,nodes,badges,steps,getRequests:()=>requests};
}
test('weekends and exchange holidays display closed and never request a risk score',async()=>{
 for(const [date,calendar] of [['2026-11-07',{holidays:[]}],['2026-11-09',{holidays:[{date:'2026-11-09',name:'임시휴장'}]}]]) {
  const x=setup(date,calendar); vm.runInContext(pipelineCode+'; renderPipeline({status:"ready",pipeline:{forecast:{status:"ready"}}});',x.context);
  await vm.runInContext(riskCode+'; renderTodayRisk();',x.context);
  assert.ok(x.badges.every(b=>b.textContent==='휴장')); assert.match(x.nodes['pipeline-day-note'].textContent,/휴장일/);
  assert.equal(x.nodes['risk-grade'].textContent,'휴장'); assert.equal(x.nodes['risk-score'].textContent,'—');
  assert.equal(x.nodes['risk-index'].dataset.level,undefined); assert.equal(x.nodes['risk-market-bar'].style.width,'0%'); assert.equal(x.getRequests(),0);
 }
});
test('a trading day retains normal pipeline and risk loading behavior',async()=>{
 const x=setup('2026-11-09'); vm.runInContext(pipelineCode+'; renderPipeline({status:"ready",pipeline:{forecast:{status:"ready"}}});',x.context);
 await vm.runInContext(riskCode+'; renderTodayRisk();',x.context);
 assert.equal(x.badges[1].textContent,'정상'); assert.equal(x.nodes['risk-grade'].textContent,'자료 부족'); assert.equal(x.getRequests(),1);
});
