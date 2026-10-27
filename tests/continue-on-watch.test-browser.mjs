import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'watch-transfer-fixture',configureServer(server){
  server.middlewares.use('/watch-transfer-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/watch-transfer-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/continue-on-watch.fixture.tsx"></script></body></html>'))})
}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3029,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**']}}});
await server.listen();let browser;
try {
  browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const width of [390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultNavigationTimeout(90_000);page.setDefaultTimeout(30_000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.transferPauses=0;const original=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){window.transferPauses++;original.call(this)};HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Tap required','NotAllowedError'))});
    await page.addInitScript(()=>{
      window.transferSpeech=[];window.transferSpeechPauses=0;
      window.SpeechSynthesisUtterance=class {constructor(text){this.text=text}};
      window.speechSynthesis.getVoices=()=>[{name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true}];
      Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});
      window.speechSynthesis.speak=utterance=>{window.transferSpeech.push(utterance.text);utterance.onstart?.({})};
      window.speechSynthesis.cancel=()=>{};window.speechSynthesis.resume=()=>{};
      window.speechSynthesis.pause=()=>window.transferSpeechPauses++;
    });
    const id='a'.repeat(64),secret='b'.repeat(64),stream=`/api/article-audio-stream/${'c'.repeat(32)}`;
    let phase='pending',created=null,ready=null,completeReady,readyGate,cancels=0;
    const wave=Buffer.alloc(44+32000*9);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
      if(path==='/api/listening-handoffs'){created=route.request().postDataJSON();assert.equal(route.request().headers()['x-xsrf-token'],'csrf');return route.fulfill({json:{id,sourceToken:secret,expiresAt:new Date(Date.now()+300000).toISOString()}})}
      if(path===`/api/listening-handoffs/${id}`)return route.fulfill({json:{...created,id,target:'watch',partCount:3,expiresAt:new Date(Date.now()+300000).toISOString(),status:phase,parts:null}});
      if(path===`/api/listening-handoffs/${id}/ready`){ready=route.request().postDataJSON();await readyGate;phase='ready';return route.fulfill({json:{status:'ready'}})}
      if(path===`/api/listening-handoffs/${id}/cancel`){cancels++;return route.fulfill({json:{status:'cancelled'}})}
      if(path==='/api/headline-audio/voices')return route.fulfill({json:[],headers:{'X-Signal-Article-Streaming':'true'}});
      if(path==='/api/article-audio-stream')return route.fulfill({json:{url:stream,statusUrl:`${stream}/status`,status:{starts:[0,3,6],complete:true,duration:9,error:null}}});
      if(path===`${stream}/status`)return route.fulfill({json:{starts:[0,3,6],complete:true,duration:9,error:null}});
      if(path===stream){
        const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        if(range){const start=Number(range[1]),end=Math.min(wave.length-1,range[2]?Number(range[2]):wave.length-1),body=wave.subarray(start,end+1);return route.fulfill({status:206,body,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${wave.length}`,'Content-Length':String(body.length)}})}
        return route.fulfill({body:wave,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Length':String(wave.length)}});
      }
      return route.fulfill({json:{}});
    });
    await page.goto('http://127.0.0.1:3029/watch-transfer-test');
    await page.waitForFunction(()=>document.querySelector('audio')?.readyState>0);
    const baseline=await page.evaluate(()=>window.transferPauses);
    readyGate=new Promise(resolve=>completeReady=resolve);
    await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
    await page.getByText('Open SignalWatch and tap Continue from phone.',{exact:false}).waitFor();
    assert.deepEqual(created.parts,['Heading.','First exact section.','Later exact section.']);assert.equal(created.target,'watch');assert.equal(created.imageUrl,'https://images.example.com/story.jpg');
    assert.equal(await page.evaluate(()=>window.transferPauses),baseline,'Creating a transfer must not pause the phone before watch acceptance');
    await page.waitForFunction(()=>document.querySelector('audio')?.readyState===4);
    await page.locator('audio').evaluate(audio=>audio.currentTime=6.5);
    await page.waitForFunction(()=>document.querySelector('audio')?.currentTime>6);
    phase='accepted';
    await page.waitForFunction(()=>document.querySelector('.article-audio-player > div[inert]')!==null);
    assert.equal(await page.getByRole('button',{name:'Browser voice',exact:true}).isDisabled(),true);
    for(let attempt=0;!ready && attempt<1000;attempt++)await new Promise(resolve=>setTimeout(resolve,25));assert.ok(ready);
    assert.equal(ready.partIndex,2);assert.equal(ready.sourceToken,secret);
    assert.ok(await page.evaluate(()=>window.transferPauses)>baseline);
    completeReady();await page.getByText('Ready on your watch. Phone playback is paused.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Browser voice',exact:true}).isDisabled(),false);
    phase='pending';ready=null;created=null;
    await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
    await page.getByText('Open SignalWatch and tap Continue from phone.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Cancel watch transfer',exact:true}).click();
    await page.getByText('Transfer cancelled. Use Play to continue here.',{exact:true}).waitFor();
    await new Promise(resolve=>setTimeout(resolve,300));assert.ok(cancels>0);assert.equal(ready,null);
    await mkdir('work/reverse-images',{recursive:true});await page.screenshot({path:`work/reverse-images/phone-${width}.png`,fullPage:true});
    // An unusable optional image must not prevent the story itself transferring.
    created=null;
    await page.goto('http://127.0.0.1:3029/watch-transfer-test?image='+encodeURIComponent('https://images.example.com/'+ 'x'.repeat(2100)));
    await page.waitForFunction(()=>document.querySelector('audio')?.readyState>0);
    await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
    await page.getByText('Open SignalWatch and tap Continue from phone.',{exact:false}).waitFor();
    assert.equal(created.imageUrl,'');assert.deepEqual(created.parts,['Heading.','First exact section.','Later exact section.']);
    await page.getByRole('button',{name:'Cancel watch transfer',exact:true}).click();
    // Browser speech also transfers its latest actual section after explicit acceptance.
    phase='pending';ready=null;created=null;readyGate=new Promise(resolve=>completeReady=resolve);
    await page.goto('http://127.0.0.1:3029/watch-transfer-test?mode=browser');
    await page.waitForFunction(()=>window.transferSpeech.length>0);
    const speechPauses=await page.evaluate(()=>window.transferSpeechPauses);
    await page.getByRole('button',{name:'Continue on watch',exact:true}).click();
    await page.getByText('Open SignalWatch and tap Continue from phone.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.transferSpeechPauses),speechPauses);
    await page.getByRole('button',{name:'Next section',exact:true}).click();
    await page.getByRole('button',{name:'Next section',exact:true}).click();phase='accepted';
    for(let attempt=0;!ready && attempt<1000;attempt++)await new Promise(resolve=>setTimeout(resolve,25));assert.ok(ready);
    assert.equal(ready.partIndex,2);assert.ok(await page.evaluate(()=>window.transferSpeechPauses)>speechPauses);
    completeReady();await page.getByText('Ready on your watch. Phone playback is paused.',{exact:true}).waitFor();
    assert.equal(await page.locator('audio').count(),0);
    assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: phone-to-watch exact sections, acceptance before pause, latest section confirmation, locked controls and cancellation`);
  }
} finally {await browser?.close();await server.close()}
