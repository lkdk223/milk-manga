const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:9223/json')).json();
 const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map(),errors=[];
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
 ws.addEventListener('message',async e=>{
  const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}return;}
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
  if(m.method==='Fetch.requestPaused'){
   const body=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="210"><rect width="150" height="210" fill="#5e7977"/><text x="20" y="105" fill="white">TEST IMAGE</text></svg>').toString('base64');
   await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/svg+xml'}],body}).catch(()=>{});
  }
 });
 async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
 async function wait(expression){for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(80);}throw Error('Timed out: '+expression);}
 async function screenshot(name){const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(__dirname,name),Buffer.from(r.data,'base64'));}
 await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
 await call('Fetch.enable',{patterns:[{urlPattern:'https://cover.mangabz.com/*'},{urlPattern:'https://image.mangabz.com/*'},{urlPattern:'http://127.0.0.1:8766/local/*'}]});
 await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.Android={request(id){setTimeout(()=>window.__networkDone(id,{status:0,body:""}),0)}};'});
 await call('Page.navigate',{url:'http://127.0.0.1:8766/'});await wait('typeof renderRoot==="function"');
 // Parse captured real site pages using the app's actual DOM adapter and parser.
 await evaluate(`generation++;window.detailHTML=${JSON.stringify(fs.readFileSync(path.join(__dirname,'detail-live.html'),'utf8'))};window.catalogHTML=${JSON.stringify(fs.readFileSync(path.join(__dirname,'catalog-live.html'),'utf8'))};Network.get=async(url)=>({status:200,body:url.includes('manga-list')?catalogHTML:detailHTML});`);
 const info=await evaluate('(async()=>{const i=await source.comic.loadInfo("38");return {title:i.title,date:i.updateDate,latest:i.latestChapter,cid:i.latestChapterId,count:i.chapters.size}})()');
 assert.equal(info.title,'一拳超人');assert.equal(info.date,'10月22日');assert.ok(info.latest.includes('287'));assert.ok(info.count>20);
 assert.equal(await evaluate('Mangabz.updateDate("更新于2024-02-29")'),'2024年2月29日');
 assert.equal(await evaluate('Mangabz.updateDate("2025-02-29")'),'');assert.equal(await evaluate('Mangabz.updateDate("没有提供日期")'),'');
 const browse=await evaluate('(async()=>{window.browseURL="";Network.get=async url=>{browseURL=url;return {status:200,body:catalogHTML}};const r=await source.browse({genre:31,status:1,sort:2,page:1});return {url:browseURL,count:r.comics.length,next:r.hasNext}})()');
 assert.ok(browse.url.endsWith('/manga-list-31-1-2-p1/'));assert.equal(browse.count,12);assert.equal(browse.next,true);
 // Controlled catalog responses isolate UI behavior from intermittent site access.
 await evaluate(`generation++;library={};persist();window.browseCalls=[];window.rejectNext=false;window.slowRelease=null;
 window.mockComics=(page)=>Array.from({length:12},(_,i)=>({id:String((page-1)*12+i+1),title:'漫画 '+((page-1)*12+i+1),cover:'https://cover.mangabz.com/fixture-'+i+'.jpg'}));
 source.browse=async opts=>{browseCalls.push({...opts});if(rejectNext){rejectNext=false;throw Error('测试连接失败')}if(opts.genre===26)return new Promise(resolve=>{slowRelease=()=>resolve({comics:mockComics(2),hasNext:false})});return {comics:opts.genre===17?[]:mockComics(opts.page),hasNext:opts.page<3};};
 discoverCache=null;discoveryBusy=false;discoverPage=1;root('discover');`);
 await wait('discoverCache?.comics.length===12&&!discoveryBusy');assert.equal(await evaluate('browseCalls.at(-1).sort'),2);
 await evaluate('document.querySelector("[data-action=batch]").click()');await wait('discoverPage===2&&!discoveryBusy');assert.equal(await evaluate('discoverCache.comics[0].id'),'13');
 // A real emulated downward gesture refreshes the first/latest page.
 await evaluate('window.scrollTo(0,0)');
 await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:150}]});
 for(let y=175;y<=325;y+=25){await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:190,y}]});await delay(22);}
 await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait('discoverPage===1&&!discoveryBusy');
 // Failed refresh retains the currently visible recommendations.
 await evaluate('rejectNext=true;document.querySelector("[data-action=batch]").click()');await wait('!discoveryBusy');assert.equal(await evaluate('discoverCache.comics[0].id'),'1');
 await evaluate('document.querySelector("[data-tab=explore]").click()');await wait('exploreState.data?.comics.length===12');
 await evaluate('document.querySelector("#explore-genre").value="31";document.querySelector("#explore-genre").dispatchEvent(new Event("change",{bubbles:true}))');await wait('exploreState.data&&exploreState.genre===31');
 await evaluate('document.querySelector("#explore-status").value="1";document.querySelector("#explore-status").dispatchEvent(new Event("change",{bubbles:true}))');await wait('exploreState.data&&exploreState.status===1');
 await evaluate('document.querySelector("[data-mode=rank]").click()');await wait('document.querySelectorAll(".rank-badge").length===12');assert.equal(await evaluate('browseCalls.at(-1).sort'),10);
 await screenshot('explore-ranking-fixture.png');
 await evaluate('document.querySelector("[data-action=explore-next]").click()');await wait('document.querySelector(".rank-badge")?.textContent==="13"');
 await evaluate('changeExplore({genre:26,page:1})');await wait('typeof slowRelease==="function"');await evaluate('changeExplore({genre:31})');await wait('exploreState.data&&exploreState.genre===31');await evaluate('slowRelease()');await delay(100);assert.equal(await evaluate('exploreState.data.comics[0].id'),'1','stale filter response must not overwrite the current filter');
 await evaluate('changeExplore({genre:17})');await wait('exploreState.data?.comics.length===0');assert.ok(await evaluate('document.body.textContent.includes("这一分类暂无漫画")'));
 // Update dates come from the site, never the current check time. Failures keep old data.
 await evaluate(`library={"1":{...mockComics(1)[0],favorite:true,updated:5,checkedAt:Date.now(),progress:{cid:'1',index:2},latestChapter:'第1话',updateDate:'10月30日'},"2":{...mockComics(1)[1],favorite:true,updated:4,checkedAt:Date.now(),latestChapter:'旧章节',updateDate:'10月20日'}};
 source.comic.loadInfo=async id=>{if(id==='2')throw Error('测试失败');return {title:'漫画 1',cover:mockComics(1)[0].cover,chapters:new Map([['2','第2话']]),latestChapter:'第2话',latestChapterId:'2',updateDate:'11月1日'}};root('shelf');`);
 await evaluate('document.querySelector("[data-action=check-updates]").click()');await wait('!favoritesBusy');
 assert.equal(await evaluate('library["1"].updateDate'),'11月1日');assert.equal(await evaluate('library["1"].progress.index'),2);assert.equal(await evaluate('library["1"].updated'),5);
 assert.equal(await evaluate('library["2"].updateDate'),'10月20日');assert.ok(await evaluate('document.querySelector(".selection p").textContent.includes("11月1日")'));
 await screenshot('shelf-update-fixture.png');
 // A native-bridge double records actual image batches; the disk cache has its own JVM check.
 await evaluate(`settings.prefetch=true;chapterMemo.clear();window.epCalls=[];window.buffered=[];window.diskPages=new Set();window.failBuffer=false;
 Android.cancelPrefetch=token=>window.nativeToken=token;
 Android.cachedPages=raw=>JSON.parse(raw).filter(u=>diskPages.has(u)).length;
 Android.prefetchImages=(id,token,raw)=>{const urls=JSON.parse(raw);buffered.push(urls);if(!failBuffer)urls.forEach(u=>diskPages.add(u));setTimeout(()=>{window.__prefetchProgress(id,urls.length,urls.length);window.__prefetchDone(id,{done:failBuffer?0:urls.length,total:urls.length,cancelled:token!==nativeToken})},5)};
 source.comic.loadEp=async(book,cid)=>{epCalls.push(cid);return {images:[1,2].map(p=>'https://image.mangabz.com/fixture/'+cid+'/'+p+'.jpg?key=test')}};
 window.cacheRoute={type:'reader',comic:{id:'88',title:'预加载测试',cover:mockComics(1)[0].cover},cid:'1',name:'第1章',chapters:Array.from({length:8},(_,i)=>[String(i+1),'第'+(i+1)+'章']),index:0};navigate(cacheRoute);`);
 await wait('prefetchStatus==="后续 5 章已预加载"');
 assert.deepEqual(await evaluate('epCalls'),['1','2','3','4','5','6']);
 assert.deepEqual(await evaluate('buffered.map(urls=>urls[0].split("/").at(-2))'),['2','3','4','5','6']);
 await screenshot('reader-prefetch-fixture.png');
 await evaluate('changeChapter(1)');await wait('reader?.route.cid==="2"&&prefetchStatus==="后续 5 章已预加载"');
 assert.equal(await evaluate('epCalls.filter(c=>c==="2").length'),1,'Next chapter must reuse its loaded directory');
 assert.ok(await evaluate('epCalls.includes("7")&&!epCalls.includes("8")'),'Sliding window extends to chapter 7 only');
 await evaluate('changeChapter(1)');await wait('reader?.route.cid==="3"&&prefetchStatus==="后续 5 章已预加载"');
 assert.ok(await evaluate('epCalls.includes("8")'));
 await evaluate('navigate({...cacheRoute,cid:"7",name:"第7章"},true)');await wait('prefetchStatus==="后续 1 章已预加载"');
 await evaluate('changeChapter(1)');await wait('prefetchStatus==="已到最后一章"');
 await evaluate('failBuffer=true;diskPages.clear();navigate(cacheRoute,true)');await wait('prefetchStatus.includes("部分未完成")');
 assert.equal(await evaluate('prefetchStatus.startsWith("已缓冲 0/5")'),true);
 await evaluate('failBuffer=false;document.querySelector("#prefetch-status").click()');await wait('prefetchStatus==="后续 5 章已预加载"');
 // Daily invalidation cancels pending jobs and never deletes favorites or progress.
 const saved=await evaluate('JSON.stringify(library)');await evaluate('window.__onlineCacheCleared()');
 assert.equal(await evaluate('chapterMemo.size'),0);assert.equal(await evaluate('prefetchJobs.size'),0);assert.equal(await evaluate('JSON.stringify(library)'),saved);
 assert.ok(await evaluate('document.querySelector("#prefetch-status").textContent.includes("缓存已清理")'));
 await evaluate('window.beforeDisabled=buffered.length;settings.prefetch=false;navigate({...cacheRoute,cid:"2"},true)');await wait('prefetchStatus.includes("已关闭")');
 assert.equal(await evaluate('buffered.length===beforeDisabled'),true);
 // Leaving a reader while its metadata is still loading must not schedule stale image downloads.
 await evaluate(`settings.prefetch=true;chapterMemo.clear();window.releaseChapter=null;source.comic.loadEp=async(book,cid)=>cid==='2'?new Promise(resolve=>{releaseChapter=()=>resolve({images:['https://image.mangabz.com/stale/2.jpg']})}):{images:['https://image.mangabz.com/first/1.jpg']};navigate(cacheRoute,true);`);
 await wait('typeof releaseChapter==="function"');await evaluate('root("mine");window.buffersBefore=buffered.length;releaseChapter()');await delay(80);
 assert.equal(await evaluate('buffered.length===buffersBefore'),true);
 await screenshot('settings-cache-fixture.png');
 // Simulate the native file-picker result; actual Android import/rendering is separate.
 await evaluate(`library={};window.unexpectedNetwork=0;source.comic.loadInfo=async()=>{unexpectedNetwork++;throw Error('不可联网')};source.comic.loadEp=async()=>{unexpectedNetwork++;throw Error('不可联网')};
 Android.importLocal=()=>window.__localImported({id:'local-${'a'.repeat(32)}',title:'本地 PDF 测试',local:true,format:'pdf',pageCount:3,cover:location.origin+'/local/${'a'.repeat(32)}/0'});root('shelf');document.querySelector('[data-action=import-local]').click();`);
 await wait('document.querySelector(".selection h2")?.textContent==="本地 PDF 测试"');
 await evaluate('document.querySelector(".selection [data-action=comic]").click()');await wait('document.querySelector("[data-action=start]")');await evaluate('document.querySelector("[data-action=start]").click()');await wait('document.querySelector(".page-image")?.naturalWidth>0');
 assert.equal(await evaluate('reader.images.length'),3);assert.equal(await evaluate('reader.images.every(u=>u.startsWith(location.origin+"/local/"))'),true);
 await evaluate('document.querySelector("[data-action=next-page]").click()');await wait('document.querySelector(".page-count")?.textContent==="2/3"');assert.equal(await evaluate('unexpectedNetwork'),0);
 await evaluate('goBack()');await wait('document.querySelector(".resume")?.textContent.includes("第 2 页")');
 await call('Page.reload');await wait('typeof library!=="undefined"');assert.equal(await evaluate(`library['local-${'a'.repeat(32)}'].progress.index`),1);
 await call('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:true});await delay(100);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: real-page catalog/date parsing; categories/rank/filter pagination; stale-response guard; pull refresh and new batch; failed-refresh preservation; favorite dates/progress; 5-chapter image prefetch, sliding window, retries/cancellation and cache invalidation; offline local-book UI and persistence. File-picker/PDF rasterization not device-tested.');ws.close();
})().catch(e=>{console.error(e);process.exit(1);});
