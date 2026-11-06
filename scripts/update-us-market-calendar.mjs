import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CALENDAR, easternParts } from './us-market-calendar.mjs';
export const SOURCE = 'https://www.nasdaq.com/holidayandtradinghours';
export function parseSchedule(html) {
  const table = html.match(/<table\b[^>]*id=["']e1["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) { console.log('NASDAQ_TABLE_DIAGNOSTIC', JSON.stringify([...html.matchAll(/<table\b[^>]*>/gi)].map(x=>x[0]).slice(0,10))); console.log('NASDAQ_HOLIDAY_DIAGNOSTIC', JSON.stringify(html.slice(Math.max(0,html.indexOf('New Years Day')-300),html.indexOf('New Years Day')+600))); throw new Error('NASDAQ holiday table e1 not found'); }
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>x[1].replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim()));
  const header=rows.shift(); const year=Number(header?.[1]);
  if (header?.length !== 3 || !/^20\d\d$/.test(header[1]) || !/holiday/i.test(header[0]) || !/status/i.test(header[2])) throw new Error('Unexpected NASDAQ table header');
  const holidays=[], early_closes=[], seen=new Set();
  for (const row of rows) {
    if (row.length !== 3) throw new Error('Unexpected NASDAQ holiday row');
    const m = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})$/i.exec(row[1]);
    if (!m) throw new Error(`Unexpected date: ${row[1]}`);
    const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(m[1].toLowerCase())+1;
    const date=`${year}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    const d=new Date(date+'T12:00:00Z'); if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10)!==date || seen.has(date)) throw new Error('Invalid or duplicate date'); seen.add(date);
    if (/^closed$/i.test(row[2])) holidays.push({date,name:row[0]});
    else if (/^1:00\s*p\.?m\.?\s*(?:ET)?$/i.test(row[2])) early_closes.push({date,close:'13:00'});
    else throw new Error(`Unexpected market status: ${row[2]}`);
  }
  if (holidays.length < 9 || holidays.length > 20 || early_closes.length > 5) throw new Error('Incomplete or unexpected NASDAQ calendar');
  return {year,holidays:holidays.sort((a,b)=>a.date.localeCompare(b.date)),early_closes:early_closes.sort((a,b)=>a.date.localeCompare(b.date))};
}
export function mergeCalendar(old, data) {
  const y=String(data.year), oldEnd=Number(old.coverage.end.slice(0,4));
  if (data.year < Number(old.coverage.start.slice(0,4)) || data.year > oldEnd+1) throw new Error('Noncontiguous calendar year');
  for (const key of ['holidays','early_closes']) {
    const newDates=new Set(data[key].map(x=>x.date));
    if (old[key].some(x=>x.date.startsWith(y) && !newDates.has(x.date))) throw new Error(`Previously recorded ${key} missing; manual review required`);
  }
  const result={...old,coverage:{...old.coverage,end: data.year>oldEnd ? `${y}-12-31` : old.coverage.end}};
  for (const key of ['holidays','early_closes']) result[key]=[...old[key].filter(x=>!x.date.startsWith(y)),...data[key]].sort((a,b)=>a.date.localeCompare(b.date));
  return result;
}
export async function update({fetchImpl=fetch, path=CALENDAR, dryRun=false}={}) {
  const initial=await readFile(path,'utf8'), old=JSON.parse(initial);
  const response=await fetchImpl(SOURCE,{headers:{'User-Agent':'kospi-signal-us-calendar/1.0',Accept:'text/html'},redirect:'error',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`NASDAQ calendar HTTP ${response.status}`);
  const buffer=Buffer.from(await response.arrayBuffer()); const pdf=spawnSync('pdftotext',['-layout','-','-'],{input:buffer,encoding:'utf8'}); console.log('PDF_TEXT_DIAGNOSTIC', JSON.stringify(pdf.stdout)); if (pdf.status !== 0) throw new Error('PDF extraction failed: '+pdf.stderr); const data=parseSchedule(pdf.stdout), next=mergeCalendar(old,data), today=easternParts(new Date()).date;
  if (next.coverage.end < today) throw new Error('NASDAQ source does not cover current year');
  if (JSON.stringify(next)===JSON.stringify(old)) return {changed:false,year:data.year};
  if (dryRun) return {changed:false,wouldChange:true,year:data.year};
  if (await readFile(path,'utf8')!==initial) throw new Error('Calendar changed during update');
  const target=path instanceof URL ? (await import('node:url')).fileURLToPath(path) : path, temp=`${target}.${randomUUID()}.tmp`;
  try { await writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'}); await rename(temp,target); } finally { await rm(temp,{force:true}); }
  return {changed:true,year:data.year};
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) update({dryRun:process.env.US_CALENDAR_DRY_RUN==='true'}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});
