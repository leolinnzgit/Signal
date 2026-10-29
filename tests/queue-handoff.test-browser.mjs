import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'queue-transfer-fixture',configureServer(server){server.middlewares.use('/queue-transfer-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/queue-transfer-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/queue-handoff.fixture.tsx"></script></body></html>'))})}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3033,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**','**/public/**']}}});
await server.listen();let browser;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});await mkdir('work/queue-handoff',{recursive:true});
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.queueTransferOnline=false;Object.defineProperty(navigator,'onLine',{get:()=>window.queueTransferOnline});window.queueTransferSpeech=[];window.queueTransferPauses=0;
   window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};window.speechSynthesis.getVoices=()=>[{name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true}];
   Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});window.speechSynthesis.speak=u=>{window.queueTransferUtterance=u;window.queueTransferSpeech.push(u.text);u.onstart?.({})};
   window.speechSynthesis.cancel=()=>{};window.speechSynthesis.resume=()=>{};window.speechSynthesis.pause=()=>window.queueTransferPauses++;
   window.queueTransferMediaPauses=0;const pause=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){window.queueTransferMediaPauses++;return pause.call(this)};
   HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Tap required','NotAllowedError'));
  });
  const stories=['Alpha','Beta','Gamma'].map((title,index)=>({url:`https://example.com/${index}`,title,source:'Publisher',imageUrl:'',parts:[`${title} heading.`,`${title} first.`,`${title} last.`],partIndex:index===2?0:1}));
  const initial=()=>({items:structuredClone(stories),currentUrl:stories[0].url});let revision=1;
  let progress={accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'1'.repeat(32),state:'active',updatedAt:new Date().toISOString(),document:initial()};
  const id='e'.repeat(64),secret='f'.repeat(64);let offer=null,created=null,ready=null,queueConflict=false,legacyServer=false;
  const stream='/api/article-audio-stream/'+ 'c'.repeat(32);
  const wave=Buffer.alloc(44+32000*6);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  function view(){const current=progress.document.items.find(item=>item.url===progress.document.currentUrl)||stories[0];const document=offer?.snapshot?.document;const story=document?.items.find(item=>item.url===document.currentUrl)||current;
   return {id,status:offer.status,target:offer.target,url:story.url,title:story.title,source:story.source,imageUrl:'',partIndex:offer.status==='ready'?story.partIndex:1,partCount:3,expiresAt:new Date(Date.now()+120000).toISOString(),isQueue:true,queueCount:document?.items.length||3,queueVersion:offer.status==='ready'?offer.snapshot.version:null,queue:offer.status==='ready'?document:null,parts:offer.status==='ready'?story.parts:null};}
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
   if(path==='/api/listening-progress')return route.fulfill({json:{...progress,version:'0',state:'empty',document:null}});
   if(path==='/api/listening-queue'){
    if(request.method()==='POST'){const body=request.postDataJSON();if(body.baseVersion!==progress.version)return route.fulfill({status:409,json:progress});progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:body.document};}
    if(queueConflict){queueConflict=false;progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:{items:[progress.document.items[1]],currentUrl:progress.document.items[1].url}};}
    return route.fulfill({json:progress});
   }
   if(path==='/api/listening-handoffs'&&request.method()==='POST'){
    created=request.postDataJSON();assert.equal(created.queueVersion,progress.version);assert.deepEqual(created.parts,stories[0].parts);offer={status:'pending',target:'watch'};
    return route.fulfill({json:{id,sourceToken:secret,expiresAt:new Date(Date.now()+120000).toISOString(),...(legacyServer?{}:{isQueue:true,queueCount:3})}});
   }
   if(path===`/api/listening-handoffs/${id}`)return route.fulfill({json:view()});
   if(path.endsWith('/accept')){assert.equal(request.postDataJSON().supportsQueue,true);offer.status='accepted';return route.fulfill({json:{status:'accepted'}})}
   if(path.endsWith('/ready')){
    const body=request.postDataJSON();ready=body;assert.equal(body.queueVersion,progress.version);assert.equal(body.partIndex,2);assert.ok(await page.evaluate(()=>window.queueTransferPauses+window.queueTransferMediaPauses)>0,'Source pauses before readiness');
    progress={...progress,version:(++revision).toString(16).padStart(32,'0')};offer.status='ready';offer.snapshot=structuredClone(progress);return route.fulfill({json:{status:'ready',queueVersion:progress.version}});
   }
   if(path.endsWith('/cancel')){if(offer?.status!=='ready')offer.status='cancelled';return route.fulfill({json:{status:offer.status}})}
   if(path==='/api/headline-audio/voices')return route.fulfill({json:[],headers:{'X-Signal-Article-Streaming':'true'}});
   if(path==='/api/article-audio-stream')return route.fulfill({json:{url:stream,statusUrl:stream+'/status',status:{starts:[0,3],complete:true,duration:6,error:null}}});
   if(path===stream+'/status')return route.fulfill({json:{starts:[0,3],complete:true,duration:6,error:null}});
   if(path===stream){const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);if(range){const start=Number(range[1]),end=Math.min(wave.length-1,range[2]?Number(range[2]):wave.length-1),body=wave.subarray(start,end+1);return route.fulfill({status:206,body,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${wave.length}`,'Content-Length':String(body.length)}})}return route.fulfill({body:wave,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Length':String(wave.length)}})}
   return route.fulfill({json:[]});
  });
  const base='http://127.0.0.1:3033/queue-transfer-test';
  await page.goto(base);await page.getByRole('button',{name:'Listening library',exact:true}).click();await page.getByRole('button',{name:'Play Alpha',exact:true}).click();
  await page.waitForFunction(()=>window.queueTransferSpeech.some(text=>text.includes('Alpha first')));await page.evaluate(()=>window.queueTransferOnline=true);
  const pauses=await page.evaluate(()=>window.queueTransferPauses);await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
  for(let n=0;!created&&n<100;n++)await wait(50);assert.ok(created);assert.equal(await page.evaluate(()=>window.queueTransferPauses),pauses,'Offering a queue does not pause the source');
  await page.getByRole('button',{name:'Next section',exact:true}).click();await page.waitForFunction(()=>window.queueTransferSpeech.some(text=>text.includes('Alpha last')));
  offer.status='accepted';for(let n=0;!ready&&n<150;n++)await wait(50);assert.ok(ready);
  await page.getByRole('dialog',{name:'Listen later player',exact:true}).waitFor({state:'detached'});
  assert.equal(offer.snapshot.document.items.length,3);assert.equal(offer.snapshot.document.items[0].partIndex,2);assert.equal(offer.snapshot.document.items[1].partIndex,1);
  const sourceCache=await page.evaluate(()=>JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')));assert.equal(sourceCache.progress.version,offer.snapshot.version);assert.equal(sourceCache.pending,null);
  // Receive a watch queue: arrival and acceptance alone must never start speech.
  offer={status:'pending',target:'phone'};progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:initial()};
  await page.goto(base+'?receive='+id);assert.equal(await page.evaluate(()=>window.queueTransferSpeech.length),0);
  await page.getByRole('button',{name:'Continue on phone',exact:true}).click();await wait(700);assert.equal(await page.evaluate(()=>window.queueTransferSpeech.length),0);
  progress.document.items[0].partIndex=2;progress={...progress,version:(++revision).toString(16).padStart(32,'0')};offer.status='ready';offer.snapshot=structuredClone(progress);
  await page.waitForFunction(()=>window.queueTransferSpeech.some(text=>text.includes('Alpha last')));assert.equal(await page.evaluate(()=>window.queueTransferSpeech.some(text=>text.includes('Alpha heading')||text.includes('Alpha first'))),false);
  await page.evaluate(()=>window.queueTransferUtterance.onend?.({}));await page.getByRole('dialog',{name:'Listen later player',exact:true}).getByRole('heading',{name:'Beta',exact:true}).waitFor();
  await page.waitForFunction(()=>window.queueTransferSpeech.some(text=>text.includes('Beta first')));for(let n=0;progress.document.items.some(item=>item.title==='Alpha')&&n<80;n++)await wait(50);assert.equal(progress.document.items.some(item=>item.title==='Alpha'),false);
  await page.screenshot({path:`work/queue-handoff/received-queue-${width}.png`});
  await page.getByRole('button',{name:'Close Listen later player',exact:true}).click();await page.waitForURL(base);
  // A concurrent edit after watch confirmation must stop queue import and all new audio.
  progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:initial()};offer={status:'pending',target:'phone'};
  await page.goto(base+'?receive='+id);await page.getByRole('button',{name:'Continue on phone',exact:true}).click();await wait(500);
  offer.status='ready';offer.snapshot=structuredClone(progress);queueConflict=true;
  await page.getByRole('alert').filter({hasText:'changed or could not be verified'}).waitFor();assert.equal(await page.evaluate(()=>window.queueTransferSpeech.length),0);
  // An older server must not silently downgrade a queue handoff to one story.
  legacyServer=true;created=null;ready=null;progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:initial()};
  await page.goto(base);await page.getByRole('button',{name:'Listening library',exact:true}).click();await page.getByRole('button',{name:'Play Alpha',exact:true}).click();
  await page.waitForFunction(()=>window.queueTransferSpeech.length>0);await page.evaluate(()=>window.queueTransferOnline=true);
  const oldServerPauses=await page.evaluate(()=>window.queueTransferPauses);await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Update your Signal server'}).waitFor();assert.equal(await page.evaluate(()=>window.queueTransferPauses),oldServerPauses);assert.equal(ready,null);
  // Recorded audio confirms the actual seek position, even when the last reading callback is older.
  legacyServer=false;created=null;ready=null;progress={...progress,version:(++revision).toString(16).padStart(32,'0'),document:initial()};
  await page.goto(base);await page.getByRole('button',{name:'Listening library',exact:true}).click();await page.evaluate(()=>window.queueTransferOnline=true);await page.getByRole('button',{name:'Play Alpha',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('audio')?.readyState===4);
  await page.locator('audio').evaluate(audio=>{Object.defineProperty(audio,'paused',{configurable:true,get:()=>false});audio.dispatchEvent(new Event('play'))});
  await wait(100);const mediaPauses=await page.evaluate(()=>window.queueTransferMediaPauses);await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
  for(let n=0;!created&&n<100;n++)await wait(50);assert.ok(created);assert.equal(await page.evaluate(()=>window.queueTransferMediaPauses),mediaPauses);
  await page.locator('audio').evaluate(audio=>{audio.addEventListener('timeupdate',event=>event.stopImmediatePropagation(),true);audio.addEventListener('seeking',event=>event.stopImmediatePropagation(),true);audio.currentTime=3.5});
  offer.status='accepted';for(let n=0;!ready&&n<150;n++)await wait(50);assert.ok(ready);assert.equal(ready.partIndex,2);
  await page.getByRole('dialog',{name:'Listen later player',exact:true}).waitFor({state:'detached'});assert.equal(offer.snapshot.document.items.length,3);
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: browser/recorded queue handoff, acceptance before pause, actual latest section/revision, receiver consent, exact offsets/order, next story, concurrent-edit and old-server rejection`);
 }
}finally{await browser?.close();await server.close()}
