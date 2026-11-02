const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const fixture = fs.readFileSync(path.join(__dirname, 'checks/image-response.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/source.js'), 'utf8'), context);
context.fixture = fixture;
const urls = vm.runInContext('Mangabz.unpackImages(fixture)', context, {timeout:1000});
assert.equal(urls.length, 2);
assert.equal(new URL(urls[0]).pathname, '/1/242/16752/1_4879.jpg');
assert.equal(new URL(urls[1]).pathname, '/1/242/16752/2_6452.jpg');
assert.equal(new URL(urls[0]).searchParams.get('cid'), '16752');
assert.ok(new URL(urls[0]).searchParams.get('key'));
context.fixture += '; globalThis.injected = true;';
vm.runInContext('Mangabz.unpackImages(fixture)', context);
assert.equal(context.injected, undefined, 'Remote response must never execute');
assert.throws(() => vm.runInContext('Mangabz.unpackImages("not a response")', context));
let pageCount=2;
context.Network={get:async url=>url.includes('chapterimage')
  ? {status:200,body:url.includes('page=1&')?fixture:''}
  : {status:200,body:`var MANGABZ_CID=16752;var COMIC_MID=242;var MANGABZ_VIEWSIGN_DT="2026-11-01 20:00:00";var MANGABZ_VIEWSIGN="example";var MANGABZ_IMAGE_COUNT=${pageCount};`}};
(async()=>{
  const complete=await vm.runInContext('new Mangabz().comic.loadEp("242","16752")',context);
  assert.equal(complete.images.length,2);
  pageCount=3;
  await assert.rejects(async()=>await vm.runInContext('new Mangabz().comic.loadEp("242","16752")',context),e=>String(e).includes('完整'));
  console.log('PASS: signed URLs, ordering, invalid data rejection, no remote code execution, complete chapters and rejection of missing pages');
})().catch(e=>{console.error(e);process.exit(1);});
