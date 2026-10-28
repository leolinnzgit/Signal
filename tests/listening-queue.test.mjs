import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const compile=async file=>ts.transpileModule(await readFile(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const handoff=url(await compile('listening-handoff.ts'));
const shared=url((await compile('shared-listening.ts')).replace('"./listening-handoff"',JSON.stringify(handoff)));
const {ListeningQueueClient,validateQueue,listeningQueueKey}=await import(url((await compile('listening-queue.ts')).replace('"./shared-listening"',JSON.stringify(shared))));
const account='A'.repeat(64),email='owner@example.com';
const story=n=>({url:`https://example.com/${n}`,title:`Story ${n}`,source:'Publisher',imageUrl:'',parts:['Heading','First','Last'],partIndex:0});
function setup(){
 let state={accountKey:account,accountEmail:email,version:'0',state:'empty',updatedAt:new Date().toISOString(),document:null},serial=0,online=true,last=null;
 const disk=new Map(),storage={getItem:key=>disk.get(key)||null,setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)};
 const fetcher=async function(path,options={}){
  assert.equal(this,undefined);if(!online)throw Error('offline');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
  if(path==='/api/auth/csrf')return Response.json({token:'csrf'});
  if(options.method==='POST'){
   const body=JSON.parse(options.body);assert.equal(options.headers['X-XSRF-TOKEN'],'csrf');
   if(body.accountKey!==state.accountKey)return new Response(null,{status:403});
   if(last?.operationId===body.operationId)return Response.json(state);
   if(body.baseVersion!==state.version)return Response.json(state,{status:409});
   last=body;state={...state,version:(++serial).toString(16).padStart(32,'0'),state:'active',document:body.document};
  }
  return Response.json(state);
 };
 return {storage,fetcher,state:()=>structuredClone(state),online:value=>online=value,changeAccount(){state={...state,accountKey:'B'.repeat(64),accountEmail:'other@example.com'}}};
}
test('queue add, duplicate prevention, reorder, current section, consumption and clear retain durable revisions',async()=>{
 const server=setup(),client=new ListeningQueueClient(email,server.storage,()=>{},server.fetcher);
 try{
  await client.sync();client.add(story(1));client.add(story(2));client.add(story(1));assert.equal(client.saved().items.length,2);
  client.move(story(2).url,-1);assert.equal(client.saved().items[0].url,story(2).url);assert.equal(client.saved().currentUrl,story(1).url);
  client.begin('play',story(1).url);client.track('play',story(1).url,2);await client.sync();assert.equal(server.state().document.items[1].partIndex,2);
  const next=client.finish('play',story(1).url);assert.equal(next.url,story(2).url);client.finish('play',next.url);await client.sync();
  assert.deepEqual(server.state().document,{items:[],currentUrl:null});assert.notEqual(server.state().version,'0');
  assert.ok(!server.storage.getItem(listeningQueueKey(email)).includes('Heading'));
 }finally{client.dispose()}
});
test('offline queue survives reopening; a newer removal wins and blocks old playback writes',async()=>{
 const server=setup();let a=new ListeningQueueClient(email,server.storage,()=>{},server.fetcher);
 const b=new ListeningQueueClient(email,null,()=>{},server.fetcher);
 try{
  await a.sync();a.add(story(1));a.add(story(2));await a.sync();await b.sync();a.begin('a',story(1).url);
  server.online(false);a.track('a',story(1).url,2);await a.sync();a.dispose();a=new ListeningQueueClient(email,server.storage,()=>{},server.fetcher);assert.equal(a.saved().items[0].partIndex,2);
  server.online(true);b.remove(story(1).url);await b.sync();await a.sync();assert.equal(a.saved().items.length,1);assert.match(a.message,/newer queue/);
  a.track('a',story(1).url,1);await a.sync();assert.equal(server.state().document.items.length,1);
 }finally{a.dispose();b.dispose()}
});
test('remote queue edits block an active lease; a fresh explicit play can acquire the new queue',async()=>{
 const server=setup(),a=new ListeningQueueClient(email,server.storage,()=>{},server.fetcher),b=new ListeningQueueClient(email,null,()=>{},server.fetcher);
 try{
  await a.sync();a.add(story(1));a.add(story(2));await a.sync();a.begin('old',story(1).url);await b.sync();b.move(story(2).url,-1);await b.sync();await a.sync();
  a.track('old',story(1).url,2);assert.equal(a.pending,null);assert.equal(a.finish('old',story(1).url),null);
  a.begin('new',story(2).url);a.track('new',story(2).url,1);await a.sync();assert.equal(server.state().document.currentUrl,story(2).url);
 }finally{a.dispose();b.dispose()}
});
test('old-account outbox cannot be sent to a different signed-in account and sign-out erases text',async()=>{
 const server=setup(),a=new ListeningQueueClient(email,server.storage,()=>{},server.fetcher);
 try{await a.sync();server.online(false);a.add(story(1));await a.sync();server.changeAccount();server.online(true);await a.sync();assert.equal(server.state().document,null);assert.ok(a.pending);a.dispose(true);assert.equal(server.storage.getItem(listeningQueueKey(email)),null)}finally{a.dispose()}
});
test('queue validates count, duplicate identities, exact sections, position, images and total text bounds',()=>{
 for(const doc of [{items:[story(1),story(1)],currentUrl:story(1).url},{items:[story(1)],currentUrl:null},{items:[],currentUrl:'bad'},
  {items:[{...story(1),partIndex:3}],currentUrl:story(1).url},{items:Array.from({length:11},(_,i)=>story(i)),currentUrl:story(0).url},
  {items:[{...story(1),imageUrl:'http://localhost/image'}],currentUrl:story(1).url},
  {items:Array.from({length:6},(_,i)=>({...story(i),parts:Array(19).fill('x'.repeat(1000))})),currentUrl:story(0).url}])assert.throws(()=>validateQueue(doc));
});
