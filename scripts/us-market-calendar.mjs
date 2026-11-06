import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isValidDate } from './market-calendar.mjs';
export const CALENDAR = new URL('../data/us-market-calendar.json', import.meta.url);
export function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}` };
}
export function classify(calendar, date) {
  if (!isValidDate(date) || calendar.market !== 'NASDAQ' || calendar.timezone !== 'America/New_York' || !isValidDate(calendar.coverage?.start) || !isValidDate(calendar.coverage?.end) || !Array.isArray(calendar.holidays) || !Array.isArray(calendar.early_closes)) throw new Error('Invalid US calendar');
  if (calendar.coverage.start > calendar.coverage.end) throw new Error('Invalid US calendar coverage');
  const dates=new Set();
  for (const [key, rows] of [['holidays',calendar.holidays],['early_closes',calendar.early_closes]]) for (const row of rows) {
    if (!isValidDate(row?.date) || row.date < calendar.coverage.start || row.date > calendar.coverage.end || dates.has(row.date) || (key==='holidays' && (typeof row.name!=='string' || !row.name.trim())) || (key==='early_closes' && row.close!=='13:00')) throw new Error('Invalid or duplicate US calendar entry');
    dates.add(row.date);
  }
  if (date < calendar.coverage.start || date > calendar.coverage.end) throw new Error(`US calendar does not cover ${date}`);
  if ([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())) return { run:false, reason:'weekend' };
  if (calendar.holidays.some(x => x.date === date)) return { run:false, reason:'holiday' };
  return { run:true, close:calendar.early_closes.find(x => x.date === date)?.close || '16:00' };
}
// A completed US regular session whose close falls in (after, before].
// Fail closed outside checked-in calendar coverage, including weekends.
export function sessionsBetween(calendar, after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after) throw new Error('Invalid session interval');
  const from=easternParts(new Date(after)).date, to=easternParts(new Date(before)).date;
  const result=[];
  for (let d=from; d<=to;) {
    const day=classify(calendar,d);
    if (day.run) {
      // The regular close is 13:00 or 16:00 Eastern; select its UTC instant
      // through the time-zone database rather than a fixed DST calendar.
      const candidateHours=day.close==='13:00' ? [17,18] : [20,21];
      const matches=candidateHours.map(h=>Date.parse(`${d}T${h}:00:00Z`)).filter(ms=>{ const p=easternParts(new Date(ms)); return p.date===d && p.time===day.close; });
      if (matches.length!==1) throw new Error(`Cannot resolve US close for ${d}`);
      if (matches[0]>after && matches[0]<=before) result.push({ date:d, close:day.close, closed_at:new Date(matches[0]).toISOString() });
    }
    const next=new Date(`${d}T12:00:00Z`); next.setUTCDate(next.getUTCDate()+1); d=next.toISOString().slice(0,10);
  }
  return result;
}
export function scheduledPhase(calendar, now, schedule) {
  const date = easternParts(now).date, result = classify(calendar,date);
  if (!result.run) return { ...result, date };
  if (!schedule) return { run:true, date, phase:'manual' };
  const match = /^(\d+) (\d+) \* \* 1-5$/.exec(schedule);
  if (!match) throw new Error('Unexpected schedule');
  const nominal = new Date(`${date}T${match[2].padStart(2,'0')}:${match[1].padStart(2,'0')}:00Z`);
  const local = easternParts(nominal);
  const expectedClose = result.close === '13:00' ? '13:05' : '16:05';
  const phase = local.date === date && local.time === '09:35' ? 'open' : local.date === date && local.time === expectedClose ? 'close' : null;
  return { run:!!phase, date, phase, reason:phase ? 'trading_session' : 'wrong_season_or_close_time' };
}
export async function run() {
  const calendar = JSON.parse(await readFile(CALENDAR,'utf8'));
  const result = scheduledPhase(calendar,new Date(),process.env.SCHEDULE || '');
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `should_run=${result.run}\nmarket_date=${result.date}\nphase=${result.phase || ''}\n`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run().catch(e=>{console.error(e);process.exitCode=1});
