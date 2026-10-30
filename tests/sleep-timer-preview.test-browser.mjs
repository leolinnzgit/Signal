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
  await page.getByRole('button',{name:'Listen later',exact:true}).click();await watch.getByRole('button',{name:'Play Listen later',exact:true}).click();
  await watch.getByRole('button',{name:'Next section',exact:true}).click();
  await watch.getByRole('button',{name:'Sleep timer: Off',exact:true}).click();await watch.getByRole('button',{name:'Stop after 15 minutes',exact:true}).click();
  await watch.getByRole('button',{name:/^Sleep timer: (14|15):/}).click();await watch.getByRole('button',{name:'Stop after 30 minutes',exact:true}).click();
  await watch.getByRole('button',{name:/^Sleep timer: (29|30):/}).click();await watch.getByRole('button',{name:'Stop after 60 minutes',exact:true}).click();
  await watch.getByRole('button',{name:'Pause',exact:true}).click();await watch.getByRole('button',{name:/^Sleep timer: (59|60):/}).click();
  await watch.getByRole('button',{name:'Preview timer expiry',exact:true}).click();await watch.getByRole('button',{name:'Sleep timer finished',exact:true}).waitFor();
  assert.equal(await watch.getByRole('button',{name:'Pause',exact:true}).count(),0);await watch.getByText('Section 2 of 4',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Play',exact:true}).click();await watch.getByRole('button',{name:'Sleep timer: Off',exact:true}).click();
  await watch.getByRole('button',{name:'Stop after 15 minutes',exact:true}).click();await watch.getByRole('button',{name:/^Sleep timer: (14|15):/}).click();
  await watch.getByRole('button',{name:'Cancel sleep timer',exact:true}).click();await watch.getByRole('button',{name:'Pause',exact:true}).waitFor();
  await watch.getByRole('button',{name:'Sleep timer: Off',exact:true}).click();await watch.getByRole('button',{name:'Finish current story',exact:true}).click();
  await watch.getByRole('button',{name:'Finish listening',exact:true}).click();await watch.getByRole('button',{name:'Sleep timer finished',exact:true}).waitFor();
  await watch.getByText('Keep a good read for later',{exact:true}).waitFor();await watch.getByText('Section 1 of 4',{exact:true}).waitFor();
  assert.equal(await watch.getByRole('button',{name:'Pause',exact:true}).count(),0);await watch.getByRole('button',{name:'Play',exact:true}).waitFor();
  await watch.getByRole('button',{name:'Sleep timer finished',exact:true}).click();await watch.getByRole('button',{name:'Stop after 15 minutes',exact:true}).click();
  await watch.getByRole('button',{name:'Stop listening',exact:true}).click();await page.getByRole('button',{name:'Listen later',exact:true}).click();await watch.getByRole('button',{name:'Play Listen later',exact:true}).click();
  await watch.getByRole('button',{name:'Sleep timer: Off',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  await page.close();console.log(`PASS ${width}px: timer durations/change/cancel, paused expiry, saved section, end-of-story next entry paused and Stop reset`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
