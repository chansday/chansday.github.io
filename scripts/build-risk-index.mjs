import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { kstDate } from "./market-calendar.mjs";
const number = value => { if (value == null || value === "") return NaN; return Number(String(value).replaceAll(",", "")); };
const scale = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
export function calculateRisk(context, history, flow, date, now = new Date(), prior = null, sidecar = null) {
  const cutoff = Date.parse(`${date}T09:00:00+09:00`), end = Date.parse(context?.completed_at), start = Date.parse(context?.started_at);
  if (kstDate(now) !== date || now.getTime() >= cutoff || !Number.isFinite(start) || !Number.isFinite(end) || end > now.getTime() || end >= cutoff || context.market_date !== date || history?.target_date !== date || Date.parse(history.retrieved_at) > start || !Number.isFinite(Date.parse(history.retrieved_at))) throw new Error("장전 자료 시각 확인 불가");
  const indices = context.sources?.us_indices, fxSource = context.sources?.usd_krw;
  const idx = code => indices?.data?.find(x => x.reutersCode === code);
  const vix = idx(".VIX"), sp = idx(".INX"), nasdaq = idx(".IXIC"), sox = idx(".SOX"), fx = fxSource?.data;
  const inputs = [vix, sp, nasdaq, sox, fx];
  if (indices?.status !== "ok" || fxSource?.status !== "ok" || inputs.some(x => !x || !Number.isFinite(Date.parse(x.localTradedAt)) || Date.parse(x.localTradedAt) > end || end - Date.parse(x.localTradedAt) > 4*86400000)) throw new Error("시장 자료 부족 또는 시각 오류");
  const v = number(vix.closePrice), s = number(sp.fluctuationsRatio), n = number(nasdaq.fluctuationsRatio), so = number(sox.fluctuationsRatio), f = number(fx.fluctuationsRatio);
  if (![v,s,n,so,f].every(Number.isFinite) || v <= 0) throw new Error("시장 자료 부족");
  const symbols = history.symbols || [], series = history.return_history || {};
  const latest = history.sessions?.[0]?.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest || "") || latest >= date || Date.parse(`${date}T00:00:00+09:00`) - Date.parse(`${latest}T00:00:00+09:00`) > 7*86400000 || flow?.date !== latest || !symbols.length) throw new Error("종목·수급 기준일 불일치");
  const priorSource = prior?.sources?.kospi, priorTime = Date.parse(prior?.completed_at), priorQuote = priorSource?.data;
  if (prior?.market_date !== latest || priorSource?.status !== "ok" || !Number.isFinite(priorTime) || priorTime > start || priorTime < Date.parse(`${latest}T15:30:00+09:00`) || !Number.isFinite(Date.parse(priorQuote?.localTradedAt)) || Date.parse(priorQuote.localTradedAt) < Date.parse(`${latest}T15:30:00+09:00`) || Date.parse(priorQuote.localTradedAt) > priorTime || !String(priorQuote.localTradedAt).startsWith(latest)) throw new Error("전일 코스피 종가 자료 확인 불가");
  const priorChange = number(priorQuote.fluctuationsRatioRaw ?? priorQuote.fluctuationsRatio);
  if (!Number.isFinite(priorChange)) throw new Error("전일 코스피 등락 자료 부족");
  const sidecarKnown = sidecar?.date === latest && typeof sidecar.sell_sidecar === "boolean" && Number.isFinite(Date.parse(sidecar.published_at)) && Date.parse(sidecar.published_at) <= start;
  let valid = 0, volatile = 0, falling = 0, severe = 0, flowValid = 0, selling = 0;
  for (const symbol of symbols) {
    const bars = series[symbol];
    if (Array.isArray(bars) && bars.length >= 6 && bars.slice(0,6).every((b,i) => /^\d{4}-\d{2}-\d{2}$/.test(b[0]) && b[0] < date && (i === 0 || b[0] < bars[i-1][0]) && Number.isFinite(b[2]) && b[2] > 0) && bars[0][0] === latest) {
      const changes = bars.slice(0,5).map((b,i) => b[2] / bars[i+1][2] - 1);
      const mean = changes.reduce((a,b) => a+b,0)/5;
      const sd = Math.sqrt(changes.reduce((a,b) => a+(b-mean)**2,0)/5);
      valid++; if (sd >= .04) volatile++; if (changes[0] < 0) falling++; if (changes[0] <= -.05) severe++;
    }
    const row = flow.stocks?.[symbol];
    if (Number.isFinite(row?.foreign_net_shares) && Number.isFinite(row?.institution_net_shares)) { flowValid++; if (row.foreign_net_shares < 0 && row.institution_net_shares < 0) selling++; }
  }
  if (valid / symbols.length < .8 || flowValid / symbols.length < .8) throw new Error("종목 또는 수급 자료 80% 미만");
  const global = 40 * (.3*scale(-s,0,4) + .2*scale(-n,0,5) + .25*scale(-so,0,8) + .15*scale(v,15,35) + .1*scale(f,0,2));
  const local = 30 * (sidecarKnown ? .7*scale(-priorChange,0,5)+.3*(sidecar.sell_sidecar ? 1 : 0) : scale(-priorChange,0,5));
  const stocks = 20 * (.5*scale(falling/valid,.3,.8)+.3*scale(severe/valid,0,.5)+.2*scale(volatile/valid,0,.4));
  const supply = 10 * scale(selling/flowValid,0,.6);
  const parts = [global,local,stocks,supply].map(Math.round);
  const base = parts.reduce((a,b)=>a+b,0);
  const floor = s <= -4 || (so <= -8 && v >= 25) ? 75 : 0;
  return { version:2, date, generated_at:now.toISOString(), market_at:context.completed_at, history_date:latest, score:Math.max(base,floor), base_score:base, shock_floor:floor, parts, sidecar_status:sidecarKnown ? (sidecar.sell_sidecar ? "confirmed" : "none") : "unknown", coverage:{stocks:valid,flow:flowValid,total:symbols.length}, inputs:{vix:v,sp_change:s,nasdaq_change:n,sox_change:so,fx_change:f,prior_kospi_change:priorChange,falling_share:falling/valid,severe_share:severe/valid,volatile_share:volatile/valid,selling_share:selling/flowValid} };

}
async function main() {
 const path = process.argv[2], context = JSON.parse(await readFile(path,"utf8")), date = context.market_date;
 const history = JSON.parse(await readFile(`data/daily-history/${date}.json`,"utf8"));
 const latest = history.sessions?.[0]?.date;
 const flow = JSON.parse(await readFile(`data/investor-flow/${latest}.json`,"utf8"));
 const dir = `data/market-context/${latest}`;
 const candidates = (await readdir(dir)).filter(x => x.startsWith("after_close-") && x.endsWith(".json")).sort().reverse();
 let prior = null;
 for (const name of candidates) { const item = JSON.parse(await readFile(`${dir}/${name}`,"utf8")); if (Date.parse(item.completed_at) <= Date.parse(context.started_at)) { prior=item; break; } }
 let sidecar = null;
 try { sidecar = JSON.parse(await readFile(`data/market-events/${latest}.json`,"utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
 const result = calculateRisk(context, history, flow, date, new Date(), prior, sidecar);
 await mkdir("data/risk-index", {recursive:true});
 await writeFile(`data/risk-index/${date}.json`, JSON.stringify(result,null,2)+"\n", {flag:"wx"});
 console.log(`장전 위험 지수 ${result.score}점 저장`);
}
if (process.argv[1]?.replaceAll("\\","/").endsWith("/build-risk-index.mjs")) main().catch(e => { console.error(e.message); process.exitCode = 1; });
