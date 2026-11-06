import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const calendars={us:JSON.parse(readFileSync(new URL("../data/us-market-calendar.json",import.meta.url))),krx:JSON.parse(readFileSync(new URL("../data/krx-market-holidays.json",import.meta.url)))};
import { calculateRisk } from "../scripts/build-risk-index.mjs";
const date="2026-11-06", now=new Date("2026-11-06T08:25:00+09:00");
const context={market_date:date,started_at:"2026-11-06T08:20:00+09:00",completed_at:"2026-11-06T08:21:00+09:00",sources:{us_indices:{status:"ok",data:[{reutersCode:".VIX",closePrice:"25",localTradedAt:"2026-11-06T06:05:00+09:00"},{reutersCode:".INX",fluctuationsRatio:"-1.5",localTradedAt:"2026-11-06T06:05:00+09:00"},{reutersCode:".IXIC",fluctuationsRatio:"-1",localTradedAt:"2026-11-06T06:05:00+09:00"},{reutersCode:".SOX",fluctuationsRatio:"-2",localTradedAt:"2026-11-06T06:05:00+09:00"}]},usd_krw:{status:"ok",data:{fluctuationsRatio:"1",localTradedAt:"2026-11-06T08:00:00+09:00"}}}};
const history={target_date:date,retrieved_at:"2026-11-06T07:00:00+09:00",symbols:["000001"],sessions:[{date:"2026-11-05"}],return_history:{"000001":[["2026-11-05",0,100],["2026-11-04",0,100],["2026-11-03",0,100],["2026-11-02",0,100],["2026-10-30",0,100],["2026-10-29",0,100]]}};
const flow={date:"2026-11-05",stocks:{"000001":{foreign_net_shares:-1,institution_net_shares:-1}}};
const prior={market_date:"2026-11-05",completed_at:"2026-11-05T16:30:00+09:00",sources:{kospi:{status:"ok",data:{localTradedAt:"2026-11-05T15:30:00+09:00",fluctuationsRatio:"-1"}}}};
const event={date:"2026-11-05",sell_sidecar:true,published_at:"2026-11-05T10:17:00+09:00"};
const calc=(c=context,h=history,f=flow,t=now,p=prior,e=event)=>calculateRisk(c,h,f,date,t,p,e,calendars);
test("충격 하한과 전일 사이드카",()=>{const c=structuredClone(context);c.sources.us_indices.data.find(x=>x.reutersCode===".INX").fluctuationsRatio="-4.36";const r=calc(c);assert.equal(r.score,75);assert.equal(r.shock_floor,75);assert.equal(r.sidecar_status,"confirmed");});
test("미확인 사이드카는 미발동으로 취급하지 않음",()=>{const r=calc(context,history,flow,now,prior,null);assert.equal(r.sidecar_status,"unknown");});
test("장 시작 후 및 사후 수집 자료 거부",()=>{assert.throws(()=>calc(context,history,flow,new Date("2026-11-06T09:00:00+09:00")));assert.throws(()=>calc(context,{...history,retrieved_at:"2026-11-06T08:22:00+09:00"}));});
test("당일 가격 및 수급 누락 거부",()=>{assert.throws(()=>calc(context,history,{...flow,stocks:{}}));const h=structuredClone(history);h.return_history["000001"][0][0]=date;assert.throws(()=>calc(context,h));});
test("전일 자료와 공개시각 검증",()=>{assert.throws(()=>calc(context,history,flow,now,{...prior,market_date:date}));const r=calc(context,history,flow,now,prior,{...event,published_at:"2026-11-06T09:34:00+09:00"});assert.equal(r.sidecar_status,"unknown");});

test("미국 거래일 일치와 종가 확인",()=>{ const c=structuredClone(context); c.sources.us_indices.data[0].localTradedAt="2026-11-05T15:30:00-05:00"; assert.throws(()=>calc(c),/종가 시각 불일치/); });
test("오래된 환율 거부",()=>{ const c=structuredClone(context); c.sources.usd_krw.data.localTradedAt="2026-11-05T07:00:00+09:00"; assert.throws(()=>calc(c),/환율 자료/); });
test("달력 미확인 거부",()=>assert.throws(()=>calculateRisk(context,history,flow,date,now,prior,event,null),/달력/));


test("미국 휴장 다음 한국장에는 이전 충격을 재사용하지 않음",()=>{
 const c=structuredClone(context), h=structuredClone(history), f=structuredClone(flow), p=structuredClone(prior);
 c.market_date="2026-11-27"; c.started_at="2026-11-27T08:20:00+09:00"; c.completed_at="2026-11-27T08:21:00+09:00";
 for(const x of c.sources.us_indices.data)x.localTradedAt="2026-11-25T16:10:00-05:00";
 c.sources.usd_krw.data.localTradedAt="2026-11-27T08:00:00+09:00";
 h.target_date=c.market_date; h.retrieved_at="2026-11-27T07:00:00+09:00"; h.sessions[0].date="2026-11-26";
 f.date="2026-11-26"; p.market_date=f.date; p.completed_at="2026-11-26T16:30:00+09:00"; p.sources.kospi.data.localTradedAt="2026-11-26T15:30:00+09:00";
 assert.throws(()=>calculateRisk(c,h,f,c.market_date,new Date("2026-11-27T08:25:00+09:00"),p,null,calendars),/새 미국 정규장 종가 없음/);
});
test("여러 미국 거래일을 하루 변동률로 계산하지 않음",()=>{
 const c=structuredClone(context),h=structuredClone(history),f=structuredClone(flow),p=structuredClone(prior),cal=structuredClone(calendars);
 c.market_date="2026-11-26"; c.started_at="2026-11-26T08:20:00+09:00"; c.completed_at="2026-11-26T08:21:00+09:00";
 for(const x of c.sources.us_indices.data)x.localTradedAt="2026-11-25T16:10:00-05:00";
 c.sources.usd_krw.data.localTradedAt="2026-11-26T08:00:00+09:00";
 h.target_date=c.market_date; h.retrieved_at="2026-11-26T07:00:00+09:00"; h.sessions[0].date="2026-11-23";
 f.date="2026-11-23"; p.market_date=f.date; p.completed_at="2026-11-23T16:30:00+09:00"; p.sources.kospi.data.localTradedAt="2026-11-23T15:30:00+09:00";
 cal.krx.holidays.push({date:"2026-11-24",name:"test holiday",kind:"test"},{date:"2026-11-25",name:"test holiday",kind:"test"});
 assert.throws(()=>calculateRisk(c,h,f,c.market_date,new Date("2026-11-26T08:25:00+09:00"),p,null,cal),/3개 거래일 누적/);
});
