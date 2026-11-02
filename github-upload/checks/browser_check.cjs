const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const base='http://127.0.0.1:8766';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fixtureImages=process.argv.includes('--fixture-images');
(async()=>{
  const pages=await (await fetch('http://127.0.0.1:9223/json')).json();
  const target=pages.find(p=>p.type==='page');assert.ok(target);
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const requests=new Map(),errors=[];
  function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;requests.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
  ws.addEventListener('message',async event=>{
    const msg=JSON.parse(event.data);
    if(msg.id){const p=requests.get(msg.id);if(p){requests.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}return;}
    if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
    if(msg.method==='Fetch.requestPaused'){
      const {requestId,request}=msg.params;
      try{
        if(fixtureImages){
          const body=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="white"/></svg>').toString('base64');
          await call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/svg+xml'},{name:'Cache-Control',value:'no-store'}],body});return;
        }
        const r=await fetch(base+'/media?url='+encodeURIComponent(request.url));
        const body=Buffer.from(await r.arrayBuffer()).toString('base64');
        await call('Fetch.fulfillRequest',{requestId,responseCode:r.status,responseHeaders:[{name:'Content-Type',value:r.headers.get('content-type')||'image/jpeg'}],body});
      }catch(e){await call('Fetch.failRequest',{requestId,errorReason:'Failed'}).catch(()=>{});}
    }
  });
  const evaluate=async(expression)=>{
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result?.value;
  };
  async function wait(expression,timeout=65000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await delay(400);}throw Error('Timed out: '+expression);}
  async function screenshot(name){if(fixtureImages)return;const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(__dirname,name),Buffer.from(r.data,'base64'));}
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  await call('Fetch.enable',{patterns:[{urlPattern:'https://cover.mangabz.com/*'},{urlPattern:'https://image.mangabz.com/*'}]});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.Android={request(id,url,headers){fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,headers:JSON.parse(headers)})}).then(r=>r.json()).then(result=>window.__networkDone(id,result)).catch(()=>window.__networkDone(id,{status:0,body:''}));}};`});
  await call('Page.navigate',{url:base+'/'});
  await wait('document.querySelectorAll(".archive-book").length>=2');
  await evaluate('library={};persist();settings={theme:"light",mode:"paged"};saveSettings()');
  await wait('document.querySelector(".archive-book.active img")?.naturalWidth>0');
  await screenshot('discover-mobile.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'mobile overflow');
  await evaluate('document.querySelector("[data-action=comic][data-id=\\"38\\"]")?.click()');
  await wait('document.querySelectorAll(".chapter-grid button").length>0');
  await wait('document.querySelector(".detail-cover")?.naturalWidth>0');
  await evaluate('document.querySelector("[data-action=favorite]").click()');
  await wait('document.querySelector("[data-action=favorite]")?.textContent.includes("已收藏")');
  await evaluate('document.querySelector("[data-cid=\\"7357\\"]").click()');
  await wait('document.querySelector(".page-image")?.naturalWidth>0',90000);
  assert.equal(await evaluate('reader.images.length'),15);
  await evaluate('document.querySelector("[data-action=next-page]").click()');
  await wait('document.querySelector(".page-image")?.naturalWidth>0');
  assert.equal(await evaluate('document.querySelector(".page-count").textContent'),'2/15');
  const beforeRetry=await evaluate('document.querySelector(".page-image").src');
  await evaluate('document.querySelector(".page-image").dispatchEvent(new Event("error"));document.querySelector(".retry:not(.refresh-chapter)").click()');
  const afterRetry=await evaluate('document.querySelector(".page-image").src');
  assert.notEqual(beforeRetry,afterRetry,'retry must request a fresh resource instead of reusing a failed URL');
  assert.equal(new URL(beforeRetry).searchParams.get('key'),new URL(afterRetry).searchParams.get('key'),'retry preserves the website signature');
  await wait('document.querySelector(".page-image")?.naturalWidth>0');
  await wait('!document.querySelector(".retry")');
  await evaluate('document.querySelector(".page-image").dispatchEvent(new Event("error"));document.querySelector(".refresh-chapter").click()');
  await wait('document.querySelector(".page-image")?.naturalWidth>0');
  assert.equal(await evaluate('reader.index'),1,'refresh chapter preserves reading page');
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:310,y:360}]});
  await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:140,y:360}]});
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await wait('reader?.index===2');
  await wait('document.querySelector(".page-image")?.naturalWidth>0');
  await screenshot('reader-mobile.png');
  await evaluate('goBack()');await wait('document.querySelector(".resume")?.textContent.includes("第 3 页")');
  await evaluate('goBack()');await wait('document.querySelector(".dock")');
  await evaluate('document.querySelector("[data-tab=shelf]").click()');
  await wait('document.querySelector(".archive-book.active .book-title")?.textContent.includes("一拳超人")');
  await screenshot('bookshelf-mobile.png');
  assert.equal(await evaluate('document.querySelectorAll(".archive-book").length'),1,'one favorite must produce one physical book');
  await evaluate('document.querySelector("[data-action=search]").click()');
  await wait('document.querySelector("#query")');
  await evaluate('document.querySelector("#query").value="一拳超人";document.querySelector("#search-form").requestSubmit()');
  await wait('document.querySelectorAll("#search-results .comic-card").length>0');
  assert.ok(await evaluate('document.querySelector("#search-results").textContent.includes("一拳超人")'));
  await screenshot('search-mobile.png');
  await evaluate('goBack()');await wait('document.querySelector(".dock")');
  await evaluate('document.querySelector("[data-tab=mine]").click()');
  await evaluate('document.querySelector("#theme-select").value="dark";document.querySelector("#theme-select").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.equal(await evaluate('document.documentElement.classList.contains("dark")'),true);
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'small-phone overflow');
  assert.deepEqual(errors,[],'browser exceptions');
  await evaluate('settings.theme="light";saveSettings();root("shelf")');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await screenshot('bookshelf-mobile.png');
  await call('Page.reload');
  await wait('document.querySelector(".archive-book.active")');
  assert.equal(await evaluate('library["38"].progress.index'),2,'reading progress survives reload');
  assert.equal(await evaluate('library["38"].favorite'),true,'favorite survives reload');
  console.log(fixtureImages?'PASS (fixture images, live website metadata): fresh image retry, signature preservation, chapter refresh at current page, paging, swipe, favorites and progress persistence. This does not verify online image availability or the native Android HTTP cache.':'PASS: live discovery, chapter list, favorite, 15-page chapter, image rendering, fresh retry, chapter refresh, paging, touch swipe, saved progress, unique shelf, Chinese search, dark theme, 320/390px layout and persistence across reload; no JS exceptions.');
  ws.close();
})().catch(e=>{console.error(e);process.exit(1);});
