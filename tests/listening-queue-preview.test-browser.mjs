import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const html=await readFile(new URL('../public/signalwatch/index.html',import.meta.url));
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
try{for(const width of [390,1280]){
 const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`,{timeout:90000});const watch=page.locator('#watch');
 await page.getByRole('button',{name:'Listen later',exact:true}).click();assert.match(await watch.innerText(),/2\/10/);assert.equal(await watch.getByRole('button',{name:'Pause',exact:true}).count(),0);
 await watch.getByRole('button',{name:'Play Listen later',exact:true}).click();await watch.getByRole('button',{name:'Finish listening',exact:true}).click();assert.match(await page.locator('#status').innerText(),/next queued story/);
 await watch.getByRole('button',{name:'Finish listening',exact:true}).click();await page.getByRole('button',{name:'Listen later',exact:true}).click();assert.match(await watch.innerText(),/0\/10/);
 await watch.getByRole('button',{name:'Back to briefing',exact:true}).click();await watch.locator('button.card').first().click();await watch.getByRole('button',{name:'Add to Listen later',exact:true}).click();await watch.getByRole('button',{name:'Remove from Listen later',exact:true}).waitFor();
 await page.getByRole('button',{name:'Listen later',exact:true}).click();assert.match(await watch.innerText(),/1\/10/);await watch.getByRole('button',{name:'Remove queued story',exact:true}).click();assert.match(await watch.innerText(),/0\/10/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: Watch queue preview, explicit playback, next story, add/remove and layout`);
}}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
