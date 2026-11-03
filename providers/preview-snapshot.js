import { isIsoDate } from './date-navigation.js';
export function previewToSnapshot(preview, date) {
  if (preview?.kind !== 'next_preview' || preview.target_date !== date || !isIsoDate(date) || !isIsoDate(preview.source_date) || preview.source_date >= date || !['ready','partial'].includes(preview.status) || !Array.isArray(preview.rows) || !preview.rows.length) throw new Error('Invalid next trading day preview');
  const seen = new Set();
  const rows = preview.rows.map((row, index) => {
    if (!/^\d{6}$/.test(row?.symbol || '') || seen.has(row.symbol) || row.rank !== index + 1 || !(Number.isFinite(row.expected_open) && row.expected_open > 0) || !(Number.isFinite(row.expected_close) && row.expected_close > 0)) throw new Error('Invalid preview row');
    seen.add(row.symbol);
    return {symbol:row.symbol,name:row.name || row.symbol,rank:row.rank,expected_open:row.expected_open,expected_close:row.expected_close,actual_open:null,actual_close:null,actual_high:null,actual_volume:null,status:'pending',quality:'pending'};
  });
  return {mode:'provider',status:'partial',asOfDate:date,publishedAt:preview.generated_at,provider:{id:'next-preview',label:'전일 미리보기'},meta:{run_date:date,run_stage:'next-preview',preview:true,source_date:preview.source_date,lastAttemptAt:preview.generated_at},pipeline:{},rows};
}
