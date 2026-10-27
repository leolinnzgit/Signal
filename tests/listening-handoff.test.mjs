import assert from 'node:assert/strict';
import test from 'node:test';
import { incomingWatchHandoff, validateListeningHandoff, handoffNarrationSections, readListeningHandoff, changeListeningHandoff, pendingWatchHandoff, clearPendingWatchHandoff } from '../app/listening-handoff.ts';

const id='a'.repeat(64), key='b'.repeat(64);
const metadata={id,status:'pending',url:'https://example.com/story',title:'A transferred story',source:'Publisher',partIndex:1,partCount:3,expiresAt:'2026-10-27T03:00:00Z',parts:null};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('only a single opaque transfer ID is accepted from a phone link',()=>{
  assert.equal(incomingWatchHandoff(`?watchHandoff=${id}`),id);
  for(const query of ['?watchHandoff=../secret',`?watchHandoff=${id}%0A`,`?watchHandoff=${id}&watchHandoff=${id}`,'?article=https://example.com']) assert.equal(incomingWatchHandoff(query),null);
});
test('only confirmed exact sections are playable, with their original indices',()=>{
  assert.throws(()=>handoffNarrationSections(metadata),/confirm/);
  const value=validateListeningHandoff({...metadata,status:'ready',partIndex:2,parts:['Heading','Earlier section','Latest section']},id);
  assert.deepEqual(handoffNarrationSections(value),[{text:'Latest section',paragraphIndex:2,start:0,end:14}]);
  assert.throws(()=>validateListeningHandoff({...metadata,parts:['Too early']},id));
  assert.throws(()=>validateListeningHandoff({...metadata,status:'ready',parts:['Missing section']},id));
  assert.throws(()=>validateListeningHandoff({...metadata,url:'javascript:alert(1)'},id));
  assert.throws(()=>validateListeningHandoff({...metadata,partIndex:3},id));
  assert.throws(()=>validateListeningHandoff({...metadata,status:'ready',parts:['a'.repeat(1001),'b','c']},id));
});
test('reads carry the receiver proof without placing it in the URL',async()=>{
  const requests=[];
  await readListeningHandoff(id,key,new AbortController().signal,async(url,options)=>{requests.push({url,options});return reply(metadata)});
  assert.equal(requests[0].url,`/api/listening-handoffs/${id}`);
  assert.equal(requests[0].options.headers['X-Signal-Handoff-Receiver'],key);
  assert.equal(requests[0].options.cache,'no-store');
  assert.equal(requests[0].options.credentials,'same-origin');
});
test('acceptance and cancellation require CSRF and preserve an idempotent receiver key',async()=>{
  const requests=[];
  const fetcher=async(url,options)=>{requests.push({url,options});return reply(url==='/api/auth/csrf'?{token:'csrf'}:{status:'accepted'})};
  await changeListeningHandoff(id,'accept',key,new AbortController().signal,fetcher);
  assert.equal(requests[1].options.method,'POST');
  assert.equal(requests[1].options.headers['X-XSRF-TOKEN'],'csrf');
  assert.deepEqual(JSON.parse(requests[1].options.body),{receiverToken:key});
  await assert.rejects(changeListeningHandoff(id,'accept',key,new AbortController().signal,async()=>reply({})),/Sign in/);
});
test('expired and unauthenticated reads never provide playable text',async()=>{
  await assert.rejects(readListeningHandoff(id,key,new AbortController().signal,async()=>reply({},401)),/same Signal account/);
  await assert.rejects(readListeningHandoff(id,key,new AbortController().signal,async()=>reply({error:'Expired'},404)),/Expired/);
  const abort=new AbortController();abort.abort();let sent=false;
  await assert.rejects(readListeningHandoff(id,key,abort.signal,async()=>{sent=true;return reply(metadata)}),{name:'AbortError'});
  assert.equal(sent,false);
});
test('an opaque pending ID survives a sign-in round trip without storing article text',()=>{
  const saved=new Map();
  globalThis.sessionStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  try{
    assert.equal(pendingWatchHandoff(`?watchHandoff=${id}`),id);
    assert.equal(pendingWatchHandoff('?auth=google-signed-in'),id);
    assert.equal([...saved.values()].join('').includes('Latest section'),false);
    clearPendingWatchHandoff(id);assert.equal(pendingWatchHandoff(''),null);
    saved.set('signal.pending-watch-transfer',JSON.stringify({id,until:1}));assert.equal(pendingWatchHandoff(''),null);
  }finally{delete globalThis.sessionStorage}
});
