import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, selectData, selectHistorical, SECTORS, SUB_SECTORS, ALL_SECTORS } from '../scripts/collect-nasdaq-sectors.mjs';

test('parses a sector quote payload', () => {
  const payload = { data: { symbol: 'IXHC', companyName: 'NASDAQ Health Care Index', marketStatus: 'Closed',
    primaryData: { lastSalePrice: '1,358.39', netChange: '-64.51', percentageChange: '-4.53%', lastTradeTimestamp: 'Nov 5, 2026' },
    keyStats: { previousclose: { value: '1,422.90' }, dayrange: { value: '1,357.44 - 1,423.03' } } } };
  const result = selectData('IXHC', payload);
  assert.equal(result.price, 1358.39);
  assert.equal(result.previous_close, 1422.9);
  assert.equal(result.day_low, 1357.44);
  assert.equal(result.day_high, 1423.03);
});

test('rejects a payload for the wrong symbol or missing fields', () => {
  assert.throws(() => selectData('IXHC', { data: { symbol: 'IXBK' } }));
  assert.throws(() => selectData('IXHC', { data: { symbol: 'IXHC', primaryData: {}, keyStats: {} } }));
});

test('parses historical OHLC rows and rejects bad payloads', () => {
  const rows = selectHistorical('IXHC', { data: { symbol: 'IXHC', tradesTable: { rows: [
    { date: '11/04/2026', open: '1,402.20', high: '1,422.97', low: '1,382.57', close: '1,422.90', volume: '--' },
  ] } } });
  assert.deepEqual(rows, [{ date: '11/04/2026', open: 1402.2, high: 1422.97, low: 1382.57, close: 1422.9, volume: null }]);
  assert.throws(() => selectHistorical('IXHC', { data: { symbol: 'IXHC' } }));
});

test('covers both broad sectors and sub-sectors with no overlap', () => {
  const sectorSymbols = Object.keys(SECTORS), subSymbols = Object.keys(SUB_SECTORS);
  assert.equal(sectorSymbols.filter(s => subSymbols.includes(s)).length, 0);
  assert.equal(Object.keys(ALL_SECTORS).length, sectorSymbols.length + subSymbols.length);
});

test('records failure and stops requesting after a block', async () => {
  let calls = 0;
  const result = await collect({ fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(Object.keys(result.sectors).length, Object.keys(ALL_SECTORS).length);
  assert.equal(result.sectors.IXCO.status, 'error');
  assert.equal(result.sectors.IXCO.group, 'sector');
  assert.equal(result.sectors.SOX.group, 'sub_sector');
  assert.equal(Object.values(result.sectors).filter(x => x.status === 'skipped').length, Object.keys(ALL_SECTORS).length - 1);
});

test('attaches historical rows on success and tolerates its own failure', async () => {
  const livePayload = { data: { symbol: 'IXCO', companyName: 'NASDAQ Computer', marketStatus: 'Closed',
    primaryData: { lastSalePrice: '100', netChange: '1', percentageChange: '1%', deltaIndicator: 'up', isRealTime: false, lastTradeTimestamp: 'Nov 5, 2026' },
    keyStats: { previousclose: { value: '99' }, dayrange: { value: '98 - 101' } } } };
  const result = await collect({ fetchImpl: async (url) => {
    if (url.includes('/historical')) return new Response('', { status: 500 });
    return new Response(JSON.stringify(livePayload), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(result.sectors.IXCO.status, 'ok');
  assert.equal(result.sectors.IXCO.data.delta_indicator, 'up');
  assert.ok(result.sectors.IXCO.historical.error);
});
