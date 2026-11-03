import { isKoreanSymbol } from './korean-symbol.js';
function signedInteger(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const text=String(value).trim();if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text))return null;
  const n=Number(text.replaceAll(',',''));return Number.isSafeInteger(n)?n:null;
}
function percentage(value) {
  if(value===null||value===undefined||value===''||value==='-')return null;
  const text=String(value).trim();if(!/^\d+(?:\.\d+)?%$/.test(text))return null;
  const n=Number(text.slice(0,-1));return Number.isFinite(n)&&n>=0&&n<=100?n:null;
}
function dateText(value) {
  if(!/^\d{8}$/.test(String(value||'')))return null;
  const s=String(value),iso=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`,date=new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:null;
}
// The source's raw signed shares are retained; missing values are never inferred.
export function parseInvestorFlow(payload,symbol,startDate,endDate,asOfDate) {
  if(!isKoreanSymbol(symbol)||!Array.isArray(payload))throw new Error('Invalid investor response');
  const seen=new Set(),rows=[];
  for(const row of payload){
    const date=dateText(row?.bizdate);
    if(row?.itemCode!==symbol||!date||date>asOfDate||seen.has(date))throw new Error('Investor row identity or date invalid');
    seen.add(date);
    if(date<startDate||date>endDate)continue;
    rows.push({date,foreign_net_shares:signedInteger(row.foreignerPureBuyQuant),institution_net_shares:signedInteger(row.organPureBuyQuant),individual_net_shares:signedInteger(row.individualPureBuyQuant),foreign_holding_pct:percentage(row.foreignerHoldRatio)});
  }
  rows.sort((a,b)=>b.date.localeCompare(a.date));return {symbol,rows};
}
