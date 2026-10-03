const { chromium } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const roots = {after: path.resolve('../evidence/866-browser-after'), before: path.resolve('../evidence/866-browser-before')};
  const types={'.html':'text/html','.js':'application/javascript','.wasm':'application/wasm','.json':'application/json','.ttf':'font/ttf','.otf':'font/otf'};
  const server = http.createServer(async(req,res) => {
    try {
      const parts = new URL(req.url,'http://localhost').pathname.split('/').filter(Boolean);
      const root=roots[parts.shift()]; if(!root) throw Error('missing');
      const file=path.resolve(root,parts.join('/') || 'index.html');
      if (!file.startsWith(root+'/')) throw Error('outside');
      const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(bytes);
    }catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(18966,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  try {
    await fs.mkdir('../evidence/866-browser-pngs',{recursive:true});
    for(const [name,viewport] of Object.entries({wide:{width:1180,height:820},narrow:{width:390,height:844}})) {
      for(const state of (process.env.CAPTURE_STATES || 'before,collapsed,expanded,unavailable').split(',')) {
        const page=await browser.newPage({viewport,deviceScaleFactor:2});
        page.on('console',msg=>console.log('CONSOLE',msg.text()));
        page.on('requestfailed',req=>console.log('REQUESTFAILED',req.url(),req.failure()));
        page.on('response',res=>{if(res.status()>=400)console.log('HTTPFAIL',res.status(),res.url());});
        page.on('pageerror',err=>console.error('PAGEERROR',err.stack));
        await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
        await page.goto(`http://127.0.0.1:18966/${state==='before'?'before':'after'}/?unavailable=${state==='unavailable'}`);
        const requireLabel = label => page.waitForFunction(label =>
          Array.from(document.querySelectorAll('flt-semantics')).some(e =>
            ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(label)), label);
        for(const label of ['Kind filter:','All Events','run_start','resolved model: fixture-model','2026-01-01 00:00:00']) await requireLabel(label);
        if(state!=='before') await requireLabel('Run prompt');
        if(state==='expanded'||state==='unavailable') await page.getByText('Run prompt',{exact:true}).click();
        if(state==='expanded') await requireLabel('Launched provider: antigravity');
        if(state==='unavailable') await requireLabel('Prompt no longer retained or unavailable.');
        await page.evaluate(async()=>{await document.fonts.ready; for(let i=0;i<12;i++)await new Promise(requestAnimationFrame);});
        await page.waitForTimeout(1000);
        await page.screenshot(); // Warm the GPU readback before retaining evidence.
        await page.screenshot({path:`../evidence/866-browser-pngs/${name}-${state}.png`});
        console.log(`${name}-${state}: captured`);
        await page.close();
      }
    }
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
