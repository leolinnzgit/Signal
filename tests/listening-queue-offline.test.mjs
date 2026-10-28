import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../public/service-worker.js',import.meta.url),'utf8');
function runtime(shell='<div id="root"></div><script src="/assets/index-test.js"></script><link href="/assets/index-test.css">'){
 const listeners={},disk=new Map();let offline=false;
 const key=value=>new URL(typeof value==='string'?value:value.url,'https://signal.example').href;
 const fetcher=async value=>{if(offline)throw Error('offline');const url=key(value);return new Response(new URL(url).pathname==='/'?shell:'static asset',{headers:{'Content-Type':new URL(url).pathname==='/'?'text/html':'text/javascript'}})};
 const cache={addAll:async values=>{for(const value of values)disk.set(key(value),await fetcher(value))},match:async value=>disk.get(key(value))?.clone(),put:async(value,response)=>disk.set(key(value),response.clone())};
 vm.runInNewContext(script,{self:{location:{origin:'https://signal.example'},addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting:()=>{},clients:{claim:()=>{}}},caches:{open:async()=>cache,match:cache.match,keys:async()=>[],delete:async()=>true},fetch:fetcher,URL,Response,Set,console});
 return {disk,offline:value=>offline=value,install:async()=>{let job;listeners.install({waitUntil:value=>job=value});await job},request:async(path,mode='navigate')=>{let result;listeners.fetch({request:{url:'https://signal.example'+path,mode,method:'GET'},respondWith:value=>result=value});return result}};
}
test('offline install caches only the public IIS shell and its assets; APIs remain network-only',async()=>{
 const app=runtime();await app.install();assert.ok(app.disk.has('https://signal.example/'));assert.ok(app.disk.has('https://signal.example/assets/index-test.js'));assert.ok(app.disk.has('https://signal.example/assets/index-test.css'));
 app.offline(true);assert.match(await(await app.request('/')).text(),/id="root"/);assert.equal(await app.request('/api/listening-queue','cors'),undefined);assert.equal(await app.request('/api/auth/me','cors'),undefined);
 assert.equal([...app.disk.keys()].some(key=>key.includes('/api/')),false);
});
test('account-rendered HTML is not accepted as the public offline shell',async()=>{
 const app=runtime('<html>Private account content</html>');await app.install();assert.equal(app.disk.has('https://signal.example/'),false);app.offline(true);assert.equal((await app.request('/')).status,503);
});
