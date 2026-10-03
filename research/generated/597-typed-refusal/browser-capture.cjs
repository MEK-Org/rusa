const {chromium}=require('../../rusa-816/node_modules/.pnpm/@playwright+test@1.58.2/node_modules/@playwright/test');
const http=require('node:http'); const fs=require('node:fs/promises'); const path=require('node:path');
(async()=>{
 const root=path.resolve('../evidence/597-refusal-web'); const output=path.resolve('../evidence/597-refusal-pngs');
 const types={'.html':'text/html','.js':'application/javascript','.wasm':'application/wasm','.json':'application/json','.ttf':'font/ttf','.otf':'font/otf'};
 const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname; const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+'/'))throw Error('outside');let bytes=await fs.readFile(file);if(path.basename(file)==='flutter_bootstrap.js')bytes=Buffer.from(bytes.toString().replace('_flutter.loader.load({','_flutter.buildConfig.useLocalCanvasKit = true;\n_flutter.loader.load({'));res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {await fs.mkdir(output,{recursive:true}); for(const [name,viewport] of Object.entries({wide:{width:1180,height:820},narrow:{width:390,height:844}})){
  const page=await browser.newPage({viewport,deviceScaleFactor:2});page.on('pageerror',e=>console.log('PAGEERROR',e.stack));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(origin); await page.getByRole('textbox').fill('Synthetic message from Bob');
  await page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<12;i++)await new Promise(requestAnimationFrame);});
  await page.screenshot();await page.screenshot({path:path.join(output,name+'-before.png')});
  await page.getByRole('button').last().click();
  await page.waitForFunction(()=>document.body.textContent.includes('voice session is held by a different principal'));
  await page.evaluate(async()=>{for(let i=0;i<12;i++)await new Promise(requestAnimationFrame);});
  await page.screenshot();await page.screenshot({path:path.join(output,name+'-refused.png')});
  console.log(name+': before/refusal captured; textbox='+await page.getByRole('textbox').inputValue());await page.close();
 }}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
