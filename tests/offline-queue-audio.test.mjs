import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const compile=async file=>ts.transpileModule(await readFile(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const {QueueAudioDownloads}=await import(url((await compile('offline-queue-audio.ts')).replace('"./headline-audio"',JSON.stringify(url(await compile('headline-audio.ts'))))));
function wave(parts){const header=new ArrayBuffer(44),v=new DataView(header),n=parts.length*32000;const tag=(i,s)=>[...s].forEach((c,j)=>v.setUint8(i+j,c.charCodeAt(0)));tag(0,'RIFF');tag(8,'WAVEfmt ');tag(36,'data');v.setUint32(4,n+36,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,n,true);return{blob:new Blob([header,new Uint8Array(n)]),starts:parts.map((_,i)=>i)}}
const story=n=>({url:`https://example.com/${n}`,title:`Story ${n}`,source:'Publisher',imageUrl:'',parts:['Heading','First','Last'],partIndex:1});
const voices={en:'SelectedVoice',zh:''};
function storage(){const data=new Map();return{data,list:async account=>[...data.values()].filter(x=>x.account===account),put:async x=>{data.set(x.key,structuredClone(x))},remove:async key=>{data.delete(key)}}}
const prepare=async parts=>wave(parts);
test('durable audio reload crops original PCM to exact saved sections and never borrows another account',async()=>{
 const store=storage(),a=new QueueAudioDownloads('A@example.com',store,undefined,prepare);await a.download([story(1)],voices,'en');
 const reload=new QueueAudioDownloads('a@example.com',store,undefined,prepare),audio=await reload.recording(story(1));assert.deepEqual(audio.starts,[0,1]);assert.equal(audio.blob.size,64044);assert.equal(new DataView(await audio.blob.slice(0,44).arrayBuffer()).getUint32(40,true),64000);
 assert.equal(await new QueueAudioDownloads('b@example.com',store,undefined,prepare).recording(story(1)),undefined);
 assert.equal(await reload.recording({...story(1),parts:['Changed','First','Last']}),undefined);
 assert.deepEqual((await reload.recording({...story(1),partIndex:2})).starts,[0]);
});
test('cancel keeps completed stories; late responses cannot publish incomplete downloads; retry skips saved voice',async()=>{
 const store=storage();let release,count=0;const a=new QueueAudioDownloads('a',store,undefined,async parts=>{count++;if(count===2)await new Promise(r=>release=r);return wave(parts)});
 const pending=a.download([story(1),story(2)],voices,'en');while(!release)await new Promise(r=>setTimeout(r,1));a.cancel();release();await pending;assert.equal(store.data.size,1);assert.equal(a.saved(story(2)),undefined);
 await a.download([story(1),story(2)],voices,'en');assert.equal(count,3);assert.equal(store.data.size,2);
 await a.download([story(1)],{...voices,en:'NewVoice'},'en');assert.equal(count,4);
});
test('finished audio cleanup is optional and does not change saved queue text or positions',async()=>{
 const a=new QueueAudioDownloads('a',storage(),undefined,prepare),stories=[story(1),story(2)],copy=structuredClone(stories);await a.download(stories,voices,'en');a.autoRemove=false;await a.retain([story(2)]);assert.equal(a.records.length,2);a.autoRemove=true;await a.retain([story(2)]);assert.equal(a.records.length,1);assert.equal(a.records[0].url,story(2).url);assert.deepEqual(stories,copy);
});
test('storage quota failure preserves completed audio, account verification fails before synthesis',async()=>{
 const store=storage(),a=new QueueAudioDownloads('a',store,undefined,prepare);await a.download([story(1)],voices,'en');store.put=async()=>{throw new Error('Storage is full')};await a.download([story(2)],voices,'en');assert.equal(a.records.length,1);assert.match(a.message,/full/);
 let called=false;const b=new QueueAudioDownloads('a',store,undefined,async()=>{called=true;return wave(['x'])},async()=>{throw new Error('Account changed')});await b.download([story(2)],voices,'en');assert.equal(called,false);assert.match(b.message,/Account changed/);
});
test('sign-out aborts downloads, removes own media and preserves another account',async()=>{
 const store=storage(),other=new QueueAudioDownloads('b',store,undefined,prepare);await other.download([story(2)],voices,'en');let release;const a=new QueueAudioDownloads('a',store,undefined,async parts=>{await new Promise(r=>release=r);return wave(parts)});const pending=a.download([story(1)],voices,'en');while(!release)await new Promise(r=>setTimeout(r,1));a.dispose(true);release();await pending;await new Promise(r=>setTimeout(r,0));assert.equal((await store.list('a')).length,0);assert.equal((await store.list('b')).length,1);
});
test('queue edits during synthesis cannot save outdated audio, malformed offsets cannot be played',async()=>{
 const store=storage();let release;const a=new QueueAudioDownloads('a',store,undefined,async parts=>{await new Promise(r=>release=r);return wave(parts)});await a.retain([story(1)]);const pending=a.download([story(1)],voices,'en');while(!release)await new Promise(r=>setTimeout(r,1));await a.retain([{...story(1),parts:['New text']}]);release();await pending;assert.equal(store.data.size,0);assert.match(a.message,/changed/);
 await store.put({...wave(story(1).parts),starts:[0,NaN,1],account:'a',key:'bad',url:story(1).url,parts:story(1).parts,voices});assert.equal(await a.recording(story(1)),undefined);
});
test('account verification can be cancelled before synthesis starts',async()=>{
 let release,called=false;const a=new QueueAudioDownloads('a',storage(),undefined,async()=>{called=true;return wave(['x'])},async()=>{await new Promise(r=>release=r)});
 const pending=a.download([story(1)],voices,'en');assert.equal(a.busy,true);a.cancel();assert.equal(a.busy,false);release();await pending;assert.equal(called,false);
});
