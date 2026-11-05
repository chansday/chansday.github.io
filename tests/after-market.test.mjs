import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAfterMarket } from '../scripts/collect-after-market.mjs';

const now = () => new Date('2026-11-05T11:05:00Z');
const response = (status, body, type='application/json') => new Response(JSON.stringify(body), {status, headers:{'content-type':type}});
test('preserves raw quote and marks missing symbols partial', async () => {
  const result = await collectAfterMarket({symbols:['005930','000660'], now, sleep:async()=>{}, fetchImpl:async url => url.endsWith('/robots.txt') ? new Response('',{status:404}) : response(200,{datas:[{symbolCode:'005930',closePriceRaw:'123',overMarketPriceInfo:{overPrice:'124'}}]})});
  assert.equal(result.status,'partial');
  assert.equal(result.batches[0].payload.datas[0].overMarketPriceInfo.overPrice,'124');
  assert.equal(result.date,'2026-11-05');
});
test('stops on HTTP 429 and never retries', async () => {
  let requests=0;
  const result=await collectAfterMarket({symbols:['005930'],now,fetchImpl:async url => url.endsWith('/robots.txt') ? new Response('',{status:404}) : (requests++,response(429,{}))});
  assert.equal(result.status,'failed'); assert.equal(requests,1); assert.match(result.error,/429/);
});
test('refuses before 20:00 KST', async () => {
  await assert.rejects(collectAfterMarket({symbols:['005930'],now:()=>new Date('2026-11-05T10:59:59Z')}),/20:00/);
});

