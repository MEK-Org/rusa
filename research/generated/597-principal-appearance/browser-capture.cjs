const { chromium } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
 const root=path.resolve('../evidence/597-appearance-web');
 const output=path.resolve('../evidence/597-appearance-pngs');
 const types={'.html':'text/html','.js':'application/javascript','.wasm':'application/wasm','.json':'application/json','.ttf':'font/ttf','.otf':'font/otf'};
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/after\//,'/');
  if(pathname.startsWith('/api/mesh/avatar/')) {console.log('SYNTHETIC AVATAR 404',pathname);res.writeHead(404);res.end();return;}
  try{const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+'/'))throw Error('outside');const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(18968,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{await fs.mkdir(output,{recursive:true});
 for(const [name,viewport] of Object.entries({wide:{width:1180,height:820},narrow:{width:390,height:844}})) for(const state of ['before','after']){
  const page=await browser.newPage({viewport,deviceScaleFactor:2});
  page.on('pageerror',e=>console.log('PAGEERROR',e.stack));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('http://127.0.0.1:18968/?state='+state);
  for(const label of ['Human avatar fallback','Kind filter:','All Events','message_sent','message_received','Synthetic local message.','Synthetic local reply.',state==='before'?'human:operator':'00000000-0000-4000-8000-000000000597']) await page.waitForFunction(label=>Array.from(document.querySelectorAll('flt-semantics')).some(e=>((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')).includes(label)),label);
  await page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<12;i++)await new Promise(requestAnimationFrame);});
  await page.waitForTimeout(1500);await page.screenshot();await page.screenshot({path:path.join(output,name+'-'+state+'.png')});console.log(name+'-'+state+': captured');await page.close();
 }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
