import {previewHandler} from './preview-assets.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const html=await readFile(new URL('../public/signalwatch/index.html',import.meta.url));
const server=createServer(previewHandler(html));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{timeout:90000});const watch=page.locator('#watch');assert.match(await page.locator('header').innerText(),/0\.21\.0/);
  await page.getByRole('button',{name:'Listen later',exact:true}).click();await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).click();await watch.getByRole('button',{name:'Automatic downloads: On',exact:true}).waitFor();await watch.getByRole('heading',{name:'Listen later',exact:true}).waitFor();
  await watch.getByRole('button',{name:'Download queue audio',exact:true}).click();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),2);
  await watch.getByRole('button',{name:'Cancel background downloads',exact:true}).click();await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).waitFor();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),2);
  await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).click();await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).first().click();await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).waitFor();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),1);
  await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).click();await watch.getByRole('button',{name:'Clear downloaded audio',exact:true}).click();await watch.getByRole('button',{name:'Automatic downloads: Off',exact:true}).waitFor();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),0);
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.close();console.log(`PASS ${width}px: explicit automatic opt-in, no arrival playback, cancel preserves completed audio, remove/clear disables auto, and layout`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
