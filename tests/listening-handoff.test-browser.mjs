import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'handoff-fixture',configureServer(server){
  server.middlewares.use('/handoff-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/handoff-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/listening-handoff.fixture.tsx"></script></body></html>'))})
}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3028,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**']}}});
await server.listen();let browser;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390,userAgent:width===390?'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36':undefined});
    page.setDefaultNavigationTimeout(90_000);page.setDefaultTimeout(60_000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.handoffPlayAttempts=0;window.handoffSpeech=[];
      window.SpeechSynthesisUtterance=class {constructor(text){this.text=text}};
      HTMLMediaElement.prototype.play=function(){window.handoffPlayAttempts++;return Promise.reject(new DOMException('Tap required','NotAllowedError'))};
      const voice={name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true};
      window.speechSynthesis.getVoices=()=>[voice];
      window.speechSynthesis.speak=utterance=>{window.handoffSpeech.push(utterance.text);utterance.onstart?.({})};
      window.speechSynthesis.cancel=()=>{};window.speechSynthesis.pause=()=>{};window.speechSynthesis.resume=()=>{};
    });
    let phase='pending',confirmed=false,accepts=0,cancels=0,forceCancelled=false;const jobs=[];const id='a'.repeat(64), stream=`/api/article-audio-stream/${'c'.repeat(32)}`;
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
      if(path===`/api/listening-handoffs/${id}/accept`){accepts++;assert.equal(route.request().headers()['x-xsrf-token'],'csrf');assert.match(route.request().postDataJSON().receiverToken,/^[a-f0-9]{64}$/);phase='accepted';return route.fulfill({json:{status:phase}})}
      if(path===`/api/listening-handoffs/${id}/cancel`){cancels++;phase='cancelled';return route.fulfill({json:{status:phase}})}
      if(path===`/api/listening-handoffs/${id}`)return route.fulfill({json:{id,status:forceCancelled?'cancelled':confirmed?'ready':phase,url:'https://example.com/story',title:'A story continued from your watch',source:'Publisher',partIndex:confirmed?2:1,partCount:4,expiresAt:new Date(Date.now()+300000).toISOString(),parts:confirmed?['Heading','Already heard','Exact current section from the watch.','Final section.']:null}});
      if(path==='/api/headline-audio/voices')return route.fulfill({json:[],headers:{'X-Signal-Article-Streaming':'true'}});
      if(path==='/api/article-audio-stream'){jobs.push(route.request().postDataJSON());return route.fulfill({json:{url:stream,statusUrl:`${stream}/status`,status:{starts:[0,3],complete:true,duration:6,error:null}}})}
      if(path===`${stream}/status`)return route.fulfill({json:{starts:[0,3],complete:true,duration:6,error:null}});
      if(path===stream){const wave=Buffer.alloc(44+32000*6);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);return route.fulfill({body:wave,contentType:'audio/wav'})}
      return route.fulfill({json:{}});
    });
    await page.goto('http://127.0.0.1:3028/handoff-test');
    await page.getByRole('button',{name:'Continue on phone',exact:true}).waitFor();
    assert.equal(accepts,0);assert.equal(await page.locator('audio').count(),0);
    assert.equal(await page.evaluate(()=>window.handoffPlayAttempts),0);
    await page.getByRole('button',{name:'Continue on phone',exact:true}).click();
    await page.getByText('Waiting for your watch to pause and confirm its section…',{exact:true}).waitFor();
    assert.equal(await page.locator('audio').count(),0);assert.equal(jobs.length,0);
    confirmed=true;
    await page.locator('audio').waitFor();
    await page.waitForFunction(()=>window.handoffPlayAttempts>0,undefined,{timeout:15000}).catch(async error=>{console.log(await page.getByRole('dialog').innerText(),jobs,await page.evaluate(()=>({plays:window.handoffPlayAttempts,audio:document.querySelector('audio')?.outerHTML})));throw error});
    assert.equal(accepts,1);assert.deepEqual(jobs[0].titles,['Exact current section from the watch.','Final section.']);
    assert.match(await page.getByRole('dialog').innerText(),/Section 3 of 4/);
    assert.match(await page.getByRole('dialog').innerText(),/tap Play|Tap Play/);
    await page.getByRole('button',{name:'Browser voice',exact:true}).click();
    const play=page.getByRole('button',{name:'Play',exact:true});
    if(width===390) { await play.waitFor(); await play.click(); }
    await page.waitForFunction(()=>window.handoffSpeech.length>0,undefined,{timeout:15000}).catch(async error=>{console.log('Speech failure',await page.getByRole('dialog').innerText(),errors);throw error});
    assert.equal(await page.evaluate(()=>window.handoffSpeech[0]),'Exact current section from the watch.');
    await mkdir('work/listening-handoff',{recursive:true});await page.screenshot({path:`work/listening-handoff/phone-${width}.png`,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByRole('button',{name:'Close listening transfer',exact:true}).click();
    await page.getByText('Transfer closed',{exact:true}).waitFor();
    assert.equal(await page.locator('audio').count(),0);assert.deepEqual(errors,[]);
    // Not now never accepts or starts narration.
    phase='pending';confirmed=false;accepts=0;await page.reload();
    await page.getByRole('button',{name:'Not now',exact:true}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('Transfer closed'));
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(accepts,0);assert.ok(cancels>0);
    // A cancelled acceptance never mounts the player, even after the browser poll.
    phase='pending';cancels=0;await page.reload();
    await page.getByRole('button',{name:'Continue on phone',exact:true}).waitFor();forceCancelled=true;await page.getByRole('button',{name:'Continue on phone',exact:true}).click();
    await page.getByRole('alert').waitFor();assert.equal(await page.locator('audio').count(),0);
    assert.equal(await page.evaluate(()=>window.handoffPlayAttempts),0);
    // A previous phone recording position must not override the incoming watch section.
    forceCancelled=false;phase='pending';confirmed=false;await page.reload();
    await page.getByRole('button',{name:'Continue on phone',exact:true}).waitFor();
    await page.evaluate(async()=>{
      const {preparedAudioCache}=await import('/app/headline-audio.ts');
      const parts=['Exact current section from the watch.','Final section.'];
      const raw=new ArrayBuffer(44+32000*6),view=new DataView(raw),bytes=new Uint8Array(raw);
      const tag=(at,text)=>{for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i)};
      tag(0,'RIFF');view.setUint32(4,raw.byteLength-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);
      view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,raw.byteLength-44,true);
      const voices={en:'',zh:''};preparedAudioCache.remember(parts,3,navigator.language,voices,{blob:new Blob([raw],{type:'audio/wav'}),starts:[0,3]});
      preparedAudioCache.savePosition(preparedAudioCache.key(parts,3,navigator.language,voices),4);
    });
    const before=jobs.length;
    await page.getByRole('button',{name:'Continue on phone',exact:true}).click();confirmed=true;
    await page.waitForFunction(()=>document.querySelector('audio')?.readyState>0);
    assert.equal(jobs.length,before,'The prepared recording should be reused');
    assert.ok(await page.locator('audio').evaluate(element=>element.currentTime)<0.1,'Resume must start at the transferred watch section, not an old phone time');
    await page.close();console.log(`PASS ${width}px: explicit consent, pause acknowledgement, exact section, autoplay fallback, browser voice, cancellation, cached-position override and layout`);
  }
}finally{await browser?.close();await server.close()}
