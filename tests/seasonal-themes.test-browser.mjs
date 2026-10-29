import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const root=resolve('Signal.Server/wwwroot');let signed=false;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),path=url.pathname;
 if(path.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(path==='/api/auth/me'){res.statusCode=signed?200:401;res.end(JSON.stringify({email:'preview@example.com',displayName:'Seasonal preview',hasPassword:true}));return}
  const responses={
   '/api/auth/providers':{google:false},'/api/auth/csrf':{token:'preview'},'/api/app-version':{version:'preview'},
   '/api/preferences':{exists:true,preferences:{topics:['Design'],providers:['google'],feeds:[],limit:10}},
   '/api/social':{friends:[],incomingRequests:[],outgoingRequests:[],unreadMessages:0},'/api/comments/latest':{comments:[],newCount:0},
   '/api/articles':{articles:[],total:0,hasMore:false},'/api/topic-refresh':{topics:[],articles:[]},
   '/api/news':{articles:[{title:'A little curiosity after dark',url:'https://example.com/story',source:'Signal sample',summary:'Your usual stories, with a little Halloween spirit.',publishedAt:new Date().toISOString(),topics:['Design'],providers:['google']}],provider:'google',fetchedAt:new Date().toISOString()},
  };
  res.end(JSON.stringify(responses[path]||{}));return;
 }
 const pathname=path==='/'?'/index.html':path.endsWith('/')?path+'index.html':path;
 const base=path.startsWith('/signalwatch/')||path.startsWith('/icons/')||path==='/seasonal-branding.js'?resolve('public'):root;
 const file=resolve(base,'.'+pathname);if(!file.startsWith(base)){res.statusCode=403;res.end();return}
 try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]||'application/octet-stream');res.end(await readFile(file))}catch{res.statusCode=404;res.end()}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'msedge'});
const dates={'halloween':'2026-10-29','christmas':'2026-12-15','new-year':'2026-12-31','chinese-new-year':'2027-02-06','standard':'2026-11-12'};
try{
 await mkdir('work/seasonal/screenshots',{recursive:true});
 for(const [season,date] of Object.entries(dates)) for(const width of [390,1280]) for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date(date+'T12:00:00')});await page.addInitScript(theme=>localStorage.setItem('signal-color-theme',theme),theme);
  for(const loggedIn of [false,true]){
   signed=loggedIn;await page.goto(origin,{timeout:120000});await page.locator(loggedIn?'.site-header':'.auth-shell').waitFor();
   assert.equal(await page.locator('html').getAttribute('data-season'),season);
   assert.equal(await page.locator('.brand-mark:visible').count(),1,'Exactly one visible brand mark');
   const mark=page.locator('.brand-mark:visible');assert.match(await mark.getAttribute('src'),new RegExp(season==='standard'?'signal-medallion-64':`signal-${season}`));
   assert.equal(await mark.evaluate(el=>el.complete&&el.naturalWidth>0),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:`work/seasonal/screenshots/${season}-${loggedIn?'dashboard':'login'}-${theme}-${width}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:1000}});await page.clock.install({time:new Date('2026-10-29T12:00:00')});
  await page.goto(origin+'/signalwatch/',{timeout:120000});
  for(const season of ['christmas','new-year','chinese-new-year','standard','halloween']){
   await Promise.all([page.waitForURL(`**theme=${season}`),page.getByLabel('Preview theme').selectOption(season)]);
   await page.locator('#watch .wordmark').waitFor();assert.equal(await page.locator('html').getAttribute('data-season'),season);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.getByRole('button',{name:'Preview disaster warning',exact:true}).click();assert.equal(await page.locator('.urgent-warning .chip').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(179, 38, 30)');
   await page.getByRole('button',{name:'Acknowledge',exact:true}).click();await page.screenshot({path:`work/seasonal/screenshots/${season}-watch-${width}.png`,fullPage:true});
  }
  await page.getByLabel('Preview theme').selectOption('auto');await page.waitForURL(url=>!url.searchParams.has('theme'));assert.equal(await page.locator('html').getAttribute('data-season'),'halloween');await page.close();
 }
 console.log('PASS all seasonal web layouts: phone/desktop, light/dark, login/dashboard, one visible loaded logo, calendar selection, no overflow or script errors; watch preview picker and red warnings');
}finally{await browser.close();await new Promise(r=>server.close(r))}
