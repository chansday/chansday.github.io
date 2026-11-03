import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { kstDate } from './market-calendar.mjs';
import { repoPath } from '../providers/repo-paths.js';

const date = kstDate(new Date());
const time = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
if (date === process.env.SOURCE_DATE && time >= '18:00') {
  const path = repoPath('data/next-preview/status.json');
  let previous; try { previous = JSON.parse(await readFile(path,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const success = process.env.PREVIEW_OUTCOME === 'success';
  if (!(previous?.source_date === date && previous.status === 'ready' && !success)) {
    await mkdir(repoPath('data/next-preview'),{recursive:true});
    await writeFile(path, JSON.stringify({source_date:date,status:success?'ready':'blocked',checked_at:new Date().toISOString()},null,2)+'\n');
  }
}
