import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'queue-fixture',configureServer(server){server.middlewares.use('/queue-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/queue-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/listening-queue.fixture.tsx"></script></body></html>'))})}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3031,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**','**/public/**']}}});
await server.listen();let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 for(const width of [390,1280]){
  let serial=0,offlineA=false,last=null,state={accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'0',state:'empty',updatedAt:new Date().toISOString(),document:null};
  const contexts=[],errors=[],posts=[],jobs=[];
  async function device(isA){const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{
    window.queueOnline=true;Object.defineProperty(navigator,'onLine',{get:()=>window.queueOnline});window.queueSpeech=[];window.queueUtterance=null;
    window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
    window.speechSynthesis.getVoices=()=>[{name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true}];
    Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});
    window.speechSynthesis.speak=u=>{window.queueUtterance=u;window.queueSpeech.push(u.text);u.onstart?.({})};
    window.speechSynthesis.cancel=()=>{};window.speechSynthesis.resume=()=>{};window.speechSynthesis.pause=()=>{};
    HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Tap required','NotAllowedError'));
   });
   await page.route('**/api/**',async route=>{
    if(isA&&offlineA)return route.abort('internetdisconnected');
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
    if(path==='/api/listening-queue'){
     if(request.method()==='POST'){
      const body=request.postDataJSON();posts.push(body);assert.equal(request.headers()['x-xsrf-token'],'csrf');assert.equal(body.accountKey,state.accountKey);
      if(last?.operationId===body.operationId)return route.fulfill({json:state});
      if(body.baseVersion!==state.version)return route.fulfill({status:409,json:state});
      last=body;state={...state,version:(++serial).toString(16).padStart(32,'0'),state:'active',document:body.document};
     }
     return route.fulfill({json:state});
    }
    if(path==='/api/article-reader')return route.fulfill({json:{available:true,article:{paragraphs:['Alpha first section.','Alpha final section.']}}});
    if(path==='/api/headline-audio/voices')return route.fulfill({json:[]});
    if(path==='/api/headline-audio'){jobs.push(request.postDataJSON());return route.fulfill({status:503,json:{error:'Device voice available'}})}
    return route.fulfill({json:{}});
   });return page;
  }
  const a=await device(true),b=await device(false);
  await a.goto('http://127.0.0.1:3031/queue-test');await a.getByRole('button',{name:'Add to Listen later: Alpha story'}).click();await a.getByRole('button',{name:'Add to Listen later: Beta story'}).click();
  await a.getByRole('button',{name:'Move up: Beta story'}).click();
  assert.match(await a.locator('.listen-later li').first().innerText(),/Beta story/);
  await a.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await a.waitForFunction(()=>!JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')).pending);
  assert.equal(state.document.items.length,2);assert.equal(state.document.currentUrl,'https://example.com/alpha');
  assert.equal(await a.locator('audio').count(),0);assert.equal(await a.evaluate(()=>window.queueSpeech.length),0);
  await mkdir('work/listening-queue',{recursive:true});await a.screenshot({path:`work/listening-queue/queue-${width}.png`,fullPage:true});
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // Offline narration uses exact saved parts, including the resume offset after reopening.
  offlineA=true;await a.evaluate(()=>window.queueOnline=false);await a.getByRole('button',{name:'Play Alpha story',exact:true}).click();
  const alphaPlay=a.getByRole('button',{name:'Play',exact:true});if(await alphaPlay.count())await alphaPlay.click();
  await a.waitForFunction(()=>window.queueSpeech.length>0);
  await a.getByRole('button',{name:'Next section',exact:true}).click();
  await a.waitForFunction(()=>JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')).pending?.document.items.find(x=>x.title==='Alpha story').partIndex===1).catch(async error=>{console.log('Section diagnostics',await a.locator('body').innerText(),await a.evaluate(()=>({disk:Object.entries(localStorage),speech:window.queueSpeech})),errors);throw error});
  await a.getByRole('button',{name:'Close Listen later player'}).click();await a.reload();
  await a.waitForFunction(()=>document.querySelector('.listen-later')?.textContent.includes('Section 2/3'));
  assert.equal(await a.evaluate(()=>window.queueSpeech.length),0);
  // A second device removes the current story; stale offline edits cannot re-add it.
  await b.goto('http://127.0.0.1:3031/queue-test');await b.getByRole('button',{name:'Remove Alpha story',exact:true}).click();
  await b.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  for(let n=0;state.document.items.length!==1&&n<100;n++)await new Promise(r=>setTimeout(r,50));assert.equal(state.document.items.length,1);
  offlineA=false;await a.evaluate(()=>{window.queueOnline=true;document.dispatchEvent(new Event('visibilitychange'))});
  await a.waitForFunction(()=>{const c=JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com'));return !c.pending&&c.progress.document.items.length===1});
  assert.equal(state.document.items[0].title,'Beta story');
  // Explicit device-voice playback consumes the last queued story on real speech completion events.
  await a.evaluate(()=>window.queueOnline=false);await a.getByRole('button',{name:'Play Beta story',exact:true}).click();
  const play=a.getByRole('button',{name:'Play',exact:true});if(await play.count())await play.click();
  await a.waitForFunction(()=>window.queueSpeech.length>0);
  for(let n=0;n<3;n++){await a.waitForFunction(()=>typeof window.queueUtterance?.onend==='function');const ended=await a.evaluate(()=>{const text=window.queueUtterance.text;window.queueUtterance.onend({});return text});if(n<2)await a.waitForFunction(text=>window.queueUtterance.text!==text,ended);}
  await a.waitForFunction(()=>document.querySelector('.listen-later')?.textContent.includes('Your queue is empty')).catch(async error=>{console.log('Completion diagnostics',await a.locator('body').innerText(),await a.evaluate(()=>({disk:Object.entries(localStorage),speech:window.queueSpeech})),errors);throw error});
  await a.evaluate(()=>{window.queueOnline=true;document.dispatchEvent(new Event('visibilitychange'))});
  for(let n=0;state.document.items.length&&n<100;n++)await new Promise(r=>setTimeout(r,50));assert.equal(state.document.items.length,0);
  // Completing the first story switches the real mounted player to the next saved text.
  await a.getByRole('button',{name:'Add to Listen later: Alpha story'}).click();await a.getByRole('button',{name:'Add to Listen later: Beta story'}).click();
  await a.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await a.waitForFunction(()=>!JSON.parse(localStorage.getItem('signal.listening-queue.v1.owner%40example.com')).pending);
  await a.evaluate(()=>window.queueOnline=false);await a.getByRole('button',{name:'Play Alpha story',exact:true}).click();
  for(let n=0;n<3;n++){await a.waitForFunction(()=>typeof window.queueUtterance?.onend==='function');const ended=await a.evaluate(()=>{const text=window.queueUtterance.text;window.queueUtterance.onend({});return text});if(n<2)await a.waitForFunction(text=>window.queueUtterance.text!==text,ended);}
  await a.getByRole('dialog').getByRole('heading',{name:'Beta story',exact:true}).waitFor();
  assert.equal(await a.locator('.listen-later li').count(),1);
  await a.getByRole('button',{name:'Close Listen later player'}).click();
  await a.getByRole('button',{name:'Sign out',exact:true}).click();assert.equal(await a.evaluate(()=>localStorage.getItem('signal.listening-queue.v1.owner%40example.com')),null);
  assert.deepEqual(errors,[]);assert.ok(posts.length>=4);
  for(const context of contexts)await context.close();console.log(`PASS ${width}px: add/download, reorder, no arrival audio, offline device voice, cached section, cross-device removal/conflict, completion, automatic next story and sign-out`);
 }
}finally{await browser?.close();await server.close()}
