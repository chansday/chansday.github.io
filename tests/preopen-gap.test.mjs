import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreopenGap} from '../providers/preopen-gap.js';
import {priorHistoryEstimate, isCloseBasis, isOpenBasis} from '../providers/forecast-basis.js';
import {mergeRows} from '../scripts/update-results.mjs';

const date = '2026-11-06';
const symbols = ['000001', '000002', '000003'];
const dates = Array.from({length:20}, (_, i) => new Date(Date.UTC(2026, 9, 31-i)).toISOString().slice(0,10));
const history = {sessions: dates.slice(0,3).map(d => ({date:d, rows:symbols.map(symbol => ({symbol, open:100, close:100, volume:1000}))})), return_history:Object.fromEntries(symbols.map(s => [s, dates.map(date => ({date, open:100, close:100, high:105, low:95, volume:1000}))]))};
const target = {level_intercept:0, level_slope:0.1, weights:[0,0.02], samples:500};
history.daytrade_model = {model:'daytrade_open_gap_rank_ridge_v1', columns:[11], targets:{close:target,high:target,low:target}, train_last_date:'2026-10-31'};
const rows = symbols.map(symbol => {const e=priorHistoryEstimate(history.sessions,symbol,{returnHistory:history.return_history[symbol]}); return {symbol,name:symbol,rank:1,expected_open:e.expected_open,expected_open_source:{kind:'preopen_history',recorded_at:'2026-11-05T23:00:00Z',history_dates:dates.slice(0,3)},expected_open_basis:e.open_basis,expected_close:e.expected_close,expected_close_basis:e.close_basis,expected_return:0,status:'valid'};});
const quotes = symbols.map((symbol,i)=>({symbol,openPrice:[110,100,90][i],marketStatus:'PREOPEN',quoteAt:new Date('2026-11-05T23:35:00Z')}));
test('fresh pre-open quote adjusts existing return using the trained gap effect', () => {
 const adjusted=applyPreopenGap(rows,quotes,history);
 assert.deepEqual(adjusted.map(r=>r.expected_open),[110,100,90]);
 for(const row of adjusted) {assert.ok(isOpenBasis(row.expected_open_basis,row,{asOfDate:date})); assert.ok(isCloseBasis(row.expected_close_basis,row,{asOfDate:date}));}
 assert.notEqual(adjusted[0].expected_return,rows[0].expected_return);
 const merged=mergeRows(rows,adjusted,'forecast');
 assert.deepEqual(merged.map(r=>r.expected_open).sort((a,b)=>a-b),[90,100,110]);
 const tampered=structuredClone(adjusted[0]); tampered.expected_close_basis.inputs.adjustment+=1; assert.equal(isCloseBasis(tampered.expected_close_basis,tampered,{asOfDate:date}),false);
});
test('missing quote or model keeps the prior forecast', () => {
 assert.deepEqual(applyPreopenGap(rows, [], history), rows);
 assert.deepEqual(applyPreopenGap(rows, quotes, {...history,daytrade_model:null}), rows);
});


