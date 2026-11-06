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
  if (date < calendar.coverage.start || date > calendar.coverage.end) throw new Error(`US calendar does not cover ${date}`);
  if ([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())) return { run:false, reason:'weekend' };
  if (calendar.holidays.some(x => x.date === date)) return { run:false, reason:'holiday' };
  return { run:true, close:calendar.early_closes.find(x => x.date === date)?.close || '16:00' };
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
