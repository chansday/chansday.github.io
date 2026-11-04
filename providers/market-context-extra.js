import { readFile } from 'node:fs/promises';

// Only the saved, already-collected morning history may be used. A dated bar
// is never treated as proof that it was available before its collection time.
export function marketBreadth(history, targetDate, startedAt) {
  if (history?.target_date !== targetDate || !history.retrieved_at || Date.parse(history.retrieved_at) > Date.parse(startedAt) || !Number.isFinite(Date.parse(history.retrieved_at))) throw new Error('History unavailable at collection time');
  const series = Object.values(history.return_history || {}).filter(Array.isArray);
  const dates = series.flatMap(rows => rows.map(row => row?.[0])).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < targetDate).sort();
  const asOf = dates.at(-1);
  if (!asOf) throw new Error('No prior trading-day bars');
  let up=0, down=0, unchanged=0, above=0, below=0, equal=0, smaCount=0, eligible=0;
  for (const rows of series) {
    const sorted = rows.filter(r => Array.isArray(r) && typeof r[0] === 'string' && r[0] <= asOf).sort((a,b) => b[0].localeCompare(a[0]));
    if (sorted[0]?.[0] !== asOf || !Number.isFinite(sorted[0][1]) || sorted[0][1] <= 0 || !Number.isFinite(sorted[1]?.[1]) || sorted[1][1] <= 0) continue;
    const close=sorted[0][1], prior=sorted[1][1]; eligible++;
    if(close>prior)up++; else if(close<prior)down++; else unchanged++;
    const sample=sorted.slice(0,20);
    if(sample.length===20 && sample.every(r=>Number.isFinite(r[1]) && r[1]>0) && new Set(sample.map(r=>r[0])).size===20) {
      const avg=sample.reduce((s,r)=>s+r[1],0)/20; smaCount++;
      if(close>avg)above++; else if(close<avg)below++; else equal++;
    }
  }
  if(!eligible) throw new Error('No eligible breadth observations');
  return { as_of: asOf, source_target_date: targetDate, source_retrieved_at: history.retrieved_at, universe_count: series.length, eligible, up, down, unchanged, up_pct: 100*up/eligible, down_pct: 100*down/eligible, sma20_eligible: smaCount, sma20_above: above, sma20_below: below, sma20_equal: equal, sma20_above_pct: smaCount ? 100*above/smaCount : null, caveats: ['universe_and_security_type_unconfirmed','daily_adjustment_and_venue_unconfirmed','not_full_market_coverage'] };
}

export async function readMarketBreadth(date, startedAt) {
  const path = `data/daily-history/${date}.json`;
  try { const history=JSON.parse(await readFile(path,'utf8')); return {status:'ok',path,data:marketBreadth(history,date,startedAt)}; }
  catch(error) { return {status:'error',path,error:String(error.message || error)}; }
}

export function parseBlsCalendar(text) {
  if (!text.includes('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) throw new Error('Invalid iCalendar');
  const unfolded=text.replace(/\r?\n[ \t]/g,'');
  const events=[];
  for(const component of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const block=component.split('END:VEVENT')[0];
    const uid=block.match(/^UID:(.+)$/m)?.[1]?.trim();
    const summary=block.match(/^SUMMARY:(.+)$/m)?.[1]?.trim();
    const start=block.match(/^DTSTART([^:]*):(.+)$/m);
    if(uid && summary && start && /consumer price index|employment situation/i.test(summary)) events.push({uid,summary,start:start[2].trim(),start_parameters:start[1],time_zone:'US-Eastern (as supplied by BLS)'});
  }
  if(!events.length)throw new Error('No CPI or employment events found');
  return {events, note:'Schedule may change; times and zone are source values, not converted; retain collection timestamp.'};
}
