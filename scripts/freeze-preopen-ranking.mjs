import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { repoPath } from '../providers/repo-paths.js';
import { isValidDate } from './market-calendar.mjs';
import { rankedRecords } from '../providers/rank-change.js';

export function buildPreopenRanking(snapshot, target) {
  const recorded = Date.parse(snapshot?.meta?.lastAttemptAt);
  const sourceTime = Date.parse(snapshot?.meta?.source?.retrieved_at);
  if (!isValidDate(target) || snapshot?.mode !== 'provider' || snapshot?.meta?.run_date !== target || snapshot?.asOfDate !== target || snapshot?.meta?.run_stage !== 'forecast' || snapshot?.meta?.test_only || snapshot?.meta?.historical_test || snapshot?.meta?.reconstruction || snapshot?.meta?.retrospective_evaluation || !['ready','partial'].includes(snapshot?.pipeline?.forecast?.status) || !Number.isFinite(recorded) || !Number.isFinite(sourceTime) || sourceTime < recorded || sourceTime >= Date.parse(`${target}T09:00:00+09:00`) || recorded < Date.parse(`${target}T00:00:00+09:00`) || recorded >= Date.parse(`${target}T09:00:00+09:00`) || !Array.isArray(snapshot.rows)) throw new Error('Valid pre-open forecast required');
  const rows = rankedRecords(snapshot.rows);
  if (!rows.length) throw new Error('No ranked pre-open forecasts');
  return {schema_version:1,kind:'preopen_ranking',target_date:target,generated_at:snapshot.meta.lastAttemptAt,run_id:snapshot.meta.run_id,rows};
}
export async function freezePreopenRanking(target, { now = () => new Date() } = {}) {
  if (!isValidDate(target) || now().getTime() >= Date.parse(`${target}T09:00:00+09:00`) || now().getTime() < Date.parse(`${target}T00:00:00+09:00`)) throw new Error("Pre-open ranking must be saved before the market opens");
  const path=repoPath(`data/preopen-ranking/${target}.json`);
  try { await readFile(path); return {status:'preserved'}; } catch(e) { if(e.code !== 'ENOENT') throw e; }
  const content = await readFile(repoPath(`data/runs/${target}/0835.json`), 'utf8').catch(e => { if (e.code === 'ENOENT') return readFile(repoPath(`data/runs/${target}/0820.json`), 'utf8'); throw e; });
  const snapshot = JSON.parse(content);
  const record=buildPreopenRanking(snapshot,target);
  await mkdir(repoPath('data/preopen-ranking'),{recursive:true});
  try {await writeFile(path, JSON.stringify(record,null,2)+'\n',{flag:'wx'});} catch(e) {if(e.code==='EEXIST') return {status:'preserved'}; throw e;}
  return {status:'ready',count:record.rows.length};
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) freezePreopenRanking(process.argv[2]).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
