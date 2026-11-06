import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadNaverDailyHistory, priorTradingDates } from '../providers/naver-daily-cache.js';
import { priorHistoryEstimate } from '../providers/forecast-basis.js';
import { rankedRecords } from '../providers/rank-change.js';
import { repoPath } from '../providers/repo-paths.js';
import { kstDate, isValidDate } from './market-calendar.mjs';

export async function buildPreview(target, { now = () => new Date(), loadHistory = loadNaverDailyHistory, universe = null, rawRecord = null, recovery = false } = {}) {
  if (!isValidDate(target)) throw new Error('Invalid target date');
  const [sourceDate] = await priorTradingDates(target);
  const nowDate = now();
  const raw = rawRecord || JSON.parse(await readFile(repoPath(`data/daily-history/${target}.json`), 'utf8'));
  const retrieved = Date.parse(raw.retrieved_at);
  const eveningStart = Date.parse(`${sourceDate}T18:00:00+09:00`);
  const targetStart = Date.parse(`${target}T00:00:00+09:00`);
  const cutoff = Date.parse(`${target}T08:00:00+09:00`);
  const isEvening = raw.collection === 'evening' && retrieved >= eveningStart && retrieved < targetStart;
  const isMorning = raw.collection === 'morning' && retrieved >= targetStart && retrieved < cutoff;
  if (raw.target_date !== target || !Number.isFinite(retrieved) || !(isEvening || isMorning) || retrieved > nowDate.getTime()) throw new Error('Valid evening or pre-08:00 morning collection required');
  if (!recovery && (nowDate.getTime() < eveningStart || nowDate.getTime() >= cutoff)) throw new Error('Preview must be generated before 08:00 KST on the target day');
  const h = await loadHistory({ targetDate: target, now });
  if (!h.ok) throw new Error(h.reason);
  if (h.retrieved_at !== raw.retrieved_at) throw new Error('Preview history does not match the recorded collection');
  const list = universe || JSON.parse(await readFile(repoPath('data/kospi-universe.json'), 'utf8'));
  const names = new Map((list.symbols || []).map(v => [v.symbol, v.name]));
  const candidates = h.valid_symbols.map(symbol => {
    const estimate = priorHistoryEstimate(h.sessions, symbol, { returnHistory: h.return_history?.[symbol], forecastModel: h.forecast_model, rankForecast: h.rank_forecast });
    return { symbol, name: names.get(symbol) || symbol, expected_open: estimate?.expected_open, expected_close: estimate?.expected_close };
  });
  const rows = rankedRecords(candidates);
  if (!rows.length) throw new Error('No valid preview rankings');
  const trainedModel = h.rank_forecast?.model || h.forecast_model || null;
  return { schema_version: 1, kind: 'next_preview', status: h.partial ? 'partial' : 'ready', source_date: sourceDate, target_date: target, generated_at: nowDate.toISOString(), retrieved_at: h.retrieved_at, collection: raw.collection, reconstructed: recovery, data_source: 'naver-daily', market_venue: 'unconfirmed', adjustment: 'unconfirmed', model: trainedModel?.model || 'daily_history', model_trained_at: trainedModel?.trained_at || null, model_train_last_date: trainedModel?.train_last_date || null, universe: h.symbols, universe_complete: !h.partial && !h.universe_stale, rows };
}
export async function savePreview(target, { recovery = false } = {}) {
  const path = repoPath(`data/next-preview/${target}.json`);
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.kind !== 'next_preview' || saved.target_date !== target || !Array.isArray(saved.rows) || !saved.rows.length) throw new Error('Existing preview is invalid and was preserved');
    // A retry can repair a missing latest pointer without changing the frozen ranking.
    if (saved.source_date === kstDate(new Date())) {
      const latestPath = repoPath('data/next-preview/latest.json');
      let latest = null;
      try { latest = JSON.parse(await readFile(latestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!latest || latest.target_date < target) await writeFile(latestPath, JSON.stringify(saved, null, 2)+'\n');
    }
    return {status:'preserved', target_date:target};
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const record = await buildPreview(target, { recovery });
  await mkdir(repoPath('data/next-preview'), {recursive:true});
  try { await writeFile(path, JSON.stringify(record, null, 2)+'\n', {flag:'wx'}); } catch(e) { if(e.code === 'EEXIST') return {status:'preserved', target_date:target}; throw e; }
  // Latest pointer is updated only after the immutable target record is written.
  if (!recovery && record.source_date === kstDate(new Date())) await writeFile(repoPath('data/next-preview/latest.json'), JSON.stringify(record, null, 2)+'\n');
  return {status:record.status, target_date:target, count:record.rows.length};
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = process.argv[2];
  savePreview(target, { recovery: process.argv.includes('--recover') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode=1; });
}
