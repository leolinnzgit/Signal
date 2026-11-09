import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const compile=async file=>ts.transpileModule(await readFile(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const dependency=url(await compile('listening-handoff.ts'));
const {SharedListeningClient,validateSharedProgress,sharedListeningKey}=await import(url((await compile('shared-listening.ts')).replace('"./listening-handoff"',JSON.stringify(dependency))));
const account='A'.repeat(64), email='owner@example.com', story={url:'https://example.com/story',title:'Story',source:'Publisher',imageUrl:'',parts:['Title','First','Latest'],partIndex:1};
function setup(){
 let serial=0,state={accountKey:account,accountEmail:email,version:'0',state:'empty',updatedAt:new Date().toISOString(),document:null},online=true,last=null;
 const storage=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)}};
 const fetcher=async(path,options={})=>{
  if(!online)throw new Error('offline');
  assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
  if(path==='/api/auth/csrf')return Response.json({token:'csrf'});
  if(options.method==='POST'){
   assert.equal(options.headers['X-XSRF-TOKEN'],'csrf');const body=JSON.parse(options.body);
   if(body.accountKey!==state.accountKey)return new Response(null,{status:403});
   if(last?.operationId===body.operationId)return Response.json(state);
   if(body.baseVersion!==state.version)return Response.json(state,{status:409});
   last=body;state={...state,version:(++serial).toString(16).padStart(32,'0'),state:body.action==='save'?'active':body.action==='forget'?'forgotten':'completed',document:body.document};return Response.json(state);
  }
  return Response.json(state);
 };
 return {fetcher,storage,setOnline:value=>online=value,state:()=>structuredClone(state),switchAccount(){state={...state,accountKey:'B'.repeat(64),accountEmail:'other@example.com'}}};
}
test('offline updates survive reopening and cannot overwrite a newer device or resurrect forgotten text',async()=>{
 const server=setup(), diskA=server.storage(),diskB=server.storage();let a=new SharedListeningClient(email,diskA,()=>{},server.fetcher),b=new SharedListeningClient(email,diskB,()=>{},server.fetcher);
 try{
  await a.sync();await b.sync();a.begin('watch');a.report('watch',story);await a.sync();await b.sync();
  server.setOnline(false);a.report('watch',{...story,partIndex:2});await a.sync();a.dispose();
  a=new SharedListeningClient(email,diskA,()=>{},server.fetcher);assert.equal(a.saved().partIndex,2);
  server.setOnline(true);b.forget();await b.sync();assert.equal(server.state().state,'forgotten');
  await a.sync();assert.equal(server.state().state,'forgotten');assert.equal(a.saved(),null);assert.match(a.message,/Newer progress/);
  assert.ok(!diskB.getItem(sharedListeningKey(email)).includes('Latest'));
 }finally{a.dispose();b.dispose()}
});
test('completion persists a clear revision and stale background players cannot reclaim ownership',async()=>{
 const server=setup(),a=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher);
 try{await a.sync();a.begin('old');a.report('old',story);await a.sync();a.begin('new');a.report('new',{...story,partIndex:2});a.report('old',story);await a.sync();assert.equal(server.state().document.partIndex,2);a.finish('new');await a.sync();assert.equal(server.state().state,'completed');assert.equal(a.saved(),null)}finally{a.dispose()}
});
test('queued work is not posted under a different account after sign-in changes',async()=>{
 const server=setup(),a=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher);
 try{await a.sync();a.begin('a');server.setOnline(false);a.report('a',story);await a.sync();server.switchAccount();server.setOnline(true);await a.sync();assert.equal(server.state().document,null);assert.equal(a.progress.accountKey,account);assert.ok(a.pending)}finally{a.dispose(true)}
});
test('a remote clear blocks a previously active lease without pausing its audio or accepting later writes',async()=>{
 const server=setup(),a=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher),b=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher);
 try{await a.sync();a.begin('a');a.report('a',story);await a.sync();await b.sync();b.forget();await b.sync();await a.sync();a.report('a',{...story,partIndex:2});await a.sync();assert.equal(server.state().state,'forgotten');assert.equal(a.pending,null)}finally{a.dispose();b.dispose()}
});
test('saved documents validate exact sections and reject malformed or oversized state',()=>{
 assert.throws(()=>validateSharedProgress({accountKey:account,accountEmail:email,version:'0',state:'active',updatedAt:new Date().toISOString(),document:{...story,parts:['x'.repeat(1001)]}}));
 assert.throws(()=>validateSharedProgress({accountKey:'bad',accountEmail:email,version:'0',state:'empty',updatedAt:new Date().toISOString(),document:null}));
});
test('browser fetch is invoked as a function rather than with the client as its receiver',async()=>{
 const server=setup();const client=new SharedListeningClient(email,server.storage(),()=>{},function(...args){assert.equal(this,undefined);return server.fetcher(...args)});
 try{await client.sync();assert.equal(client.progress.accountKey,account)}finally{client.dispose()}
});

test('playback started before the first sync uses the initial server revision rather than conflicting with version zero',async()=>{
 const server=setup(), existing=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher);
 let client;
 try{
  await existing.sync();existing.begin('existing');existing.report('existing',story);await existing.sync();
  let conflicts=0;
  client=new SharedListeningClient(email,server.storage(),()=>{},async(...args)=>{
   const response=await server.fetcher(...args);if(response.status===409)conflicts++;return response;
  });
  client.begin('fresh-playback');client.report('fresh-playback',{...story,partIndex:2});await client.sync();
  assert.equal(conflicts,0);assert.equal(server.state().document.partIndex,2);assert.equal(client.pending,null);
 }finally{existing.dispose();client?.dispose()}
});

test('a failed initial baseline must not rebase offline playback over newer remote progress',async()=>{
 const server=setup(), remote=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher),client=new SharedListeningClient(email,server.storage(),()=>{},server.fetcher);
 try{
  await remote.sync();remote.begin('remote');remote.report('remote',story);await remote.sync();
  server.setOnline(false);client.begin('offline');client.report('offline',{...story,partIndex:2});await client.sync();
  server.setOnline(true);remote.forget();await remote.sync();await client.sync();
  assert.equal(server.state().state,'forgotten');assert.equal(client.pending,null);assert.equal(client.saved(),null);
 }finally{remote.dispose();client.dispose()}
});
