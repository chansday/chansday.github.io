import { readFile, mkdir, writeFile } from "node:fs/promises";
import { kstDate } from "./market-calendar.mjs";
const number = value => { if (value == null || value === "") return NaN; return Number(String(value).replaceAll(",", "")); };
const scale = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
export function calculateRisk(context, history, flow, date, now = new Date()) {
  const cutoff = Date.parse(`${date}T09:00:00+09:00`), end = Date.parse(context?.completed_at), start = Date.parse(context?.started_at);
  if (kstDate(now) !== date || now.getTime() >= cutoff || !Number.isFinite(start) || !Number.isFinite(end) || end > now.getTime() || end >= cutoff || context.market_date !== date || history?.target_date !== date || Date.parse(history.retrieved_at) > start || !Number.isFinite(Date.parse(history.retrieved_at))) throw new Error("장전 자료 시각 확인 불가");
  const indices = context.sources?.us_indices, fxSource = context.sources?.usd_krw;
  const idx = code => indices?.data?.find(x => x.reutersCode === code);
  const vix = idx(".VIX"), sp = idx(".INX"), fx = fxSource?.data;
  const inputs = [vix, sp, fx];
  if (indices?.status !== "ok" || fxSource?.status !== "ok" || inputs.some(x => !x || !Number.isFinite(Date.parse(x.localTradedAt)) || Date.parse(x.localTradedAt) > end || end - Date.parse(x.localTradedAt) > 4*86400000)) throw new Error("시장 자료 부족 또는 시각 오류");
  const v = number(vix.closePrice), s = number(sp.fluctuationsRatio), f = number(fx.fluctuationsRatio);
  if (![v,s,f].every(Number.isFinite) || v <= 0) throw new Error("시장 자료 부족");
  const symbols = history.symbols || [], series = history.return_history || {};
  const latest = history.sessions?.[0]?.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest || "") || latest >= date || Date.parse(`${date}T00:00:00+09:00`) - Date.parse(`${latest}T00:00:00+09:00`) > 7*86400000 || flow?.date !== latest || !symbols.length) throw new Error("종목·수급 기준일 불일치");
  let valid = 0, volatile = 0, heated = 0, flowValid = 0, selling = 0;
  for (const symbol of symbols) {
    const bars = series[symbol];
    if (Array.isArray(bars) && bars.length >= 6 && bars.slice(0,6).every((b,i) => /^\d{4}-\d{2}-\d{2}$/.test(b[0]) && b[0] < date && (i === 0 || b[0] < bars[i-1][0]) && Number.isFinite(b[2]) && b[2] > 0) && bars[0][0] === latest) {
      const changes = bars.slice(0,5).map((b,i) => b[2] / bars[i+1][2] - 1);
      const mean = changes.reduce((a,b) => a+b,0)/5;
      const sd = Math.sqrt(changes.reduce((a,b) => a+(b-mean)**2,0)/5);
      valid++; if (sd >= .04) volatile++; if (bars[0][2]/bars[5][2]-1 >= .15) heated++;
    }
    const row = flow.stocks?.[symbol];
    if (Number.isFinite(row?.foreign_net_shares) && Number.isFinite(row?.institution_net_shares)) { flowValid++; if (row.foreign_net_shares < 0 && row.institution_net_shares < 0) selling++; }
  }
  if (valid / symbols.length < .8 || flowValid / symbols.length < .8) throw new Error("종목 또는 수급 자료 80% 미만");
  const market = 30 * (scale(v, 15, 35) + scale(-s, 0, 3) + scale(Math.abs(f), 0, 2))/3;
  const stocks = 40 * (scale(volatile/valid, 0, .4) + scale(heated/valid, 0, .3))/2;
  const supply = 30 * scale(selling/flowValid, 0, .6);
  const parts = [market, stocks, supply].map(x => Math.round(x));
  return { date, generated_at: now.toISOString(), market_at: context.completed_at, history_date: latest, score: parts.reduce((a,b)=>a+b,0), parts, coverage: { stocks: valid, flow: flowValid, total: symbols.length }, inputs: { vix:v, sp_change:s, fx_change:f, volatile_share:volatile/valid, heated_share:heated/valid, selling_share:selling/flowValid } };
}
async function main() {
 const path = process.argv[2], context = JSON.parse(await readFile(path,"utf8")), date = context.market_date;
 const history = JSON.parse(await readFile(`data/daily-history/${date}.json`,"utf8"));
 const latest = history.sessions?.[0]?.date;
 const flow = JSON.parse(await readFile(`data/investor-flow/${latest}.json`,"utf8"));
 const result = calculateRisk(context, history, flow, date);
 await mkdir("data/risk-index", {recursive:true});
 await writeFile(`data/risk-index/${date}.json`, JSON.stringify(result,null,2)+"\n", {flag:"wx"});
 console.log(`장전 위험 지수 ${result.score}점 저장`);
}
if (process.argv[1]?.replaceAll("\\","/").endsWith("/build-risk-index.mjs")) main().catch(e => { console.error(e.message); process.exitCode = 1; });
