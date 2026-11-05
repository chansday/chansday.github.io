import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
test('audit logs process and request outcome without exposing URL secrets', () => {
  const env={...process.env,KOSPI_REQUEST_AUDIT:'1'}; delete env.NODE_TEST_CONTEXT;
  const r=spawnSync(process.execPath,['--import','./providers/request-audit.js','-e',"fetch('data:text/plain,private-value').then(r=>console.log(r.status))"],{env,encoding:'utf8'});
  assert.equal(r.status,0); assert.equal(r.stdout.trim(),'200');
  assert.match(r.stderr,/시작/); assert.match(r.stderr,/HTTP=200/); assert.match(r.stderr,/종료 코드=0/);
  assert.doesNotMatch(r.stderr,/private-value/);
});
test('all workflows that set up Node enable common audit after setup', () => {
  const dir='.github/workflows';
  for (const name of readdirSync(dir).filter(x=>x.endsWith('.yml'))) {
    const text=readFileSync(`${dir}/${name}`,'utf8');
    if (!text.includes('node-version: 22')) continue;
    assert.ok(text.indexOf('BASH_ENV=$GITHUB_WORKSPACE/scripts/audit-env.sh') > text.indexOf('node-version: 22'),name);
  }
  assert.match(readFileSync(`${dir}/scheduler-keeper.yml`,'utf8'),/providers\/request-audit\.js/);
});
