import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'library-fixture',configureServer(server){server.middlewares.use('/library-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/library-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/listening-library.fixture.tsx"></script></body></html>'))})}}],css:{postcss:{plugins:[]}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:3032,strictPort:true,watch:{ignored:['**/work/**','**/Signal.Server/**','**/Signal.Server.TopicMatcher.Tests/**','**/iis-publish/**','**/public/**']}}});
await server.listen();let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 await mkdir('work/listening-library',{recursive:true});
 for(const season of ['standard','halloween'])for(const width of [360,390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   localStorage.setItem('signal.weather-audio-on-open.v1','false');localStorage.setItem('signal-color-theme','light');
   localStorage.setItem('signal-news-preferences',JSON.stringify({topics:['Technology'],sources:{google:true,gdelt:false,rssFeeds:[]}}));
   window.libraryOnline=true;Object.defineProperty(navigator,'onLine',{get:()=>window.libraryOnline});window.librarySpeech=[];
   window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};window.speechSynthesis.getVoices=()=>[{name:'Device English',voiceURI:'device-en',lang:'en-NZ',default:true,localService:true}];
   Object.defineProperty(window.speechSynthesis,'speaking',{get:()=>true});window.speechSynthesis.speak=u=>{window.librarySpeech.push(u.text);u.onstart?.({})};window.speechSynthesis.cancel=()=>{};window.speechSynthesis.pause=()=>{};window.speechSynthesis.resume=()=>{};
   HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Tap required','NotAllowedError'));
  });
  const item=n=>({url:`https://example.com/${n}`,title:n===1?'A quieter way to keep up with the stories that matter':n===2?'How clean energy is changing the cities we live in':'What researchers learned from a year of listening',source:'Publisher',imageUrl:'',parts:['Heading.','Saved section.','Final section.'],partIndex:1});
  const state=document=>({accountKey:'A'.repeat(64),accountEmail:'owner@example.com',version:'1'.repeat(32),state:'active',updatedAt:new Date().toISOString(),document});
  let queue=state({items:[item(1),item(2),item(3)],currentUrl:item(1).url}),saved=state(item(1)),serial=1,delayProgress=false;const pendingProgress=[];
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/api/listening-queue'||path==='/api/listening-progress'){
    if(path==='/api/listening-progress'&&delayProgress)await new Promise(resolve=>pendingProgress.push(resolve));
    if(request.method()==='POST'){
     const body=request.postDataJSON();const next={...state(body.document),version:(++serial).toString(16).padStart(32,'0')};
     if(path==='/api/listening-queue')queue=next;else saved={...next,state:body.action==='save'?'active':'forgotten'};
    }
    return route.fulfill({json:path==='/api/listening-queue'?queue:saved}).catch(()=>{});
   }
   if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf'}});
   if(path==='/api/news')return route.fulfill({json:{articles:[{...item(1),publishedAt:new Date().toISOString(),summary:'A sample story in your regular briefing.',matchedTopics:['Technology']}],fetchedAt:new Date().toISOString()}});
   if(path==='/api/headline-audio/voices')return route.fulfill({json:[]});
   if(path.includes('audio'))return route.fulfill({status:503,json:{error:'Use the device voice in this preview.'}});
   return route.fulfill({json:{}});
  });
  await page.goto('http://127.0.0.1:3032/library-test');await page.evaluate(season=>{document.documentElement.dataset.season=season},season);const trigger=page.getByRole('button',{name:'Listening library',exact:true});await trigger.waitFor();
  assert.equal(await page.locator('.brand-mark:visible').count(),1,'Exactly one seasonal brand mark is visible');
  assert.equal(await page.locator('.site-header').evaluate(header=>header.nextElementSibling.classList.contains('hero')),true,'The briefing follows the header directly');
  assert.equal(await page.locator('#listening-library').isVisible(),false);assert.equal(await page.locator('audio').count(),0);assert.equal(await page.evaluate(()=>window.librarySpeech.length),0);
  await page.getByRole('button',{name:`Remove from Listen later: ${item(1).title}`,exact:true}).waitFor();
  assert.equal(await page.locator('.listen-later-add-compact button svg').count(),1);
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>Math.abs(document.querySelector('.settings-toggle').getBoundingClientRect().top-document.querySelector('.listening-library-toggle').getBoundingClientRect().top)<3).catch(async error=>{
    await page.screenshot({path:`work/listening-library/header-failure-${width}.png`});
    console.log('Header layout diagnostics',await page.locator('.site-header').evaluate(header=>[...header.querySelectorAll('.brand,.header-actions > button')].map(element=>({class:element.className,width:element.getBoundingClientRect().width,top:element.getBoundingClientRect().top}))));throw error;
  });
  await page.screenshot({path:`work/listening-library/feed-${width}.png`,fullPage:false});
  const headerHeight=await page.locator('.site-header').evaluate(header=>header.getBoundingClientRect().height);
  await trigger.click();const library=page.getByRole('dialog',{name:'Listening',exact:true});await library.waitFor();
  assert.equal(await library.getByRole('tab',{name:'Resume',exact:true}).getAttribute('aria-selected'),'true');
  await page.screenshot({path:`work/listening-library/resume-${width}.png`});
  // Existing saved-story player opens above the library and returns to it when closed.
  await library.getByRole('button',{name:'Resume saved story',exact:true}).click();await page.getByRole('dialog',{name:'Resume saved story',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close saved story',exact:true}).click();await library.waitFor();
  await library.getByRole('tab',{name:'Resume',exact:true}).focus();await page.keyboard.press('ArrowRight');
  const later=library.getByRole('tab',{name:'Listen later 3',exact:true});assert.equal(await later.getAttribute('aria-selected'),'true');
  await library.getByRole('button',{name:`Move down: ${item(1).title}`,exact:true}).click();assert.match(await library.locator('.listen-later li').first().innerText(),/clean energy/);
  await page.screenshot({path:`work/listening-library/queue-${width}.png`});
  await library.getByRole('button',{name:`Remove ${item(3).title}`,exact:true}).click();assert.equal(await trigger.locator('.listening-library-count').innerText(),'2');
  await page.evaluate(()=>window.libraryOnline=false);await library.getByRole('button',{name:`Play ${item(1).title}`,exact:true}).click();await page.getByRole('dialog',{name:'Listen later player',exact:true}).waitFor();
  await page.waitForFunction(()=>window.librarySpeech.length>0);assert.ok((await page.evaluate(()=>window.librarySpeech)).every(text=>!text.includes('Heading')),'Queue resumes the saved section');
  await page.getByRole('button',{name:'Close Listen later player',exact:true}).click();await library.waitFor();
  await page.keyboard.press('Escape');await library.waitFor({state:'hidden'});assert.equal(await trigger.getAttribute('aria-expanded'),'false');assert.equal(await trigger.evaluate(button=>document.activeElement===button),true);
  assert.equal(await page.locator('.site-header').evaluate(header=>header.getBoundingClientRect().height),headerHeight);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();await trigger.click();await library.getByRole('tab',{name:'Listen later 2',exact:true}).click();
  await page.screenshot({path:`work/listening-library/queue-dark-${width}.png`});await library.getByRole('button',{name:'Close listening library',exact:true}).click();
  // Closing the library cancels an in-flight resume instead of opening audio afterwards.
  await page.evaluate(()=>window.libraryOnline=true);delayProgress=true;
  await trigger.click();await library.getByRole('tab',{name:'Resume',exact:true}).click();
  const speechCount=await page.evaluate(()=>window.librarySpeech.length);
  await library.getByRole('button',{name:'Resume saved story',exact:true}).click();await library.getByRole('button',{name:'Close listening library',exact:true}).click();
  delayProgress=false;pendingProgress.splice(0).forEach(resolve=>resolve());
  await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.evaluate(()=>window.librarySpeech.length),speechCount);
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: clean header/hero, compact story action, tabs/keyboard, queue reorder/remove, nested Resume and queue players, focus return, dark theme and no horizontal overflow`);
 }
}finally{await browser?.close();await server.close()}
