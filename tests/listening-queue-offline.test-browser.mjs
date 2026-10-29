import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const root=resolve('Signal.Server/wwwroot');let authentication=503;const requests=[];
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname.startsWith('/api/')){requests.push(pathname);res.setHeader('Content-Type','application/json');if(pathname==='/api/auth/me'){res.statusCode=authentication;res.end('{}')}else if(pathname==='/api/auth/providers')res.end('{"google":false}');else{res.statusCode=503;res.end('{}')}return}
 const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root)){res.statusCode=403;res.end();return}
 try{const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(30000);
 await page.addInitScript(()=>{
  if(!localStorage.getItem('queue-test-initialized')){
   const story={url:'https://example.com/offline',title:'Offline story',source:'Publisher',imageUrl:'',parts:['Heading','Exact saved section.','Last offline section.'],partIndex:1};
   localStorage.setItem('signal.listening-queue.v1.owner%40example.com',JSON.stringify({progress:{accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'1'.repeat(32),state:'active',updatedAt:new Date().toISOString(),document:{items:[story],currentUrl:story.url}},pending:null}));localStorage.setItem('queue-test-initialized','yes');
  }
  window.offlineSpeech=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
  window.speechSynthesis.getVoices=()=>[{name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true}];Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});
  window.speechSynthesis.speak=u=>{window.offlineSpeech.push(u.text);u.onstart?.({})};window.speechSynthesis.cancel=()=>{};window.speechSynthesis.resume=()=>{};window.speechSynthesis.pause=()=>{};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`,{timeout:90000});await page.getByRole('heading',{name:'Offline Listen later',exact:true}).waitFor();
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;await new Promise(resolve=>{if(navigator.serviceWorker.controller)resolve();else navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true})})});
 await page.waitForFunction(async()=>!!await caches.match('/'));
 await context.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Offline Listen later',exact:true}).waitFor();assert.match(await page.locator('.listen-later').innerText(),/Section 2\/3/);assert.equal(await page.evaluate(()=>window.offlineSpeech.length),0);
 await page.getByRole('button',{name:'Play Offline story',exact:true}).click();await page.waitForFunction(()=>window.offlineSpeech.some(text=>text.includes('Exact saved section.')));
 assert.equal(await page.evaluate(()=>window.offlineSpeech.some(text=>text.includes('Heading'))),false);
 await page.getByRole('button',{name:'Next section',exact:true}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')).pending?.document.items[0].partIndex===2);
 await page.getByRole('button',{name:'Close Listen later player'}).click();await page.reload();assert.match(await page.locator('.listen-later').innerText(),/Section 3\/3/);
 await mkdir('work/listening-queue',{recursive:true});await page.screenshot({path:'work/listening-queue/offline-phone.png',fullPage:true});
 // Install a completed recording locally, then reopen with the whole network offline.
 await page.evaluate(async()=>{
  const queue=JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com'));
  const story=(queue.pending?.document??queue.progress.document).items[0];
  const header=new ArrayBuffer(44),v=new DataView(header),n=96000;
  const tag=(i,s)=>[...s].forEach((c,j)=>v.setUint8(i+j,c.charCodeAt(0)));
  tag(0,'RIFF');tag(8,'WAVEfmt ');tag(36,'data');v.setUint32(4,n+36,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,n,true);
  const db=await new Promise(resolve=>{const request=indexedDB.open('signal-queue-audio-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('audio',{keyPath:'key'});request.onsuccess=()=>resolve(request.result)});
  await new Promise((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').put({key:JSON.stringify(['owner@example.com',story.url]),account:'owner@example.com',url:story.url,parts:story.parts,voices:{en:'saved',zh:''},blob:new Blob([header,new Uint8Array(n)],{type:'audio/wav'}),starts:[0,1,2]});tx.oncomplete=resolve;tx.onerror=reject});db.close();
 });
 await page.reload();await page.getByRole('button',{name:'Remove downloaded audio: Offline story',exact:true}).waitFor();
 await page.getByRole('button',{name:'Play Listen later',exact:true}).click();await page.getByText('Downloaded audio · saved recorded voice',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('audio')?.duration===1);
 assert.equal(await page.evaluate(()=>window.offlineSpeech.length),0,'Downloaded PCM plays without falling back to a device voice');
 await page.getByRole('button',{name:'Close Listen later player',exact:true}).click();
 await page.getByRole('button',{name:'Remove offline copy from this device'}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('signal.listening-queue.v1.owner%40example.com')),null);
 await page.waitForFunction(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('signal-queue-audio-v1',1);r.onsuccess=()=>resolve(r.result)});return new Promise(resolve=>{const r=db.transaction('audio').objectStore('audio').count();r.onsuccess=()=>{db.close();resolve(r.result===0)}})});
 authentication=401;await context.setOffline(false);await page.getByRole('button',{name:'Reconnect to Signal'}).click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Offline Listen later',exact:true}).count(),0);
 assert.equal(requests.some(path=>path==='/api/listening-queue'),false);assert.deepEqual(errors,[]);console.log('PASS built IIS client: cached public shell, genuine network-offline reopen, exact device-voice and downloaded PCM resume, local outbox, offline copy/media removal, and 401 remains sign-in');
 await context.close();
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
