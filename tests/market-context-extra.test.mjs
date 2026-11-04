import test from 'node:test';
import assert from 'node:assert/strict';
import { marketBreadth, parseBlsCalendar } from '../providers/market-context-extra.js';

test('market breadth uses prior-date closes and 20-session history', () => {
  const dates=Array.from({length:20},(_,i)=>`2026-10-${String(20-i).padStart(2,'0')}`);
  const rows=(price)=>dates.map((d,i)=>[d, i===0 ? price : 10, 0,0,0,1]);
  const h={target_date:'2026-10-21',retrieved_at:'2026-10-21T00:00:00Z',return_history:{A:rows(12),B:rows(8),C:rows(10)}};
  const b=marketBreadth(h,'2026-10-21','2026-10-21T01:00:00Z');
  assert.deepEqual([b.up,b.down,b.unchanged,b.sma20_above,b.sma20_below,b.sma20_equal],[1,1,1,1,1,1]);
  assert.equal(b.as_of,'2026-10-20');
  assert.throws(()=>marketBreadth(h,'2026-10-21','2026-10-20T23:00:00Z'));
});

test('calendar retains source timestamps and excludes unrelated releases',()=>{
  const ics='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART;TZID=US-Eastern:20261106T083000\nSUMMARY:Employment Situation\nEND:VEVENT\nBEGIN:VEVENT\nUID:2\nDTSTART;TZID=US-Eastern:20261110T083000\nSUMMARY:Consumer Price Index\nEND:VEVENT\nBEGIN:VEVENT\nUID:3\nDTSTART:20261101T083000\nSUMMARY:Other\nEND:VEVENT\nEND:VCALENDAR';
  const data=parseBlsCalendar(ics);
  assert.equal(data.events.length,2);
  assert.equal(data.events[0].start,'20261106T083000');
  assert.equal(data.events[0].start_parameters,';TZID=US-Eastern');
  assert.throws(()=>parseBlsCalendar('bad'));
});
