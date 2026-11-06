import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classify, scheduledPhase, sessionsBetween } from '../scripts/us-market-calendar.mjs';
import { parseSchedule, mergeCalendar, update } from '../scripts/update-us-market-calendar.mjs';
const cal=JSON.parse(await readFile(new URL('../data/us-market-calendar.json',import.meta.url)));
const at=(date,cron)=>scheduledPhase(cal,new Date(date),cron);
test('US holiday and Korea Saturday follow New York market date',()=>{
  assert.equal(classify(cal,'2026-11-26').reason,'holiday');
  assert.deepEqual(at('2026-11-06T21:05:00Z','5 21 * * 1-5'),{run:true,date:'2026-11-06',phase:'close',reason:'trading_session'});
});
test('season and early closes run only at correct eastern time',()=>{
  assert.equal(at('2026-07-06T13:35:00Z','35 13 * * 1-5').phase,'open');
  assert.equal(at('2026-07-06T14:35:00Z','35 14 * * 1-5').run,false);
  assert.equal(at('2026-11-06T14:35:00Z','35 14 * * 1-5').phase,'open');
  assert.equal(at('2026-11-27T18:05:00Z','5 18 * * 1-5').phase,'close');
  assert.equal(at('2026-11-27T21:05:00Z','5 21 * * 1-5').run,false);
  assert.equal(at('2026-11-26T14:35:00Z','35 14 * * 1-5').reason,'holiday');
});
test('calendar rejects missing coverage',()=>assert.throws(()=>classify(cal,'2028-01-03'),/does not cover/));
const rows=[['New Years Day','Thursday, January 1','Closed'],['MLK','Monday, January 19','Closed'],['Presidents','Monday, February 16','Closed'],['Good Friday','Friday, April 3','Closed'],['Memorial','Monday, May 25','Closed'],['Juneteenth','Friday, June 19','Closed'],['Independence','Friday, July 3','Closed'],['Labor','Monday, September 7','Closed'],['Thanksgiving','Thursday, November 26','Closed'],['Early Close','Friday, November 27','1:00 p.m. ET'],['Early Close','Thursday, December 24','1:00 p.m. ET'],['Christmas','Friday, December 25','Closed']];
const html='Holiday Schedule\nHoliday       2026       Status\n'+rows.map(r=>r.join('    ')).join('\n')+'\nTrading Hours';
test('parses official table and refuses incomplete or missing existing dates',()=>{
 const data=parseSchedule(html); assert.equal(data.holidays.length,10); assert.equal(data.early_closes.length,2);
 assert.throws(()=>parseSchedule(html.replace('Closed','Unexpected')),/status/);
 assert.throws(()=>mergeCalendar(cal,{...data,holidays:data.holidays.slice(1)}),/manual review/);
});
test('network failure is surfaced without changing calendar',async()=>{
 await assert.rejects(update({fetchImpl:async()=>new Response('',{status:503})}),/503/);
});

test('closed US session is not reused after the previous KRX close',()=>{
 const start=Date.parse('2026-11-26T15:30:00+09:00'), end=Date.parse('2026-11-27T08:20:00+09:00');
 assert.deepEqual(sessionsBetween(cal,start,end),[]);
});
test('Friday close is new on Monday and uses early close',()=>{
 const sessions=sessionsBetween(cal,Date.parse('2026-11-27T15:30:00+09:00'),Date.parse('2026-11-30T08:20:00+09:00'));
 assert.equal(sessions.length,1); assert.equal(sessions[0].date,'2026-11-27'); assert.equal(sessions[0].closed_at,'2026-11-27T18:00:00.000Z');
});
test('counts multiple US closes across a Korean holiday',()=>{
 const sessions=sessionsBetween(cal,Date.parse('2026-11-23T15:30:00+09:00'),Date.parse('2026-11-26T08:20:00+09:00'));
 assert.deepEqual(sessions.map(s=>s.date),['2026-11-23','2026-11-24','2026-11-25']);
});
test('EDT close and uncovered date fail closed',()=>{
 const sessions=sessionsBetween(cal,Date.parse('2026-07-06T15:30:00+09:00'),Date.parse('2026-07-07T08:20:00+09:00'));
 assert.equal(sessions[0].closed_at,'2026-07-06T20:00:00.000Z');
 assert.throws(()=>sessionsBetween(cal,Date.parse('2026-12-31T15:30:00+09:00'),Date.parse('2027-01-04T08:20:00+09:00')),/does not cover/);
});
