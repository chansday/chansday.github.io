import { kstDate, classifyMarketDate } from './market-calendar.mjs';
import { classify, easternParts } from './us-market-calendar.mjs';
const MIN=60000;
const iso=(date,time)=>Date.parse(`${date}T${time}:00+09:00`);
function usInstant(date,time) {
 for (let h=0;h<24;h++) { const at=Date.parse(`${date}T${String(h).padStart(2,'0')}:${time.slice(3)}:00Z`); const p=easternParts(new Date(at)); if(p.date===date && p.time===time) return at; }
 throw new Error(`Cannot resolve US time ${date} ${time}`);
}
export function managedStages(date, krx, us) {
 const market=classifyMarketDate(date,krx);
 const stages=[];
 const add=(id,workflow,at,until,inputs={})=>stages.push({id,workflow,at,until,inputs:{...inputs,keeper_slot:id}});
 add('kr-calendar','update-market-calendar.yml',iso(date,'03:00'),iso(date,'05:30'),{dry_run:'false'});
 add('us-calendar','update-us-market-calendar.yml',iso(date,'03:15'),iso(date,'05:30'),{dry_run:'false'});
 const weekday=new Date(`${date}T12:00:00Z`).getUTCDay();
 if(weekday!==0 && market.status!=='error') add('flow-retry','personal-investor-flow.yml',iso(date,'07:30'),iso(date,'07:45'),{keeper_mode:'retry'});
 if(market.status==='run') {
  for(const [phase,at,end] of [['morning','07:30','08:00'],['preopen','08:20','08:50'],['after_close','16:40','18:00']]) add('context-'+phase,'market-context.yml',iso(date,at),iso(date,end),{phase});
  add('after-market','after-market.yml',iso(date,'20:05'),iso(date,'23:30'));
  add('flow-evening','personal-investor-flow.yml',iso(date,'20:47'),iso(date,'23:30'),{keeper_mode:'evening'});
 }
 const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-1);
 for(const day of [d.toISOString().slice(0,10),date]) {
   let info; try { info=classify(us,day); } catch { continue; } if(!info.run)continue;
   for(const [phase,time] of [['open','09:35'],['close',info.close==='13:00'?'13:05':'16:05']]) {
    const at=usInstant(day,time); if(kstDate(new Date(at))===date) add(`nasdaq-${phase}`,'nasdaq-sectors.yml',at,at+10*MIN,{phase,market_date:day});
   }
 }
 return stages.sort((a,b)=>a.at-b.at);
}
export function planManaged(date,now,krx,us,runs={}) {
 const stages=managedStages(date,krx,us);
 for(const s of stages) {
  const own=(runs[s.workflow]||[]).filter(r=>r.display_title===`keeper:${s.id}` && Date.parse(r.created_at)>=s.at-60000);
  if(own.some(r=>r.status!=='completed'||r.conclusion==='success')) continue;
  if(now.getTime()>=s.at+3000 && now.getTime()<=s.until && own.length<2) return {type:'dispatch',stage:s};
 }
 const upcoming=stages.filter(s=>s.at+3000>now.getTime()).map(s=>s.at+3000);
 return {type:'wait',until:upcoming.length?Math.min(...upcoming):null};
}
