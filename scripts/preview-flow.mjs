import { readFile } from 'node:fs/promises';
import { repoPath } from '../providers/repo-paths.js';

const clip = (n, limit) => Math.max(-limit, Math.min(limit, n));
const mean = xs => xs.reduce((a,b)=>a+b,0)/xs.length;
const signal = (flow, bar) => Number.isSafeInteger(flow?.foreign_net_shares) && Number.isSafeInteger(flow?.institution_net_shares) && Number.isFinite(bar?.volume) && bar.volume > 0
  ? clip((flow.foreign_net_shares + flow.institution_net_shares) / bar.volume, 1) : null;

// Fit on past sessions only; a chronological holdout must improve the squared
// error of the market-neutral return before the adjustment is enabled.
export async function buildFlowAdjustment(history, sourceDate, targetDate, { read = path => readFile(repoPath(path), 'utf8') } = {}) {
  const unavailable = reason => ({ status:'unavailable', reason, source_date:sourceDate, adjustments:{} });
  if (!(sourceDate < targetDate) || !history?.return_history) return unavailable('missing_history');
  const dates = [...new Set(Object.values(history.return_history).flatMap(bars => Array.isArray(bars) ? bars.map(b => b.date) : []))].filter(d => d <= sourceDate).sort();
  if (dates.at(-1) !== sourceDate || dates.length < 8) return unavailable('insufficient_history');
  const flows = new Map();
  for (const date of dates) {
    try {
      const data = JSON.parse(await read(`data/investor-flow/${date}.json`));
      if (data.date === date && data.stocks && typeof data.stocks === 'object' && !Array.isArray(data.stocks)) flows.set(date,data.stocks);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const today = flows.get(sourceDate);
  if (!today) return unavailable('source_day_missing');
  const symbols = history.valid_symbols || [];
  const targetRows = [];
  for (const symbol of symbols) {
    const bar = history.return_history[symbol]?.find(b => b.date === sourceDate);
    const x = signal(today[symbol],bar);
    if (x !== null) targetRows.push({symbol,x});
  }
  if (targetRows.length < 30 || targetRows.length / symbols.length < 0.7) return unavailable('source_day_incomplete');
  const days=[];
  for (let i=0;i<dates.length-1;i++) {
    const day=dates[i], next=dates[i+1], flow=flows.get(day);
    if (!flow) continue;
    const values=[];
    for (const symbol of symbols) {
      const bars=history.return_history[symbol] || [], current=bars.find(b=>b.date===day), following=bars.find(b=>b.date===next);
      const x=signal(flow[symbol],current);
      if (x !== null && following?.open > 0 && following?.close > 0) values.push({x,y:clip(following.close/following.open-1,0.2)});
    }
    if (values.length<30) continue;
    const mx=mean(values.map(v=>v.x)), my=mean(values.map(v=>v.y));
    days.push({date:day,next,values:values.map(v=>({x:v.x-mx,y:v.y-my}))});
  }
  if (days.length<6) return unavailable('insufficient_training');
  const fit = dataset => { let xy=0,xx=0; for(const d of dataset) for(const v of d.values){xy+=v.x*v.y;xx+=v.x*v.x;} return xx>0 ? clip(xy/xx,0.02)*0.5 : 0; };
  const split=Math.max(4,Math.floor(days.length*0.75)), train=days.slice(0,split), test=days.slice(split), testCoef=fit(train);
  let base=0, adjusted=0;
  for(const day of test) for(const v of day.values){base+=v.y*v.y; adjusted+=(v.y-testCoef*v.x)**2;}
  if (!test.length || !(adjusted < base)) return unavailable('holdout_no_improvement');
  const coefficient=fit(days), center=mean(targetRows.map(v=>v.x));
  const adjustments=Object.fromEntries(targetRows.map(({symbol,x})=>[symbol,clip(coefficient*(x-center),0.005)]));
  return {status:'applied',source_date:sourceDate,training_first_date:days[0].date,training_last_outcome:days.at(-1).next,training_days:days.length,holdout_days:test.length,holdout_mse_ratio:adjusted/base,coefficient,coverage:targetRows.length,total:symbols.length,adjustments};
}
