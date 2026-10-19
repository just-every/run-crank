import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';
const fake=fakeEdge();let h;
before(async()=>{fake.routes.set('orders.example',({url})=>{
 const page=Number(url.searchParams.get('page')??1),cursor=url.searchParams.get('cursor');
 if(url.pathname==='/bad')return jsonResponse({rows:{id:'not-an-array'}});
 if(url.pathname==='/cycle')return jsonResponse({rows:[{id:'o-1'}],next:'same'});
 if(url.pathname==='/cursor')return jsonResponse({rows:cursor?[{id:'o-2'}]:[{id:'o-1'}],next:cursor?null:'second'});
 if(url.pathname==='/link')return jsonResponse({rows:page===1?[{id:'o-1'}]:[{id:'o-2'}]},200,page===1?{link:'<https://orders.example/link?page=2>; rel="next"'}:{});
 return jsonResponse({rows:page<3?[{id:'o-'+page}]:[]});
});h=await harness('http://127.0.0.1:9',{edge:fake.edge});});
after(async()=>await h?.close());
const graph=(kind,path,spec={})=>({trigger:{type:'manual'},steps:[{id:'orders',type:'http',input:{method:'GET',url:'https://orders.example/'+path},pagination:{kind,items_path:'rows',max_pages:5,max_items:20,...(kind==='cursor'?{cursor_path:'next'}:{}),...spec}},{id:'use',type:'map',input:{rows:'{{steps.orders.items}}'}}]});
test('WORK-003: cursor, page and link datasets are exhausted and retained before downstream batch processing',async()=>{
 for(const [kind,path,pages]of [['cursor','cursor',2],['page','page',3],['link','link',2]]){
  const workflow=await publish(h,'Paginated orders '+kind,graph(kind,path));const run=await startRun(h,workflow,{});assert.equal(run.status,'succeeded',JSON.stringify(run.error));
  assert.deepEqual(stepOf(run,'orders').output.items,[{id:'o-1'},{id:'o-2'}]);assert.equal(stepOf(run,'orders').output.pages,pages);assert.equal(stepOf(run,'orders').output.complete,true);
  assert.deepEqual(stepOf(run,'use').output.rows,[{id:'o-1'},{id:'o-2'}]);assert.equal(run.attempts.length,pages);
 }
});
test('WORK-003: truncated, malformed, cyclic and oversized datasets fail visibly before any downstream action',async()=>{
 for(const [path,spec,outcome]of [['cursor',{max_pages:1},'pagination truncated'],['cursor',{max_items:1},'pagination limit'],['cursor',{max_bytes:1},'pagination limit'],['bad',{},'invalid pagination items'],['cycle',{},'pagination cycle']]){
  const workflow=await publish(h,'Bounded source '+outcome,graph('cursor',path,spec));const run=await startRun(h,workflow,{});assert.equal(run.status,'failed');assert.equal(run.error.outcome,outcome);assert.ok(!stepOf(run,'use'));
 }
 for(const pagination of [{kind:'cursor'},{kind:'page',max_pages:0},{kind:'page',max_pages:NaN},{kind:'unknown'},{kind:'page',max_items:-1}])await h.post('workflows',{name:'Invalid dataset declaration',graph:{trigger:{type:'manual'},steps:[{id:'source',type:'http',input:{url:'https://orders.example'},pagination}]}},h.owner,422);
});
