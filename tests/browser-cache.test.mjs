import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('browser cache revision changes with published browser code', async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const map=JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
 const paths=[...new Set(['app.js','styles.css',...Object.keys(map).map(x=>x.replace(/^\.\//,''))])].sort();
 const hash=createHash('sha256');
 for(const path of paths) {
  assert.match(path,/^(?:app\.js|styles\.css|providers\/[a-z0-9-]+\.js)$/);
  const content=(await readFile(new URL('../'+path,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  hash.update(path+'\0'+content+'\0');
 }
 const expected='assets'+hash.digest('hex').slice(0,16);
 for(const [key,value] of Object.entries(map)) assert.equal(value,`${key}?v=${expected}`,`${key}: update browser asset revision`);
 assert.ok(html.includes(`./app.js?v=${expected}`));
 assert.ok(html.includes(`./styles.css?v=${expected}`));
 assert.ok(html.includes(`./providers/daily-experiment-view.js?v=${expected}`));
});
