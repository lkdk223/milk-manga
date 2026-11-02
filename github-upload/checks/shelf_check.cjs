// Deterministic interaction checks: local test covers, no manga network dependency.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const targets=await(await fetch('http://127.0.0.1:9223/json')).json();
  const target=targets.find(p=>p.type==='page');assert.ok(target);
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map(),errors=[];
  function call(method,params={}){return new Promise((resolve,reject)=>{let id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
  ws.addEventListener('message',async e=>{
    const m=JSON.parse(e.data);
    if(m.id){const r=pending.get(m.id);if(r){pending.delete(m.id);m.error?r.reject(Error(m.error.message)):r.resolve(m.result);}return;}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Fetch.requestPaused'){
      const colors=['#375d60','#7b5145','#6a7150','#615673','#a2784f','#435e7b','#7c465c'];
      const n=Number(/cover-(\d+)/.exec(m.params.request.url)?.[1]||0);
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="210"><rect width="150" height="210" fill="${colors[n%colors.length]}"/><circle cx="75" cy="88" r="44" fill="#ffffff19"/><path d="M15 160 L80 50 L135 160 Z" fill="#ffffff29"/><text x="15" y="190" fill="white" font-size="12">TEST COVER ${n+1}</text></svg>`;
      await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/svg+xml'}],body:Buffer.from(svg).toString('base64')}).catch(()=>{});
    }
  });
  async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
  async function wait(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(80);}throw Error('Timed out: '+expression);}
  async function snap(){await wait('Math.abs(document.querySelector(".books").scrollLeft/128-Math.round(document.querySelector(".books").scrollLeft/128))<.01');await delay(150);}
  async function shot(name){await delay(150);const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(__dirname,name),Buffer.from(r.data,'base64'));}
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  await call('Fetch.enable',{patterns:[{urlPattern:'https://cover.mangabz.com/*'}]});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.Android={request(id){setTimeout(()=>window.__networkDone(id,{status:0,body:""}),0)}};'});
  await call('Page.navigate',{url:'http://127.0.0.1:8766/'});
  await wait('typeof renderRoot==="function"');
  await evaluate(`generation++;discoverCache={comics:Array.from({length:7},(_,i)=>({id:String(100+i),title:['风与海的故事','长街书店','旅途的尽头','远山来信','白日星辰','森林纪事','第二个夏天'][i],cover:'https://cover.mangabz.com/cover-'+i+'.jpg'}))};current={type:'root',tab:'discover'};selected=2;remember(discoverCache.comics);renderRoot();`);
  await wait('document.querySelector(".archive-book.active img")?.naturalWidth>0');
  assert.equal(await evaluate('selected'),2);
  assert.ok(await evaluate('document.querySelector(".books").scrollWidth>document.querySelector(".books").clientWidth'));
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".books")).scrollSnapType'),'x mandatory');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".archive-book")).transformStyle'),'preserve-3d');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".book-pages")).transform'),'none');
  await evaluate('window.originalShelf=document.querySelector(".books");window.beforeTilt=getComputedStyle(document.querySelector(".archive-book.active")).transform');
  await shot('shelf-3d-mobile.png');
  // Observe an actual mid-scroll state, before snapping, without replacing nodes.
  await evaluate('document.querySelector(".books").classList.add("dragging");document.querySelector(".books").scrollLeft+=45');
  await delay(100);
  assert.notEqual(await evaluate('getComputedStyle(document.querySelectorAll(".archive-book")[2]).transform'),await evaluate('beforeTilt'));
  await shot('shelf-3d-between.png');
  await evaluate('document.querySelector(".books").classList.remove("dragging");scrollShelf(2)');await snap();
  // Simulated phone drag and release exercise native momentum plus scroll snap.
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:300,y:330}]});
  for(let x=280;x>=100;x-=30){await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:330}]});await delay(24);}
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await wait('selected>2');await snap();
  assert.equal(await evaluate('document.querySelector(".books")===originalShelf'),true,'drag must not rebuild the shelf');
  assert.equal(await evaluate('current.type'),'root','drag must not accidentally open a comic');
  assert.equal(await evaluate('document.querySelector(".selection h2").textContent===stageItems()[selected].title'),true);
  await shot('shelf-3d-after-swipe.png');
  await evaluate('scrollShelf(2)');await snap();
  // Desktop mouse dragging uses the same track, with click suppression.
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:295,y:335,button:'left',clickCount:1});
  for(let x=275;x>=100;x-=25){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:335,button:'left',buttons:1});await delay(20);}
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:100,y:335,button:'left',clickCount:1});
  await wait('selected>2');await snap();assert.equal(await evaluate('current.type'),'root');
  // Keyboard and pager buttons retain the same geometry and selection state.
  await evaluate('scrollShelf(0)');await snap();
  await evaluate('document.querySelector("[data-action=shelf-next]").click()');await wait('selected===1');await snap();
  await evaluate('document.querySelector(".books").focus()');
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await wait('selected===2');await snap();
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:true});
  await delay(200);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  // A one-book collection stays centered and does not invent duplicate books.
  await evaluate('library={100:{...discoverCache.comics[0],favorite:true}};current={type:"root",tab:"shelf"};selected=0;renderRoot()');
  assert.equal(await evaluate('document.querySelectorAll(".archive-book").length'),1);
  assert.equal(await evaluate('document.querySelector(".books").scrollWidth===document.querySelector(".books").clientWidth'),true);
  assert.equal(await evaluate('document.querySelector("[data-action=shelf-next]").disabled'),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: true 3D faces; continuous scroll transforms; touch drag and snap; mouse drag; click suppression; pager/keyboard selection; 320px layout; single-book bounds. Test covers are fixtures; no network availability claim.');
  ws.close();
})().catch(e=>{console.error(e);process.exit(1);});
