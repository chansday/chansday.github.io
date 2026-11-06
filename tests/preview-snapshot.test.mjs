import test from 'node:test';
import assert from 'node:assert/strict';
import {previewToSnapshot} from '../providers/preview-snapshot.js';
import {classifyDate,normalizeDateIndex} from '../providers/date-navigation.js';
const preview={kind:'next_preview',status:'ready',source_date:'2026-10-30',target_date:'2026-11-02',generated_at:'2026-10-30T09:45:00Z',rows:[{symbol:'011420',name:'테스트',rank:1,expected_open:100,expected_close:110}]};
test('preview represents only estimates and never invents actual prices',()=>{
 const result=previewToSnapshot(preview,'2026-11-02');assert.equal(result.meta.preview,true);assert.equal(result.rows[0].expected_close,110);assert.equal(result.rows[0].actual_open,null);assert.equal(result.rows[0].actual_close,null);assert.throws(()=>previewToSnapshot(preview,'2026-11-03'));assert.throws(()=>previewToSnapshot({...preview,rows:[preview.rows[0],preview.rows[0]]},'2026-11-02'));
});
test('date navigation shows preview until a real pre-open result exists',()=>{
 const index=normalizeDateIndex({previewDates:['2026-11-02'],availableDates:{provider:['2026-11-02']},latestStages:{provider:{'2026-11-02':'0800'}}});
 assert.equal(classifyDate('2026-11-02','provider',index,{}).status,'preview');
 index.latestStages.provider['2026-11-02']='0820';assert.equal(classifyDate('2026-11-02','provider',index,{}).status,'available');
 index.latestStages.provider['2026-11-02']='0835';assert.equal(classifyDate('2026-11-02','provider',index,{}).status,'available');
 assert.equal(classifyDate('2026-11-02','fixture',index,{}).status,'not_collected');
});
