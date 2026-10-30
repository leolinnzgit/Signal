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
  await page.getByRole('button',{name:'Queue tile',exact:true}).click();
  await watch.getByText('0 of 2 ready offline',{exact:true}).waitFor();assert.equal(await watch.getByRole('button',{name:'Pause',exact:true}).count(),0);
  for(const [value,text] of [['charging','Waiting for charging'],['wifi','Waiting for Watch Wi-Fi'],['queued','Queued by Android'],['downloading','Downloading · 50%'],['paused','Downloads paused · open queue']]){
   await watch.getByLabel('Sample download state').selectOption(value);await watch.locator('p.summary').filter({hasText:text}).waitFor();
   assert.equal(await watch.getByRole('button',{name:'Pause',exact:true}).count(),0);
  }
  await watch.getByLabel('Sample download state').selectOption('idle');await watch.getByRole('button',{name:'Queue',exact:true}).click();
  await watch.getByRole('button',{name:'Download audio',exact:true}).first().click();
  await page.getByRole('button',{name:'Queue tile',exact:true}).click();await watch.getByText('1 of 2 ready offline',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Play queue',exact:true}).click();await watch.getByText('Section 1 of 4',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Next section',exact:true}).click();await watch.getByRole('button',{name:'Stop listening',exact:true}).click();
  await page.getByRole('button',{name:'Queue tile',exact:true}).click();await watch.getByText('Section 2 of 4',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Resume',exact:true}).click();await watch.getByText('Section 2 of 4',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Finish listening',exact:true}).click();await page.getByRole('button',{name:'Queue tile',exact:true}).click();
  await watch.getByText('0 of 1 ready offline',{exact:true}).waitFor();
  await watch.getByRole('button',{name:'Queue',exact:true}).click();await watch.getByRole('button',{name:'Remove queued story',exact:true}).click();
  await page.getByRole('button',{name:'Queue tile',exact:true}).click();assert.match(await watch.innerText(),/Your queue is empty/);
  assert.equal(await watch.getByRole('button',{name:'Play queue',exact:true}).count(),0);assert.equal(await watch.getByRole('button',{name:'Resume',exact:true}).count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  await page.close();console.log(`PASS ${width}px: queue tile readiness, waiting states, explicit play/resume, saved section, completion and empty queue`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
