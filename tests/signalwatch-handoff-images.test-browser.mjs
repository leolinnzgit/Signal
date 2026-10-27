import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.SIGNAL_PLAYWRIGHT_MODULE||'playwright');
const html=await readFile(new URL('../public/signalwatch/index.html',import.meta.url));
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
  browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const width of [390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`,{timeout:90_000});
    const watch=page.locator('#watch');
    await page.getByRole('button',{name:'A little more perspective',exact:false}).click();
    await watch.getByAltText('Sample news image',{exact:true}).waitFor();
    await watch.getByAltText('Sample news image',{exact:true}).scrollIntoViewIfNeeded();
    assert.ok(await watch.getByAltText('Sample news image').evaluate(image=>image.naturalWidth)>0);
    await mkdir('work/reverse-images',{recursive:true});await page.screenshot({path:`work/reverse-images/watch-image-${width}.png`,fullPage:true});
    await watch.getByRole('button',{name:'Back to briefing',exact:true}).click();
    await page.getByRole('button',{name:'Keep a good read for later',exact:false}).click();
    assert.equal(await watch.locator('img').count(),0,'Stories without images remain readable');
    await page.getByRole('button',{name:'Preview phone transfer',exact:true}).click();
    await watch.getByRole('button',{name:'Not now',exact:true}).click();
    assert.match(await page.locator('#status').innerText(),/declined/);
    await page.getByRole('button',{name:'Preview phone transfer',exact:true}).click();
    await watch.getByRole('button',{name:'Continue from phone',exact:true}).click();
    assert.match(await watch.innerText(),/Section 2 of 4/);
    await watch.getByRole('button',{name:'Pause',exact:true}).waitFor();
    assert.match(await page.locator('#status').innerText(),/phone paused and confirmed/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`work/reverse-images/watch-transfer-${width}.png`,fullPage:true});
    assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: optional image, text-only fallback, explicit reverse transfer, decline, confirmed section and layout`);
  }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
