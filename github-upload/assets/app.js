'use strict';
const paths = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  book:'<path d="M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15"/>',
  home:'<path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  back:'<path d="m14 5-7 7 7 7M7 12h14"/>',
  right:'<path d="m9 5 7 7-7 7"/>',
  left:'<path d="m15 5-7 7 7 7"/>',
  arrow:'<path d="M6 18 18 6M7 6h11v11"/>',
  heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  shelf:'<path d="M4 3v18M20 3v18M3 20h18M7 6v11M11 3v14M15 5l3 12"/>',
  mode:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  more:'<path d="M5 7h14M5 12h14M5 17h14"/>',
};
const icon = (name, cls='') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
let library = stored('milk-library', {});
if (!library || Array.isArray(library) || typeof library !== 'object') library = {};
let settings = stored('milk-settings', {theme:'light', mode:'paged'});
if (!settings || typeof settings !== 'object') settings = {theme:'light', mode:'paged'};
let pending = new Map(), requestId = 0;
window.__networkDone = (id, result) => { const entry=pending.get(id); if(entry) {clearTimeout(entry.timer);pending.delete(id);entry.resolve(result);} };
const Network = {
  async get(url, headers={}) {
    const once=()=>new Promise((resolve,reject)=> {
    const id=String(++requestId);
    if (!window.Android) { reject(new Error('网络桥接未连接')); return; }
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('连接超时，请重试'));},40000);
    pending.set(id,{resolve,timer});
    try { Android.request(id,url,JSON.stringify(headers)); } catch(e) {clearTimeout(timer);pending.delete(id);reject(e);}
    });
    const result=await once();
    if(result.status!==0)return result;
    await new Promise(resolve=>setTimeout(resolve,600));
    return once();
  },
};
// Browser DOM implements the small ComicSource API used by the upstream parser.
class HtmlElement {
  constructor(el) { this.el=el; }
  get text() { return this.el.textContent; }
  get attributes() { return Object.fromEntries(Array.from(this.el.attributes,a=>[a.name,a.value])); }
  querySelector(q) { const e=this.el.querySelector(q);return e ? new HtmlElement(e) : null; }
  querySelectorAll(q) { return Array.from(this.el.querySelectorAll(q),e=>new HtmlElement(e)); }
}
class HtmlDocument extends HtmlElement { constructor(html) {super(new DOMParser().parseFromString(html,'text/html'));} }
const source = new Mangabz();
const app=document.getElementById('app');
let current={type:'root',tab:'discover'}, history=[], generation=0, selected=0, gridShelf=false;
let discoverCache=null, reader=null, sortDescending=false, toastTimer;
// Chapter directories stay in memory; actual image bytes share the native disk cache.
const chapterMemo=new Map(),prefetchJobs=new Map();
let prefetchToken=0,prefetchId=0,prefetchStatus='';
function prefetchLabel(text){prefetchStatus=text;const el=document.getElementById('prefetch-status');if(el)el.textContent=text;}
function stopPrefetch(){
  prefetchToken++;window.Android?.cancelPrefetch?.(prefetchToken);
  for(const job of prefetchJobs.values()){clearTimeout(job.timer);job.resolve({cancelled:true});}
  prefetchJobs.clear();prefetchStatus='';
}
window.__prefetchProgress=(id,done,total)=>{const job=prefetchJobs.get(id);if(job&&job.token===prefetchToken)prefetchLabel(`正在缓冲后续第 ${job.chapter} 章 · ${done}/${total} 页`);};
window.__prefetchDone=(id,result)=>{const job=prefetchJobs.get(id);if(job){clearTimeout(job.timer);prefetchJobs.delete(id);job.resolve(result);}};
window.__onlineCacheCleared=()=>{stopPrefetch();chapterMemo.clear();prefetchLabel('在线缓存已清理 · 下次切章继续预加载');};
function chapterKey(route){return route.comic.id+':'+route.cid;}
function chapterImages(route){
  const key=chapterKey(route);
  if(chapterMemo.has(key))return chapterMemo.get(key);
  const request=source.comic.loadEp(route.comic.id,route.cid).catch(e=>{if(chapterMemo.get(key)===request)chapterMemo.delete(key);throw e;});
  chapterMemo.set(key,request);return request;
}
function bufferImages(images,token,chapter){
  return new Promise(resolve=>{
    const id=String(++prefetchId);
    const timer=setTimeout(()=>{prefetchJobs.delete(id);resolve({done:0,total:images.length});},20*60*1000);
    prefetchJobs.set(id,{resolve,timer,token,chapter});
    try{Android.prefetchImages(id,token,JSON.stringify(images));}
    catch(_){clearTimeout(timer);prefetchJobs.delete(id);resolve({done:0,total:images.length});}
  });
}
async function startPrefetch(route){
  if(route.comic.local){prefetchLabel('本地漫画 · 无需联网缓冲');return;}
  if(settings.prefetch===false){prefetchLabel('后续章节预加载已关闭');return;}
  if(!window.Android?.prefetchImages){prefetchLabel('请在安卓客户端中使用章节预加载');return;}
  const token=prefetchToken,at=route.chapters.findIndex(([cid])=>cid===route.cid);
  const next=route.chapters.slice(at+1,at+6);
  const keep=new Set([chapterKey(route),...next.map(([cid])=>route.comic.id+':'+cid)]);
  for(const key of chapterMemo.keys())if(!keep.has(key))chapterMemo.delete(key);
  if(!next.length){prefetchLabel('已到最后一章');return;}
  let complete=0,failed=0;const bufferedChapters=[];
  for(let i=0;i<next.length;i++){
    if(token!==prefetchToken)return;
    prefetchLabel(`正在获取后续第 ${i+1}/${next.length} 章`);
    try{
      const result=await chapterImages({...route,cid:next[i][0]});
      if(token!==prefetchToken)return;
      const buffered=await bufferImages(result.images,token,i+1);
      if(token!==prefetchToken||buffered.cancelled)return;
      if(buffered.total>0&&buffered.done===buffered.total){complete++;bufferedChapters.push(result.images);}
      else {failed++;chapterMemo.delete(route.comic.id+':'+next[i][0]);} // Renew possibly expired CDN signatures on retry.
    }catch(_){if(token!==prefetchToken)return;failed++;}
  }
  // Large volumes may exceed the disk ceiling; do not report evicted chapters as ready.
  if(window.Android?.cachedPages)for(const images of bufferedChapters)if(Android.cachedPages(JSON.stringify(images))!==images.length){complete--;failed++;}
  prefetchLabel(failed?`已缓冲 ${complete}/${next.length} 章 · 部分未完成，可点此重试`:`后续 ${complete} 章已预加载`);
}
let discoverPage=1,discoveryBusy=false,discoveryError='',favoritesBusy=false;
let exploreState={genre:0,status:0,sort:10,page:1,ranking:false,data:null,error:''};
function updateLabel(c) {
  if(c?.local)return `本地${c.format==='pdf'?' PDF':''}漫画 · ${c.pageCount||0} 页`;
  if(!c?.latestChapter)return '尚未检查最新章节';
  return `${c.latestChapter} · ${c.updateDate?c.updateDate+'更新':'网站未提供更新日期'}`;
}
function localImage(id,index){if(!/^local-[a-f0-9]{32}$/.test(id))throw new Error('本地漫画记录无效');return `${location.origin}/local/${id.slice(6)}/${index}`;}
function localInfo(c){if(!Number.isInteger(c.pageCount)||c.pageCount<1||c.pageCount>5000)throw new Error('本地漫画页数无效');return {...c,chapters:new Map([['local',`本地漫画 · ${c.pageCount} 页`]])};}
window.__localImportStatus=message=>{toast(message);document.querySelectorAll('[data-action=import-local]').forEach(b=>{b.disabled=true;b.textContent='正在导入…';});};
window.__localImportCancelled=()=>document.querySelectorAll('[data-action=import-local]').forEach(b=>{b.disabled=false;b.textContent='导入本地';});
window.__localImportFailed=message=>{window.__localImportCancelled();toast(message);};
window.__localImported=book=>{
  try{localInfo(book);localImage(book.id,0);library[book.id]={...book,favorite:true,updated:Date.now()};persist();remember([book]);root('shelf');toast(`已导入 ${book.pageCount} 页，可离线阅读`);}
  catch(e){window.__localImportFailed(errorText(e));}
};
function applyBookUpdate(id,info) {
  if(!library[id]||library[id].local)return;
  library[id]={...library[id],title:info.title,cover:info.cover,latestChapter:info.latestChapter||'',latestChapterId:info.latestChapterId||'',updateDate:info.updateDate||'',checkedAt:Date.now()};
}
function updateShelfLabels(text) {
  const status=document.getElementById('shelf-status');if(status&&text)status.textContent=text;
  const button=document.querySelector('[data-action=check-updates]');if(button)button.disabled=favoritesBusy;
  if(current.type==='root'&&current.tab==='shelf'){
    const c=stageItems()[selected],label=document.querySelector('.selection p');if(c&&label)label.textContent=updateLabel(c);
    document.querySelectorAll('[data-update-id]').forEach(el=>{const c=library[el.dataset.updateId];if(c)el.textContent=updateLabel(c);});
  }
}
async function refreshFavorites(force=false) {
  if(favoritesBusy)return;
  const books=Object.values(library).filter(c=>c.favorite&&!c.local&&(force||!c.checkedAt||Date.now()-c.checkedAt>30*60*1000));
  if(!books.length){if(force)toast('没有需要检查的在线收藏');return;}
  favoritesBusy=true;let cursor=0,done=0,failed=0;
  updateShelfLabels(`正在检查 0/${books.length}`);
  async function worker(){while(cursor<books.length){const c=books[cursor++];try{const info=await source.comic.loadInfo(c.id);applyBookUpdate(c.id,info);}catch(_){failed++;}done++;updateShelfLabels(`正在检查 ${done}/${books.length}`);}}
  try{await Promise.all([worker(),worker()]);persist();}
  finally{favoritesBusy=false;updateShelfLabels(failed?`${failed} 部检查失败，保留上次记录`:`已检查 ${done} 部在线收藏`);}
  if(force)toast(failed?'部分漫画检查失败，可稍后重试':'最新章节已更新');
}
async function refreshDiscovery(batch=false,quiet=false) {
  if(discoveryBusy)return;
  const token=generation,page=batch?(discoverCache?.hasNext===false?1:discoverPage+1):1;
  discoveryBusy=true;discoveryError='';renderRoot();
  try{
    const data=await source.browse({sort:2,page});
    if(token!==generation)return;
    if(!data.comics.length)throw new Error('这一页暂无漫画，请稍后重试');
    const same=discoverCache?.comics.map(c=>c.id).join(',')===data.comics.map(c=>c.id).join(',');
    remember(data.comics);discoverCache=data;discoverPage=page;selected=0;
    if(!quiet)toast(batch?'已换一批漫画':same?'已刷新，暂时没有新更新':'已获取最新更新');
  }catch(e){if(token===generation){discoveryError=errorText(e);if(discoverCache)toast('刷新失败，保留当前漫画');}}
  finally{
    discoveryBusy=false;
    if(current.type==='root'&&current.tab==='discover'){
      if(token===generation)renderRoot();
      else {const indicator=document.querySelector('.pull-indicator');if(indicator){indicator.style.height='0px';indicator.textContent='';}const button=document.querySelector('[data-action=batch]');if(button)button.disabled=false;}
    }
  }
}
function mountPullRefresh(){
  if(current.tab!=='discover')return;
  const screen=document.querySelector('.screen'),indicator=document.querySelector('.pull-indicator');if(!screen||!indicator)return;
  let start=null,distance=0,suppressUntil=0;
  screen.addEventListener('touchstart',e=>{start=!discoveryBusy&&e.touches.length===1&&window.scrollY<=1&&!e.target.closest('input,select,nav')?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;distance=0;},{passive:true});
  screen.addEventListener('touchmove',e=>{
    if(!start||e.touches.length!==1)return;
    const dx=e.touches[0].clientX-start.x,dy=e.touches[0].clientY-start.y;
    if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)){start=null;return;}
    if(dy>10&&dy>Math.abs(dx)*1.5&&window.scrollY<=1){e.preventDefault();distance=Math.min(90,dy*.5);indicator.style.height=distance+'px';indicator.textContent=distance>=58?'松开刷新':'下拉刷新';}
  },{passive:false});
  function end(){const ready=distance>=58;if(distance>10)suppressUntil=performance.now()+400;start=null;distance=0;indicator.style.height='0px';if(ready)refreshDiscovery(false);}
  screen.addEventListener('touchend',end,{passive:true});screen.addEventListener('touchcancel',()=>{start=null;distance=0;indicator.style.height='0px';},{passive:true});
  screen.addEventListener('click',e=>{if(performance.now()<suppressUntil){e.preventDefault();e.stopPropagation();}},true);
}
function exploreMarkup(){
  const s=exploreState,data=s.data;
  const options=(values,current)=>values.map(([v,label])=>`<option value="${v}" ${v===current?'selected':''}>${label}</option>`).join('');
  return `<div class="screen">${header('探索','EXPLORE / MANGABZ')}<div class="tabs"><button class="chip ${!s.ranking?'active':''}" data-action="explore-mode" data-mode="browse">分类探索</button><button class="chip ${s.ranking?'active':''}" data-action="explore-mode" data-mode="rank">排行榜</button></div><div class="explore-filters glass"><label>题材<select id="explore-genre">${options(Mangabz.genres,s.genre)}</select></label><label>状态<select id="explore-status">${options([[0,'全部'],[1,'连载中'],[2,'已完结']],s.status)}</select></label>${!s.ranking?`<label>排序<select id="explore-sort">${options([[10,'人气'],[2,'最新更新']],s.sort)}</select></label>`:''}</div><div class="section code">${s.ranking?'人气榜 · 按网站人气排序':'分类浏览'} · 第 ${s.page} 页</div>${data?`<div class="grid ${s.ranking?'rank-grid':''}">${data.comics.map((c,i)=>s.ranking?`<div class="rank-entry"><span class="rank-badge">${(s.page-1)*12+i+1}</span>${card(c)}</div>`:card(c)).join('')}</div>${!data.comics.length?empty('这一分类暂无漫画','试试其他题材或状态。','explore-reset','查看全部'):''}<div class="pager"><button data-action="explore-prev" ${s.page===1?'disabled':''} aria-label="上一页">${icon('left')}</button><span class="code">第 ${s.page} 页</span><button data-action="explore-next" ${!data.hasNext?'disabled':''} aria-label="下一页">${icon('right')}</button></div>`:s.error?empty('探索暂时没有打开',s.error,'explore-retry','重试'):loading('正在寻找漫画…')}${dock('explore')}</div>`;
}
async function loadExplore(){
  if(exploreState.data)return;
  const state=exploreState,token=generation;
  try{const data=await source.browse({genre:state.genre,status:state.status,sort:state.ranking?10:state.sort,page:state.page});if(token!==generation||exploreState!==state)return;remember(data.comics);state.data=data;}
  catch(e){if(token!==generation||exploreState!==state)return;state.error=errorText(e);}
  if(token===generation&&current.type==='root'&&current.tab==='explore')renderRoot();
}
function changeExplore(changes){exploreState={...exploreState,...changes,data:null,error:''};render(current,++generation);}
function toast(text) { const el=document.getElementById('toast');el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2400); }
function persist() { try {localStorage.setItem('milk-library',JSON.stringify(library));}catch(_){toast('本地保存失败，设备存储空间可能不足');} }
function saveSettings() {try{localStorage.setItem('milk-settings',JSON.stringify(settings));}catch(_){toast('设置保存失败');}document.documentElement.classList.toggle('dark',settings.theme==='dark');}
function loading(message='正在整理书架…') {return `<div class="loading"><div class="spinner"></div>${esc(message)}</div>`;}
function empty(title, description, action='discover', label='去发现漫画') {return `<div class="empty">${icon('book','empty-icon')}<h2>${esc(title)}</h2><p>${esc(description)}</p><button class="primary" data-action="${action}">${esc(label)}</button></div>`;}
function header(title, code, back=false) {return `<header class="masthead">${back?`<button class="icon-button" data-action="back" aria-label="返回">${icon('back')}</button>`:`<span class="brand"><img src="app-icon.png" alt="漫架图标"></span>`}<div><h1>${esc(title)}</h1><div class="code">${esc(code)}</div></div><span class="spacer"></span>${!back?`<button class="icon-button" data-action="search" aria-label="搜索漫画">${icon('search')}</button>`:''}</header>`;}
function dock(tab) {return `<nav class="dock glass" aria-label="主要导航">${[['discover','home','发现'],['explore','grid','探索'],['shelf','book','书架'],['mine','user','我的']].map(([id,i,label])=>`<button class="${tab===id?'active':''}" data-action="tab" data-tab="${id}" ${tab===id?'aria-current="page"':''}>${icon(i)}<span>${label}</span></button>`).join('')}</nav>`;}
function section(code,title,extra='') {return `<div class="section"><div class="section-label"><span class="code">${code}</span></div><div class="section-title"><h2>${title}</h2>${extra}</div></div>`;}
function comicData(c) {return {id:String(c.id),title:c.title,cover:c.cover,...(c.local?{local:true,pageCount:c.pageCount,format:c.format}:{})};}
function card(c) {return `<button class="comic-card" data-action="comic" data-id="${esc(c.id)}" aria-label="${esc(c.title)}"><div class="cover"><img src="${esc(c.cover)}" alt="${esc(c.title)}封面" loading="lazy" referrerpolicy="no-referrer"></div><h3>${esc(c.title)}</h3><div class="code">${c.local?'LOCAL':'MZ-'+esc(c.id).padStart(5,'0')}</div><p class="update-meta" data-update-id="${esc(c.id)}">${library[c.id]?.favorite?esc(updateLabel(library[c.id])):''}</p></button>`;}
const items=new Map();
function remember(list) {list.forEach(c=>items.set(String(c.id),comicData(c)));return list;}
function stage(list) {
  if(!list.length)return '';
  selected=Math.min(selected,list.length-1);
  return `<div class="archive-stage"><div class="books" tabindex="0" aria-label="左右滑动浏览书架">${list.map((c,index)=>
    `<div class="book-slot"><button class="archive-book ${index===selected?'active':''}" data-action="select-book" data-index="${index}" aria-label="${esc(c.title)}"><span class="front"><span class="code">NO.${String(index+1).padStart(3,'0')}</span><img src="${esc(c.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="book-title">${esc(c.title)}</span><span class="book-code">MZ-${esc(c.id).padStart(5,'0')}　↗</span></span><span class="spine"><span class="number">${String(index+1).padStart(2,'0')}</span><span class="vertical">${esc(c.title)}</span><span class="circle">○</span></span><span class="book-back"></span><span class="book-pages"></span><span class="book-top"></span><span class="book-bottom"></span></button></div>`
  ).join('')}</div></div><div class="selection"><div><h2>${esc(list[selected].title)}</h2><p>${current.tab==='shelf'?'收藏于你的书架':'Mangabz · 精选漫画'}</p></div><span class="spacer"></span><button class="icon-button" data-action="comic" data-id="${esc(list[selected].id)}" aria-label="打开漫画">${icon('arrow')}</button></div><div class="pager"><button data-action="shelf-prev" aria-label="上一本">${icon('left')}</button><span class="code">${String(selected+1).padStart(2,'0')} / ${String(list.length).padStart(2,'0')}</span><button data-action="shelf-next" aria-label="下一本">${icon('right')}</button></div>`;
}
function scrollShelf(index) {
  const track=document.querySelector('.books');if(!track)return;
  const list=stageItems();index=Math.max(0,Math.min(index,list.length-1));
  const slot=track.querySelector('.book-slot');if(!slot)return;
  track.scrollTo({left:index*slot.offsetWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function mountShelf() {
  const track=document.querySelector('.books');if(!track)return;
  const slots=Array.from(track.children), list=stageItems();
  let frame=0, dragging=null, suppressClickUntil=0;
  function paint() {
    frame=0;if(!track.isConnected)return;
    const width=slots[0].offsetWidth, position=track.scrollLeft/width;
    selected=Math.max(0,Math.min(list.length-1,Math.round(position)));
    slots.forEach((slot,index)=>{
      const book=slot.firstElementChild, d=index-position, distance=Math.min(3,Math.abs(d));
      book.style.setProperty('--yaw',`${-18-Math.max(-1.2,Math.min(1.2,d))*44}deg`);
      book.style.setProperty('--lift',`${distance*22}px`);
      book.style.setProperty('--scale',String(1-distance*.12));
      slot.style.zIndex=String(100-Math.round(Math.abs(d)*10));
      book.classList.toggle('active',index===selected);
      book.setAttribute('aria-pressed',String(index===selected));
    });
    const selection=document.querySelector('.selection');
    selection.querySelector('h2').textContent=list[selected].title;
    selection.querySelector('[data-action=comic]').dataset.id=list[selected].id;
    selection.querySelector('p').textContent=current.tab==='shelf'?updateLabel(list[selected]):'Mangabz · 精选漫画';
    document.querySelector('.pager .code').textContent=`${String(selected+1).padStart(2,'0')} / ${String(list.length).padStart(2,'0')}`;
    document.querySelector('[data-action=shelf-prev]').disabled=selected===0;
    document.querySelector('[data-action=shelf-next]').disabled=selected===list.length-1;
  }
  track.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(paint);},{passive:true});
  track.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button===0)dragging={id:e.pointerId,x:e.clientX,start:track.scrollLeft,moved:false};});
  track.addEventListener('pointermove',e=>{
    if(!dragging||e.pointerId!==dragging.id)return;
    const dx=e.clientX-dragging.x;
    if(Math.abs(dx)>6&&!dragging.moved){dragging.moved=true;track.classList.add('dragging');track.setPointerCapture(e.pointerId);}
    if(dragging.moved){e.preventDefault();track.scrollLeft=dragging.start-dx;}
  });
  function release(e){if(!dragging||e.pointerId!==dragging.id)return;const moved=dragging.moved;dragging=null;track.classList.remove('dragging');if(moved){suppressClickUntil=performance.now()+350;scrollShelf(Math.round(track.scrollLeft/slots[0].offsetWidth));}}
  track.addEventListener('pointerup',release);track.addEventListener('pointercancel',release);
  track.addEventListener('click',e=>{if(performance.now()<suppressClickUntil){e.preventDefault();e.stopPropagation();}},true);
  track.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();scrollShelf(selected+(e.key==='ArrowRight'?1:-1));}});
  track.scrollLeft=selected*slots[0].offsetWidth;paint();
}
function shelfItems() {return remember(Object.values(library).filter(c=>c.favorite).sort((a,b)=>(b.updated||0)-(a.updated||0)));}
function stageItems() {return current.tab==='shelf'?shelfItems():discoverCache?.comics.slice(0,10)||[];}
function renderRoot() {
  reader=null;
  const tab=current.tab;
  if(tab==='explore'){app.innerHTML=exploreMarkup();return;}
  if(tab==='mine') {
    const recent=remember(Object.values(library).filter(c=>c.progress).sort((a,b)=>(b.updated||0)-(a.updated||0)));
    app.innerHTML=`<div class="screen">${header('我的','MY / READING ARCHIVE')}<div class="account-card glass"><span class="code">KEEP YOUR STORIES CLOSE</span><h2 style="margin-top:10px">把故事，留在手边。</h2><p>已收藏 ${shelfItems().length} 部漫画 · 阅读过 ${recent.length} 部<br>记录保存在这台手机上。</p></div><div class="account-card glass"><label class="setting-row">界面配色<select id="theme-select"><option value="light" ${settings.theme!=='dark'?'selected':''}>奶白玻璃</option><option value="dark" ${settings.theme==='dark'?'selected':''}>深色玻璃</option></select></label><label class="setting-row">阅读方式<select id="mode-select"><option value="paged" ${settings.mode!=='scroll'?'selected':''}>左右翻页</option><option value="scroll" ${settings.mode==='scroll'?'selected':''}>纵向连续</option></select></label><label class="setting-row">提前缓冲后续 5 章<select id="prefetch-select"><option value="on" ${settings.prefetch!==false?'selected':''}>开启</option><option value="off" ${settings.prefetch===false?'selected':''}>关闭</option></select></label><p>预加载会使用当前网络，在线图片缓存最多 512 MiB。每天凌晨 03:00 自动清理，系统休眠时可能延后；下次打开会补清理。收藏、进度和导入的本地漫画会保留。</p></div>${section('01 / HISTORY','最近阅读')}<div class="grid">${recent.slice(0,12).map(card).join('')}</div><div class="footer">漫架 0.3.0 · Mangabz 阅读客户端<br>界面参考轻小说文库的书架与玻璃风格<br>漫画内容来自原网站，版权归各自权利人所有。</div>${dock(tab)}</div>`;
    return;
  }
  if(tab==='shelf') {
    const list=shelfItems();
    app.innerHTML=`<div class="screen">${header('书架','LIBRARY / YOUR COLLECTION')}<div class="shelf-tools"><button class="chip glass" data-action="import-local">导入本地</button><button class="chip glass" data-action="check-updates" ${favoritesBusy?'disabled':''}>检查更新</button><span id="shelf-status" class="muted">${favoritesBusy?'正在检查…':'更新日期以网站为准'}</span></div>${section('01 / COLLECTION',`收藏 · ${list.length}`,`<button class="icon-button" data-action="shelf-view" aria-label="切换书架视图">${icon(gridShelf?'shelf':'grid')}</button>`)}${list.length?(gridShelf?`<div class="grid">${list.map(card).join('')}</div>`:stage(list)):empty('书架，等一本喜欢的漫画。','收藏在线漫画，或导入本地图片、漫画包和 PDF。','import-local','导入本地漫画')}<div class="footer code">YOUR OWN LITTLE READING ARCHIVE</div>${dock(tab)}</div>`;
    mountShelf();updateShelfLabels();return;
  }
  app.innerHTML=`<div class="screen">${header('漫架','MANGABZ / READING ARCHIVE')}<div class="pull-indicator" role="status" style="height:${discoveryBusy?'32':'0'}px">${discoveryBusy?'正在刷新…':''}</div>${section('01 / CATALOG','今日翻阅',`<button class="chip" data-action="batch" ${discoveryBusy?'disabled':''}>换一批</button>`)}<div id="catalog">${discoverCache?stage(discoverCache.comics.slice(0,10))+section('02 / DISCOVER','最新更新',`<button class="icon-button" data-action="refresh" aria-label="刷新最新更新">${icon('more')}</button>`)+`<div class="grid">${discoverCache.comics.map(card).join('')}</div>`:discoveryError?empty('书架暂时没能打开',discoveryError,'refresh','重试'):loading()}</div>${dock(tab)}</div>`;
  mountShelf();mountPullRefresh();
}
async function render(route, token) {
  saveSettings();
  if(route.type==='root') {
    renderRoot();
    if(route.tab==='discover'&&!discoverCache)await refreshDiscovery(false,true);
    if(route.tab==='explore')await loadExplore();
    if(route.tab==='shelf')await refreshFavorites(false);
    return;
  }
  if(route.type==='search') {
    app.innerHTML=`<div class="screen">${header('搜索','SEARCH / MANGABZ',true)}<form class="search-form glass" id="search-form"><input id="query" value="${esc(route.query||'')}" placeholder="搜索漫画或作者" autocomplete="off" aria-label="搜索漫画或作者"><button type="submit" aria-label="搜索">${icon('search')}</button></form><div id="search-results">${route.query?loading('正在找寻故事…'):empty('下一本，会是什么故事？','输入漫画名或作者，搜索 Mangabz。','focus-search','输入关键词')}</div></div>`;
    if(route.query)try {
      const data=await source.search.load(route.query,[],route.page||1);if(token!==generation)return;
      remember(data.comics);
      document.getElementById('search-results').innerHTML=data.comics.length?`<div class="section code">PAGE ${route.page||1} · ${data.comics.length} TITLES</div><div class="grid">${data.comics.map(card).join('')}</div><div class="pager"><button data-action="search-prev" ${(route.page||1)===1?'disabled':''} aria-label="上一页">${icon('left')}</button><span class="code">第 ${route.page||1} 页</span><button data-action="search-next" aria-label="下一页">${icon('right')}</button></div>`:empty('没有找到相关漫画','换一个关键词再试试。','focus-search','重新搜索');
    } catch(e){if(token===generation)document.getElementById('search-results').innerHTML=empty('搜索暂时失败',errorText(e),'retry','重试');}
    return;
  }
  if(route.type==='detail') {
    app.innerHTML=`<div class="screen">${header('漫画档案','COMIC / MANGABZ',true)}${loading('正在打开目录…')}</div>`;
    try {
      const info=route.info || (library[route.id]?.local?localInfo(library[route.id]):await source.comic.loadInfo(route.id));if(token!==generation)return;
      route.info=info;const c=comicData({id:route.id,...info});remember([c]);route.comic=c;
      if(library[c.id]){applyBookUpdate(c.id,info);persist();}
      let chapters=Array.from(info.chapters);route.chapters=chapters;
      const record=library[c.id],progress=record?.progress;
      if(sortDescending)chapters=chapters.slice().reverse();
      app.innerHTML=`<div class="screen">${header('漫画档案',`MZ-${c.id.padStart(5,'0')}`,true)}<div class="detail-hero"><img class="detail-cover" src="${esc(c.cover)}" alt="${esc(c.title)}封面" referrerpolicy="no-referrer"><div class="detail-meta"><span class="code">MANGABZ / COMIC</span><h1 style="margin-top:9px">${esc(c.title)}</h1><p class="muted">共 ${chapters.length} 个章节<br>${esc(updateLabel(info))}</p></div></div><div class="detail-actions"><button class="primary" data-action="start">${icon('book')}${progress?'继续阅读':'开始阅读'}</button><button class="secondary glass" data-action="favorite">${icon('heart')}${record?.favorite?'已收藏':'加入书架'}</button></div>${progress?`<p class="resume">上次读到 ${esc(progress.name)} · 第 ${progress.index+1} 页</p>`:''}${section('01 / CHAPTERS','章节目录',`<button class="icon-button" data-action="sort" aria-label="切换目录顺序">${icon('more')}</button>`)}<div class="chapter-grid">${chapters.map(([cid,name])=>`<button class="${progress?.cid===cid?'read':''}" data-action="chapter" data-cid="${esc(cid)}">${esc(name)}</button>`).join('')}</div></div>`;
    }catch(e){if(token===generation)app.innerHTML=`<div class="screen">${header('漫画档案','COMIC / MANGABZ',true)}${empty('暂时没能打开漫画',errorText(e),'retry','重试')}</div>`;}
    return;
  }
  if(route.type==='reader') {
    app.innerHTML=`<div class="reader">${loading('正在加载漫画，请稍候…')}<div class="reader-notice">章节较长时，图片目录需要一点时间。</div><div style="text-align:center"><button class="secondary" data-action="back">返回目录</button></div></div>`;
    try {
      const result=route.comic.local?{images:Array.from({length:route.comic.pageCount},(_,i)=>localImage(route.comic.id,i))}:await chapterImages(route);if(token!==generation)return;
      if(!result.images.length)throw new Error('这一章节暂时没有可用图片');
      reader={route,images:result.images,index:Math.min(route.index||0,result.images.length-1)};
      paintReader();saveProgress();startPrefetch(route);
    } catch(e){if(token===generation)app.innerHTML=`<div class="reader">${empty('图片加载失败',errorText(e),'retry','重试')}<div style="text-align:center"><button class="secondary" data-action="back">返回目录</button></div></div>`;}
  }
}
function errorText(e){const text=String(e?.message||e);if(/403|429/.test(text))return '网站暂时拒绝了请求，请稍后重试。';if(/Invalid status/.test(text))return '连接暂时中断，请检查网络后重试。';return /No images|missing chapter/.test(text)?'这个章节的图片暂时不可用，请换一章或稍后重试。':text.replace(/https?:\/\/\S+/g,'').slice(0,120);}
function navigate(route,replace=false) {
  saveProgress();
  stopPrefetch();
  if(!replace)history.push({...current,scroll:window.scrollY});
  current=route;reader=null;window.scrollTo(0,0);render(current,++generation);
}
window.goBack=function(){saveProgress();if(!history.length)return false;stopPrefetch();const previous=history.pop();current=previous;reader=null;render(current,++generation).then(()=>window.scrollTo(0,previous.scroll||0));return true;};
function root(tab) {saveProgress();history=[];selected=0;navigate({type:'root',tab},true);}
function showComic(id){navigate({type:'detail',id:String(id)});}
function openChapter(cid,index=0) {
  const r=current;const pair=r.chapters.find(([id])=>id===cid);if(!pair)return;
  navigate({type:'reader',cid,name:pair[1],comic:r.comic,chapters:r.chapters,index});
}
window.saveProgress=function() {
  if(!reader)return;
  const {route,index}=reader,id=route.comic.id;
  library[id]={...library[id],...route.comic,updated:Date.now(),progress:{cid:route.cid,name:route.name,index}};persist();
};
function imageTag(url,index){return `<div class="image-wrap" data-page="${index}"><img class="page-image" src="${esc(url)}" alt="第 ${index+1} 页" ${settings.mode==='scroll'&&index>reader.index+2?'loading="lazy"':''} referrerpolicy="no-referrer"></div>`;}
function retryImageUrl(url) {const fresh=new URL(url);fresh.searchParams.set('_retry',String(Date.now()));return fresh.href;}
function paintReader(){
  if(!reader)return;
  const {route,images,index}=reader;
  app.innerHTML=`<div class="reader"><div class="reader-top"><button class="icon-button" data-action="back" aria-label="返回目录">${icon('back')}</button><div class="reader-heading"><strong>${esc(route.comic.title)}</strong><small>${esc(route.name)}</small></div><button class="icon-button" data-action="reader-mode" aria-label="切换阅读方式">${icon('mode')}</button></div><button id="prefetch-status" class="prefetch-status" data-action="prefetch-retry" aria-label="章节预加载状态，点击重新预加载" aria-live="polite">${esc(prefetchStatus||'准备章节预加载…')}</button><div id="pages" class="${settings.mode==='scroll'?'continuous':'paged-image'}">${settings.mode==='scroll'?images.map(imageTag).join(''):imageTag(images[index],index)}</div><div class="reader-bottom"><button data-action="prev-chapter" aria-label="上一章">上章</button><button data-action="prev-page" aria-label="上一页">${icon('left')}</button><input id="page-slider" type="range" min="0" max="${images.length-1}" value="${index}" aria-label="阅读页码"><span class="page-count">${index+1}/${images.length}</span><button data-action="next-page" aria-label="下一页">${icon('right')}</button><button data-action="next-chapter" aria-label="下一章">下章</button></div></div>`;
  document.querySelectorAll('.page-image').forEach(img=>img.addEventListener('error',()=>{
    img.parentElement.classList.add('is-error');
    if(img.parentElement.querySelector('.retry:not(.refresh-chapter)'))return;
    const button=document.createElement('button');button.className='retry';button.textContent='图片未加载 · 点此重试';button.onclick=()=>{button.remove();img.src=retryImageUrl(img.getAttribute('src'));};img.parentElement.append(button);
    if(!img.parentElement.querySelector('.refresh-chapter')){const refresh=document.createElement('button');refresh.className='retry refresh-chapter';refresh.style.top='70%';refresh.textContent='仍失败？重新获取本章';refresh.onclick=()=>{if(reader){chapterMemo.delete(chapterKey(reader.route));navigate({...reader.route,index:reader.index},true);}};img.parentElement.append(refresh);}
  }));
  document.querySelectorAll('.page-image').forEach(img=>img.addEventListener('load',()=>{img.parentElement.classList.remove('is-error');img.parentElement.querySelectorAll('.retry').forEach(button=>button.remove());}));
  if(settings.mode==='scroll'&&index) {
    // Restore after preceding images have a layout, without storing image bytes.
    const before=Array.from(document.querySelectorAll('.page-image')).slice(0,index+1);
    before.forEach(img=>img.loading='eager');
    Promise.all(before.map(img=>img.decode().catch(()=>{}))).then(()=>{if(reader?.route===route)document.querySelector(`[data-page="${index}"]`)?.scrollIntoView();});
  }
  if(settings.mode!=='scroll'&&images[index+1]){const next=new Image();next.src=images[index+1];}
}
function turnPage(delta) {
  if(!reader)return;
  const next=Math.max(0,Math.min(reader.images.length-1,reader.index+delta));
  if(next===reader.index){toast(delta>0?'已到本章末页，请点「下章」':'已到本章首页');return;}
  reader.index=next;saveProgress();
  if(settings.mode==='scroll')document.querySelector(`[data-page="${next}"]`)?.scrollIntoView({behavior:'smooth'});else {paintReader();window.scrollTo(0,0);}
}
function changeChapter(delta){if(!reader)return;const r=reader.route;const idx=r.chapters.findIndex(([id])=>id===r.cid)+delta;const pair=r.chapters[idx];if(!pair){toast('没有更多章节了');return;}navigate({...r,cid:pair[0],name:pair[1],index:0},true);}
app.addEventListener('submit',e=>{if(e.target.id==='search-form'){e.preventDefault();const query=document.getElementById('query').value.trim();if(query)navigate({type:'search',query,page:1},true);}});
app.addEventListener('change',e=>{
  if(e.target.id==='explore-genre')changeExplore({genre:Number(e.target.value),page:1});
  if(e.target.id==='explore-status')changeExplore({status:Number(e.target.value),page:1});
  if(e.target.id==='explore-sort')changeExplore({sort:Number(e.target.value),page:1});
  if(e.target.id==='theme-select'){settings.theme=e.target.value;saveSettings();}
  if(e.target.id==='mode-select'){settings.mode=e.target.value;saveSettings();}
  if(e.target.id==='prefetch-select'){settings.prefetch=e.target.value==='on';saveSettings();stopPrefetch();}
  if(e.target.id==='page-slider'&&reader){reader.index=Number(e.target.value);saveProgress();if(settings.mode==='scroll')document.querySelector(`[data-page="${reader.index}"]`)?.scrollIntoView();else paintReader();}
});
app.addEventListener('click',e=>{
  const b=e.target.closest('[data-action]');if(!b||b.disabled)return;
  switch(b.dataset.action){
    case 'back':goBack();break;
    case 'tab':root(b.dataset.tab);break;
    case 'discover':root('discover');break;
    case 'search':navigate({type:'search'});break;
    case 'focus-search':document.getElementById('query')?.focus();break;
    case 'refresh':refreshDiscovery(false);break;
    case 'batch':refreshDiscovery(true);break;
    case 'explore-mode':changeExplore({ranking:b.dataset.mode==='rank',page:1});break;
    case 'explore-prev':changeExplore({page:Math.max(1,exploreState.page-1)});break;
    case 'explore-next':changeExplore({page:exploreState.page+1});break;
    case 'explore-retry':changeExplore({});break;
    case 'explore-reset':changeExplore({genre:0,status:0,page:1});break;
    case 'check-updates':refreshFavorites(true);break;
    case 'import-local':if(window.Android?.importLocal){Android.importLocal();toast('选择图片、CBZ／ZIP 或 PDF');}else toast('请在安卓客户端中导入本地文件');break;
    case 'retry':render(current,++generation);break;
    case 'comic':showComic(b.dataset.id);break;
    case 'select-book':if(selected===Number(b.dataset.index))showComic(stageItems()[selected].id);else scrollShelf(Number(b.dataset.index));break;
    case 'shelf-prev':case 'shelf-next':scrollShelf(selected+(b.dataset.action==='shelf-next'?1:-1));break;
    case 'shelf-view':gridShelf=!gridShelf;renderRoot();break;
    case 'favorite':{const c=current.comic;library[c.id]={...library[c.id],...c,favorite:!library[c.id]?.favorite,updated:Date.now()};applyBookUpdate(c.id,current.info);persist();toast(library[c.id].favorite?'已放入书架':'已移出书架');render(current,++generation);break;}
    case 'sort':sortDescending=!sortDescending;render(current,++generation);break;
    case 'chapter':openChapter(b.dataset.cid);break;
    case 'start':{const p=library[current.id]?.progress;openChapter(p?.cid||current.chapters[0]?.[0],p?.index||0);break;}
    case 'search-prev':case 'search-next':navigate({...current,page:(current.page||1)+(b.dataset.action==='search-next'?1:-1)},true);break;
    case 'prev-page':turnPage(-1);break;
    case 'next-page':turnPage(1);break;
    case 'prev-chapter':changeChapter(-1);break;
    case 'next-chapter':changeChapter(1);break;
    case 'reader-mode':settings.mode=settings.mode==='scroll'?'paged':'scroll';saveSettings();paintReader();break;
    case 'prefetch-retry':if(reader&&!reader.route.comic.local){stopPrefetch();startPrefetch(reader.route);}break;
  }
});
let scrolling=false;
window.addEventListener('scroll',()=>{
  if(!reader||settings.mode!=='scroll'||scrolling)return;
  scrolling=true;requestAnimationFrame(()=>{scrolling=false;if(!reader)return;const pages=Array.from(document.querySelectorAll('.image-wrap'));const nearest=pages.reduce((best,p)=>Math.abs(p.getBoundingClientRect().top-54)<Math.abs(best.getBoundingClientRect().top-54)?p:best,pages[0]);if(nearest){const index=Number(nearest.dataset.page);if(index!==reader.index){reader.index=index;saveProgress();document.querySelector('.page-count').textContent=`${index+1}/${reader.images.length}`;document.getElementById('page-slider').value=index;}}});
},{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveProgress();});
window.addEventListener('pagehide',saveProgress);
document.addEventListener('keydown',e=>{if(reader&&settings.mode!=='scroll'){if(e.key==='ArrowRight')turnPage(1);if(e.key==='ArrowLeft')turnPage(-1);}});
let touchStart=null;
app.addEventListener('touchstart',e=>{touchStart=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;},{passive:true});
app.addEventListener('touchend',e=>{if(!reader||settings.mode==='scroll'||!touchStart||window.visualViewport?.scale>1.05)return;const dx=e.changedTouches[0].clientX-touchStart.x,dy=e.changedTouches[0].clientY-touchStart.y;if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.6)turnPage(dx<0?1:-1);touchStart=null;},{passive:true});
render(current,++generation);
