const cache = new Map();
export async function loadInvestorDays(dates, fetchImpl=fetch) {
  const unique = [...new Set(dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
  const entries = await Promise.all(unique.map(async date => {
    if (!cache.has(date)) {
      try {
        const res=await fetchImpl(`./data/investor-flow/${date}.json`,{cache:'no-store'});
        if (!res.ok) return [date,null];
        const data=await res.json();
        if(data.date !== date || !data.stocks || typeof data.stocks !== 'object') return [date,null];
        cache.set(date,data.stocks);
      } catch { return [date,null]; }
    }
    return [date,cache.get(date)];
  }));
  const result=new Map();
  for(const [date,stocks] of entries) for(const [symbol,row] of Object.entries(stocks || {})) result.set(`${symbol}:${date}`,row);
  return result;
}
export function formatInvestorShares(value) {
  return Number.isSafeInteger(value) ? `${value>0?'+':''}${value.toLocaleString('ko-KR')}` : '-';
}
