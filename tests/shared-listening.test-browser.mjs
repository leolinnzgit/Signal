import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'shared-fixture',configureServer(server){server.middlewares.use('/shared-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/shared-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/shared-listening.fixture.tsx"></script></body></html>'))})}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3030,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**']}}});
await server.listen();let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 for(const width of [390,1280]){
  let revision=1,last=null,offlineA=false;const parts=['Heading.','Exact saved section.','Final saved section.'],jobs=[],errors=[],traffic=[];
  let state={accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'1'.repeat(32),state:'active',updatedAt:new Date().toISOString(),document:{url:'https://example.com/story',title:'Story',source:'Publisher',imageUrl:'',parts,partIndex:1}};
  const wave=Buffer.alloc(44+32000*9);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  const contexts=[];
  async function device(isA){const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{window.sharedPlays=0;HTMLMediaElement.prototype.play=()=>{window.sharedPlays++;return Promise.reject(new DOMException('Tap required','NotAllowedError'))}});
   await page.route('**/api/**',async route=>{if(isA&&offlineA)return route.abort('internetdisconnected');const request=route.request(),path=new URL(request.url()).pathname;traffic.push([path,request.method()]);
    if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
    if(path==='/api/listening-progress'){
     if(request.method()==='POST'){assert.equal(request.headers()['x-xsrf-token'],'csrf');const body=request.postDataJSON();assert.equal(body.accountKey,state.accountKey);
      if(last?.operationId===body.operationId)return route.fulfill({json:state});
      if(body.baseVersion!==state.version)return route.fulfill({status:409,json:state});last=body;state={...state,version:(++revision).toString(16).padStart(32,'0'),state:body.action==='save'?'active':body.action==='complete'?'completed':'forgotten',document:body.document};}
     return route.fulfill({json:state});
    }
    if(path==='/api/headline-audio/voices')return route.fulfill({json:[],headers:{'X-Signal-Article-Streaming':'true'}});
    const stream='/api/article-audio-stream/'+ 'c'.repeat(32);
    if(path==='/api/article-audio-stream'){const body=request.postDataJSON();jobs.push(body.titles);return route.fulfill({json:{url:stream,statusUrl:stream+'/status',status:{starts:body.titles.map((_,index)=>index*3),complete:true,duration:9,error:null}}})}
    if(path===stream){const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);if(range){const start=Number(range[1]),end=Math.min(wave.length-1,range[2]?Number(range[2]):wave.length-1),body=wave.subarray(start,end+1);return route.fulfill({status:206,body,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${wave.length}`,'Content-Length':String(body.length)}})}return route.fulfill({body:wave,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Length':String(wave.length)}})}
    return route.fulfill({json:{}});
   });return page;
  }
  const a=await device(true),b=await device(false);
  await a.goto('http://127.0.0.1:3030/shared-test');await a.getByRole('button',{name:'Resume saved story',exact:true}).waitFor().catch(async error=>{console.log('Resume diagnostics:',await a.locator('body').innerText(),errors,traffic,await a.evaluate(()=>Object.entries(localStorage)));throw error});assert.equal(await a.locator('audio').count(),0);
  await a.getByRole('button',{name:'Resume saved story',exact:true}).click();await a.waitForFunction(()=>document.querySelector('audio')?.readyState===4);
  assert.deepEqual(jobs[0],parts.slice(1));await a.locator('audio').evaluate(audio=>audio.dispatchEvent(new Event('play')));
  await new Promise(resolve=>setTimeout(resolve,3500));assert.equal(state.document.partIndex,1);assert.deepEqual(state.document.parts,parts);
  offlineA=true;await a.locator('audio').evaluate(audio=>{audio.currentTime=3.5;audio.dispatchEvent(new Event('timeupdate'))});
  await a.waitForFunction(()=>{const raw=localStorage.getItem('signal.shared-listening.v1.owner%40example.com');return raw&&JSON.parse(raw).pending?.document?.partIndex===2});
  await b.goto('http://127.0.0.1:3030/shared-test');await b.getByRole('button',{name:'Forget saved position',exact:true}).click();
  for(let n=0;state.state!=='forgotten'&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(state.state,'forgotten');
  offlineA=false;await a.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await a.waitForFunction(()=>{const value=JSON.parse(localStorage.getItem('signal.shared-listening.v1.owner%40example.com')||'null');return value?.progress?.state==='forgotten'&&!value.pending});
  assert.equal(state.state,'forgotten');await a.getByRole('button',{name:'Close saved story',exact:true}).click();assert.equal(await a.getByRole('button',{name:'Resume saved story',exact:true}).count(),0);
  await b.getByRole('button',{name:'Start a story',exact:true}).click();await b.waitForFunction(()=>document.querySelector('audio')?.readyState>0);
  await b.locator('audio').evaluate(audio=>audio.dispatchEvent(new Event('play')));await new Promise(resolve=>setTimeout(resolve,3500));
  await b.locator('audio').evaluate(audio=>audio.dispatchEvent(new Event('ended')));
  for(let n=0;state.state!=='completed'&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(state.state,'completed');assert.equal(state.document,null);
  await b.getByRole('button',{name:'Sign out',exact:true}).click();assert.equal(await b.evaluate(()=>localStorage.getItem('signal.shared-listening.v1.owner%40example.com')),null);
  await mkdir('work/shared-progress',{recursive:true});await a.screenshot({path:`work/shared-progress/shared-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);
  for(const context of contexts)await context.close();console.log(`PASS ${width}px: explicit exact-section resume, no autoplay on arrival, offline outbox, remote forget, stale replay rejection, completion and sign-out`);
 }
}finally{await browser?.close();await server.close()}
