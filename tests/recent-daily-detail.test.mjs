import test from 'node:test';
import assert from 'node:assert/strict';
import { recentDailyRows } from '../providers/selected-detail.js';
const history = { source:'naver-daily', target_date:'2026-11-02', sessions:[
  {date:'2026-10-28',rows:[{symbol:'A',open:100,close:90,volume:0}]},
  {date:'2026-10-30',rows:[{symbol:'A',open:100,close:110,volume:1234}]},
  {date:'2026-10-29',rows:[{symbol:'A',open:null,close:100,volume:null}]},
  {date:'2026-11-03',rows:[{symbol:'A',open:100,close:200,volume:1}]},
]};
test('recent daily sorts, limits, calculates and keeps missing values', () => {
 const rows=recentDailyRows(history,'A','2026-11-02');
 assert.deepEqual(rows.map(r=>r.date), ['2026-10-30','2026-10-29','2026-10-28']);
 assert.equal(rows[0].returnText,'+10.00%'); assert.equal(rows[0].volumeText,'1,234주');
 assert.equal(rows[1].returnText,'—'); assert.equal(rows[1].volumeText,'—'); assert.equal(rows[2].volumeText,'0주');
});
test('settled current day appears first, wrong date history never reused', () => {
 const rows=recentDailyRows(history,'A','2026-11-02',{actual_open:100,actual_close:95,actual_volume:10});
 assert.equal(rows[0].returnText,'-5.00%'); assert.equal(rows.length,3);
 assert.deepEqual(recentDailyRows(history,'A','2026-11-03'), []);
 assert.deepEqual(recentDailyRows(history,'B','2026-11-02'), []);
});
