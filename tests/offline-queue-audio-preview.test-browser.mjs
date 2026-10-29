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
  await page.goto(`http://127.0.0.1:${server.address().port}`,{timeout:90000});const watch=page.locator('#watch');
  await page.getByRole('button',{name:'Listen later',exact:true}).click();await watch.getByRole('button',{name:'Download queue audio',exact:true}).click();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),2);
  await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).first().click();assert.equal(await watch.getByRole('button',{name:'Download audio',exact:true}).count(),1);await watch.getByRole('button',{name:'Download audio',exact:true}).click();
  await watch.getByRole('button',{name:'Wi-Fi + charging: Off',exact:true}).click();await watch.getByRole('button',{name:'Wi-Fi + charging: On',exact:true}).waitFor();
  await watch.getByRole('button',{name:'Play Listen later',exact:true}).click();await watch.getByRole('button',{name:'Finish listening',exact:true}).click();await page.getByRole('button',{name:'Listen later',exact:true}).click();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),1);
  await watch.getByRole('button',{name:'Clear downloaded audio',exact:true}).click();assert.equal(await watch.getByRole('button',{name:'Audio saved · remove',exact:true}).count(),0);assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: offline audio preview download/remove/clear, charging preference and finished-story cleanup`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
