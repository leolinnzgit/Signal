import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'offline-audio-fixture',configureServer(server){server.middlewares.use('/offline-audio-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/offline-audio-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/offline-queue-audio.fixture.tsx"></script></body></html>'))})}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3034,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**','**/public/**']}}});
function wave(count){const b=Buffer.alloc(44+count*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b}
await server.listen();let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});await mkdir('work/offline-audio',{recursive:true});
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  await page.addInitScript(()=>{window.audioPlays=0;window.localSpeech=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};window.speechSynthesis.getVoices=()=>[{name:'Local',voiceURI:'local',lang:'en-NZ',default:true,localService:true}];Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});window.speechSynthesis.speak=u=>{window.localSpeech.push(u.text);u.onstart?.({})};window.speechSynthesis.cancel=()=>{};window.speechSynthesis.pause=()=>{};window.speechSynthesis.resume=()=>{};HTMLMediaElement.prototype.play=()=>{window.audioPlays++;return Promise.reject(new DOMException('Tap required','NotAllowedError'))}});
  const items=['Alpha','Beta'].map(title=>({url:`https://example.com/${title}`,title,source:'Publisher',imageUrl:'',parts:[`${title} heading`,`${title} first`,`${title} last`],partIndex:1}));
  let offline=false,failAudio=false,hold=false,release,serial=1,syntheses=[];
  let queue={accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'1'.repeat(32),state:'active',updatedAt:new Date().toISOString(),document:{items,currentUrl:items[0].url}};
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(offline)return route.abort('internetdisconnected');
   if(path==='/api/listening-queue'){if(req.method()==='POST'){const body=req.postDataJSON();queue={...queue,document:body.document,version:(++serial).toString(16).padStart(32,'0')};return route.fulfill({json:queue})}return route.fulfill({json:queue})}
   if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
   if(path==='/api/headline-audio/voices')return route.fulfill({json:[{id:'en-NZ-MitchellNeural',name:'Mitchell',language:'en-NZ',gender:'Male'}],headers:{'X-Signal-Voice-En':'en-NZ-MitchellNeural'}});
   if(path==='/api/headline-audio'){
    syntheses.push(req.postDataJSON());if(hold)await new Promise(r=>release=r);
    if(failAudio)return route.fulfill({status:503,json:{error:'Speech temporarily unavailable. Retry when connected.'}}).catch(()=>{});
    const parts=req.postDataJSON().titles;return route.fulfill({contentType:'audio/wav',body:wave(parts.length),headers:{'X-Signal-Headline-Starts':JSON.stringify(parts.map((_,i)=>i))}}).catch(()=>{});
   }
   return route.fulfill({json:{}});
  });
  await page.goto('http://127.0.0.1:3034/offline-audio-test');await page.getByRole('button',{name:'Download audio: Alpha',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.audioPlays+window.localSpeech.length),0);
  await page.getByRole('button',{name:'Download audio: Alpha',exact:true}).click();await page.getByRole('button',{name:'Remove downloaded audio: Alpha',exact:true}).waitFor();
  await page.locator('.queue-audio-downloads summary').click();await page.getByRole('button',{name:'Download queue audio',exact:true}).click();await page.getByRole('button',{name:'Remove downloaded audio: Beta',exact:true}).waitFor();assert.equal(syntheses.length,2);assert.equal(syntheses[0].voices.en,'en-NZ-MitchellNeural');assert.equal(await page.evaluate(()=>window.audioPlays),0);
  await page.screenshot({path:`work/offline-audio/downloads-${width}.png`});
  // A fresh page, with every API request failing, still reads durable IndexedDB PCM and saved sections.
  offline=true;await page.reload();await page.getByRole('button',{name:'Remove downloaded audio: Alpha',exact:true}).waitFor();await page.getByRole('button',{name:'Play Alpha',exact:true}).click();const player=page.getByRole('dialog',{name:'Listen later player',exact:true});await player.getByText('Downloaded audio · saved recorded voice',{exact:true}).waitFor();
  const media=player.locator('audio');await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);assert.equal(await media.evaluate(a=>a.duration),2);assert.equal(syntheses.length,2);assert.equal(await page.evaluate(()=>window.localSpeech.length),0);
  await media.evaluate(a=>{Object.defineProperty(a,'paused',{configurable:true,get:()=>false});a.dispatchEvent(new Event('play'));a.currentTime=1.25;a.dispatchEvent(new Event('timeupdate'))});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')).pending?.document.items.find(x=>x.title==='Alpha').partIndex===2);
  await page.screenshot({path:`work/offline-audio/player-${width}.png`});await player.getByRole('button',{name:'Close Listen later player',exact:true}).click();
  await page.getByRole('button',{name:'Play Alpha',exact:true}).click();await page.waitForFunction(()=>document.querySelector('audio')?.duration===1);
  await page.locator('audio').evaluate(a=>{Object.defineProperty(a,'paused',{configurable:true,get:()=>false});a.dispatchEvent(new Event('play'))});await page.waitForTimeout(100);await page.locator('audio').evaluate(a=>a.dispatchEvent(new Event('ended')));await player.getByRole('heading',{name:'Beta',exact:true}).waitFor();await player.getByText('Downloaded audio · saved recorded voice',{exact:true}).waitFor();await player.getByRole('button',{name:'Close Listen later player',exact:true}).click();
  await page.waitForFunction(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('signal-queue-audio-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject});return await new Promise(resolve=>{const r=db.transaction('audio').objectStore('audio').getAll();r.onsuccess=()=>{db.close();resolve(!r.result.some(x=>x.url.endsWith('/Alpha')))}})});
  await page.locator('.queue-audio-downloads summary').click();await page.getByRole('button',{name:'Clear downloaded audio',exact:true}).click();await page.getByRole('button',{name:'Download audio: Beta',exact:true}).waitFor();
  offline=false;hold=true;await page.getByRole('button',{name:'Download audio: Beta',exact:true}).click();await page.getByRole('button',{name:'Cancel audio downloads',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.queue-audio-downloads').textContent.includes('Keep Signal'));
  while(!release)await new Promise(r=>setTimeout(r,20));await page.getByRole('button',{name:'Cancel audio downloads',exact:true}).click();release();hold=false;await page.getByRole('button',{name:'Download audio: Beta',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Remove downloaded audio: Beta',exact:true}).count(),0);
  failAudio=true;await page.getByRole('button',{name:'Download audio: Beta',exact:true}).click();await page.getByText('Speech temporarily unavailable. Retry when connected.',{exact:true}).waitFor();failAudio=false;
  await page.getByRole('button',{name:'Download audio: Beta',exact:true}).click();await page.getByRole('button',{name:'Remove downloaded audio: Beta',exact:true}).waitFor();
  await page.getByRole('button',{name:'Sign out test',exact:true}).click();await page.waitForFunction(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('signal-queue-audio-v1',1);r.onsuccess=()=>resolve(r.result)});return await new Promise(resolve=>{const r=db.transaction('audio').objectStore('audio').count();r.onsuccess=()=>{db.close();resolve(r.result===0)}})});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await context.close();console.log(`PASS ${width}px: per-story/queue downloads, selected voice, no arrival audio, durable offline PCM, exact saved sections, next story, cleanup, cancellation, failure/retry and sign-out deletion`);
 }
}finally{await browser?.close();await server.close()}
