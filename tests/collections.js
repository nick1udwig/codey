"use strict";
var assert=require("assert"),J=require("../src/common/collections/journal"),Client=require("../src/common/collections/client").Client,Views=require("../src/common/collection-views");
function storage(){var values={},fail=false;return {values:values,getItem:function(k){return values[k]||null;},setItem:function(k,v){if(fail)throw new Error("disk full");values[k]=v;},removeItem:function(k){delete values[k];},fail:function(v){fail=v;}};}
function enrolled(){var s=storage(),j=new J.Journal(s);j.enroll({client_id:"client_a",server_instance_id:"server_a",store_epoch:"epoch_a"});j.bridge("bridge_a");return {s:s,j:j};}
function input(seq){return {ingress:"watch:bridge_a:"+seq,collection_id:"col_note",generation:"1",type:"note.create",payload:{title:"Unicode",body:"José 🌙 ".repeat(100)}};}
(function pollingBacksOffAndCoalescesExplicitRefresh(){
 var Poll=require("../src/common/poll"),pending=[],timers=[],cleared=[];
 var poll=new Poll(function(done){pending.push(done);},{setTimeout:function(fn,delay){timers.push({fn:fn,delay:delay});return timers.length;},clearTimeout:function(id){cleared.push(id);}});
 poll.refresh();pending.shift()(true);assert.strictEqual(timers[0].delay,60000);
 timers.shift().fn();pending.shift()(false);assert.strictEqual(timers[0].delay,120000);
 timers.shift().fn();pending.shift()(false);assert.strictEqual(timers[0].delay,240000);
 timers.shift().fn();pending.shift()(false);assert.strictEqual(timers[0].delay,300000);
 poll.refresh();assert.strictEqual(pending.length,1);poll.refresh();poll.refresh();assert.strictEqual(pending.length,1);
 pending.shift()(false);assert.strictEqual(pending.length,1,"one follow-up for coalesced explicit requests");
 var done=pending.shift();poll.stop();done(true);assert.strictEqual(poll.timer,null);
 poll.refresh();assert.strictEqual(pending.length,1);pending.shift()(true);assert.strictEqual(timers[timers.length-1].delay,60000);
 poll.stop();assert.ok(cleared.length);
})();
(function changedCredentialsCannotPopulateCollectionCaches(){
 var base="https://old.test",token="old",requests=[];
 function XHR(){requests.push(this);}XHR.prototype.open=function(){};XHR.prototype.setRequestHeader=function(){};XHR.prototype.send=function(){};
 var client=new Client({storage:storage(),base:function(){return base;},token:function(){return token;},XMLHttpRequest:XHR});
 var error;client.connect(function(e){error=e;});token="new";
 var x=requests[0];x.status=200;x.responseText=JSON.stringify({protocol_version:1,server_instance_id:"old",store_epoch:"e"});x.onload();
 assert.match(error.message,/settings changed/);assert.strictEqual(client.journal.data.scope,null);assert.strictEqual(requests.length,1);
})();
(function batchReceiptsAreAtomicAndSkipNoops(){
 var f=enrolled(),results=[];
 for(var i=0;i<20;i++){
  var op=f.j.accept(input(i));results.push({operation_id:op.id,durably_recorded:true,outcome:i%2?"applied":"conflict",revision:"1"});
 }
 var writes=0,bytes=0,save=f.s.setItem;
 f.s.setItem=function(k,v){writes++;bytes+=Buffer.byteLength(v);save(k,v);};
 results.push({operation_id:"unknown",durably_recorded:true});
 f.s.fail(true);assert.throws(function(){f.j.receipts(results);},/disk full/);
 assert.ok(f.j.data.entries.every(function(e){return !e.receipt;}));
 assert.ok(new J.Journal(f.s).data.entries.every(function(e){return !e.receipt;}));
 f.s.fail(false);writes=bytes=0;f.j.receipts(results);
 assert.strictEqual(writes,1);assert.ok(bytes<140000);
 var restored=new J.Journal(f.s);assert.strictEqual(restored.generation,f.j.generation);
 assert.ok(restored.data.entries.every(function(e){return e.receipt&&restored.data.receipts[e.operation.ingress_id].durable;}));
 var generation=f.j.generation;
 f.j.receipts(results);f.j.receipts([{operation_id:results[0].operation_id,durably_recorded:false}]);
 f.j.receipts([{operation_id:"unknown",durably_recorded:true}]);
 assert.strictEqual(f.j.generation,generation);assert.strictEqual(writes,1);
 results[0].revision="changed";assert.strictEqual(f.j.data.entries[0].receipt.revision,"1");
})();
(function drainUsesOneVerifiedBatchAndPreservesPendingResults(){
 var f=enrolled(),client=new Client({storage:f.s}),one=client.journal.accept(input(1)),two=client.journal.accept(input(2));
 client.request=function(m,p,b,done){done(null,{results:[{operation_id:one.id,durably_recorded:true,outcome:"applied"},{operation_id:two.id,durably_recorded:false}]});};
 var before=client.journal.generation;
 client.drain(function(e){assert.ifError(e);});assert.strictEqual(client.journal.generation,before+1);
 assert.ok(client.journal.data.entries[0].receipt);assert.ok(!client.journal.data.entries[1].receipt);
})();
(function durableHandoff(){var f=enrolled(),op=f.j.accept(input(1));assert.strictEqual(op.id,"op:client_a:1");var recovered=new J.Journal(f.s);assert.deepStrictEqual(recovered.accept(input(1)),op);assert.strictEqual(recovered.data.entries.length,1);var different=input(1);different.payload.body="other";assert.throws(function(){recovered.accept(different);},/reused/);f.s.fail(true);assert.throws(function(){recovered.accept(input(2));},/disk full/);f.s.fail(false);assert.strictEqual(new J.Journal(f.s).data.sequence,1);})();
(function tornSlot(){var f=enrolled();f.j.accept(input(1));var previous=f.j.generation;f.s.values[J.PREFIX+(f.j.slot===0?1:0)]='{"schema":1,"generation":999,"payload":"torn"}';var j=new J.Journal(f.s);assert.strictEqual(j.generation,previous);assert.strictEqual(j.data.entries.length,1);})();
(function dependentAndQuota(){var f=enrolled(),op=f.j.accept(input(1)),edit={ingress:"watch:bridge_a:2",collection_id:"col_note",generation:"1",record_id:op.record_id,type:"note.append",payload:{text:" more"}};var second=f.j.accept(edit);assert.strictEqual(second.base_operation_id,op.id);assert.strictEqual(second.base_revision,"");var j=new J.Journal(f.s,{maxOperations:2});assert.throws(function(){j.accept(input(3));},/full/);assert.strictEqual(new J.Journal(f.s).data.entries.length,2);})();
(function staleSessionsAndOverlay(){var f=enrolled(),op=f.j.accept(input(1));f.j.receipts([{operation_id:op.id,outcome:"applied",durably_recorded:true,revision:"1"}]);f.j.bridge("bridge_b");assert.throws(function(){f.j.accept(input(1));},/Stale/);var cache={pages:{},records:{}};var client=Object.create(Client.prototype);client.journal=f.j;client.cache=cache;f.j.update(function(d){d.bridge="bridge_a";});var next=f.j.accept(input(2));var page=client.project({records:[]},"note","active");assert.strictEqual(page.records[0].id,next.record_id);})();
(function viewAliases(){var client={list:function(kind,state,snapshot,cursor,done){done(null,{records:[{id:"canonical-id-that-never-fits-native",title:"A",revision:"1",capabilities:[]}],complete:true});}},views=new Views(client);var first;views.list("note","active","","",function(e,v){assert.ifError(e);first=v;});assert.strictEqual(views.resolve(first.token,"r0").record.revision,"1");views.list("note","active","","",function(){});assert.throws(function(){views.resolve(first.token,"r0");},/Stale/);})();
console.log("✓ collection journal: durable recovery, torn slots, duplicate ingress, dependencies, quota, stale sessions, overlays, view aliases");

(function startupEnrollment(){
 var client=new Client({storage:storage(),base:function(){return "https://server.test";},token:function(){return "test";}}),pending=[],completed=0;
 client.request=function(method,path,body,done){pending.push({method:method,path:path,body:body,done:done});};
 client.connect(function(e){assert.ifError(e);completed++;});
 client.list("task","active","","",function(e,p){assert.ifError(e);assert.deepStrictEqual(p.records,[]);completed++;});
 assert.strictEqual(pending.length,1);
 pending.shift().done(null,{protocol_version:1,server_instance_id:"s",store_epoch:"e",principal:"operator"});
 assert.strictEqual(pending.length,1);assert.strictEqual(pending[0].path,"/v1/sync/clients");
 pending.shift().done(null,{client_id:"c",server_instance_id:"s",store_epoch:"e",principal:"operator"});
 pending.shift().done(null,[{id:"col_task",kind:"task",binding_generation:"1"}]);
 assert.strictEqual(completed,1);
 assert.strictEqual(pending[0].body.limit,8);
 pending.shift().done(null,{records:[],snapshot_id:"snapshot",complete:true});
 assert.strictEqual(completed,2);
})();
(function setupErrorAndRetry(){
 var client=new Client({storage:storage(),base:function(){return "http://server.test";},token:function(){return "test";}});
 client.list("task","active","","",function(e){assert.match(e.message,/HTTP requires/);});
 assert.strictEqual(client.connectWaiters,null);
 client.options.base=function(){return "";};
 client.ensure(function(e){assert.match(e.message,/URL and bearer token/);});
})();
(function completedTaskImmediatelyUsesCachedPageAndTotal(){
 var f=enrolled(),client=new Client({storage:f.s,base:function(){return "https://server.test";},token:function(){return "secret";}});
 client.collections=[{id:"col_task",kind:"task",binding_generation:"1"}];
 var a={id:"a",title:"First",kind:"task",revision:"1",completed:false,capabilities:["task.complete"]},b={id:"b",title:"Second",kind:"task",revision:"1",completed:false,capabilities:["task.complete"]};
 client.cache.pages["task:active::"]={total:21,records:[a,b],next_cursor:"next"};client.cache.records={a:a,b:b};
 client.journal.accept({ingress:"watch:bridge_a:1",collection_id:"col_task",generation:"1",record_id:"a",revision:"1",type:"task.complete",payload:{}});
 client.request=function(){throw new Error("Completion must render from cache without waiting for network");};
 var views=new Views(client);views.list("task","active","","",function(e,v){assert.ifError(e);assert.deepStrictEqual(v.list.titles,["Second"]);assert.strictEqual(v.list.total,20);assert.strictEqual(v.list.pending,1);assert.strictEqual(views.resolve(v.token,"r0").record.id,"b");},true);
})();
(function calendarViewsShowTimeAndReadOnlyDetails(){
 var record={id:"event",kind:"event",revision:"1",title:"Planning",start:"2099-09-15T16:00:00Z",end:"2099-09-15T17:00:00Z",location:"Room A",capabilities:[]};
 var views=new Views({list:function(k,s,snap,cur,done){assert.strictEqual(k,"event");done(null,{total:1,records:[record]});},body:function(r,c,done){done(null,{body:"Agenda",complete:true});}});
 views.list("event","active","","",function(e,v){assert.ifError(e);assert.strictEqual(v.list.titles[0],"Planning");assert.match(v.list.timeline[0],/day=2099-09-15/);assert.strictEqual(views.resolve(v.token,"r0").record.kind,"event");assert.strictEqual(v.list.total,1);views.body(views.resolve(v.token,"r0").record,"",function(e,v){assert.ifError(e);assert.match(v.source,/Room A/);assert.match(v.source,/Agenda/);assert.match(v.source,/bind .*action=local.event.list.*input=back/);assert.ok(!v.source.includes("Back to calendar"));assert.ok(!v.source.includes("local.note.edit"));});});
})();

(function compactionOnlyWritesWhenDurableWorkCanBeRemoved(){
 var f=enrolled(),before=f.j.generation;
 f.j.compact({});assert.strictEqual(f.j.generation,before);
 var op=f.j.accept(input(1));before=f.j.generation;
 f.j.compact({});assert.strictEqual(f.j.generation,before);
 f.j.receipts([{operation_id:op.id,outcome:"applied",durably_recorded:true,revision:"10"}]);before=f.j.generation;
 var records={};records[op.record_id]={revision:"9"};f.j.compact(records);assert.strictEqual(f.j.generation,before);
 records[op.record_id].revision="10";f.s.fail(true);assert.throws(function(){f.j.compact(records);},/disk full/);
 assert.strictEqual(f.j.data.entries.length,1);f.s.fail(false);f.j.compact(records);
 assert.strictEqual(new J.Journal(f.s).data.entries.length,0);
 assert.ok(f.j.data.receipts[op.ingress_id],"watch duplicate receipts must survive compaction");
 before=f.j.generation;f.j.compact(records);assert.strictEqual(f.j.generation,before);
})();

(function timelineMetadataAndReturnPage(){
 var records=Array.from({length:8},function(_,i){return {id:"event"+i,kind:"event",title:"🌙".repeat(40),start:"2099-09-15",end:"2099-09-16",location:'"'.repeat(80),capabilities:[]};});
 var views=new Views({list:function(kind,state,snapshot,cursor,done){done(null,{records:records,total:16,next_cursor:"third",snapshot_id:"snapshot"});},body:function(record,cursor,done){done(null,{body:"Details"});}}),list;
 views.list("event","active","snapshot","second",function(e,v){assert.ifError(e);list=v;});
 assert.match(list.list.timeline[0],/all_day=true/);
 assert.match(list.list.timeline[0],/day=2099-09-15/);
 assert.match(list.list.timeline[0],/time="All day"/);
 assert.ok(list.list.timeline.every(function(m){return Buffer.byteLength(m)<192;}));
 assert.ok(Buffer.byteLength(list.list.titles.join("\n"))+Buffer.byteLength(list.list.timeline.join("\n"))+250<2048,"packed event cards must fit the watch inbox");
 views.body(views.resolve(list.token,"r5").record,"",function(e,v){assert.ifError(e);var back=views.resolve(v.token,"back");assert.strictEqual(back.cursor,"second");assert.strictEqual(back.snapshot,"snapshot");assert.strictEqual(back.focus,5);assert.match(v.source,/value=return/);});
})();
(function unchangedMetadataDoesNotRewriteCache(){
 var client=new Client({storage:storage(),base:function(){return "https://server.test";},token:function(){return "test";}}),writes=0;
 client.saveCache=function(){writes++;};
 client.request=function(method,path,body,done){
  if(path==="/v1/sync/info")return done(null,{protocol_version:1,server_instance_id:"s",store_epoch:"e",principal:"operator"});
  if(path==="/v1/sync/clients")return done(null,{client_id:"c",server_instance_id:"s",store_epoch:"e",principal:"operator"});
  done(null,[{id:"col_note",kind:"note",count:3}]);
 };
 client.connect(function(e){assert.ifError(e);});client.connect(function(e){assert.ifError(e);});
 assert.strictEqual(writes,1);
})();

(function timelinePageHistoryAndDST(){
 var oldTZ=process.env.TZ;process.env.TZ="America/Los_Angeles";
 try {
  var records=[{id:"early",kind:"event",title:"Early",start:"2026-11-01T01:30:00-07:00",end:"2026-11-01T01:15:00-08:00"},
   {id:"late",kind:"event",title:"Late",start:"2026-11-01T01:30:00-08:00",end:"2026-11-01T02:00:00-08:00"}];
  var views=new Views({list:function(kind,state,snapshot,cursor,done){done(null,{records:records,total:6,next_cursor:cursor==="second"?"third":"second",snapshot_id:"snap"});}}),page;
  function read(snapshot,cursor){views.list("event","active",snapshot,cursor,function(e,v){assert.ifError(e);page=v;});}
  read("","");assert.match(page.list.timeline[0],/start=5400/);assert.match(page.list.timeline[0],/end=8100/);assert.match(page.list.timeline[1],/start=9000/);assert.strictEqual(page.list.previous,false);
  read("snap","second");assert.strictEqual(page.list.previous,true);assert.strictEqual(views.resolve(page.token,"previous").cursor,"");
  read("snap","third");assert.strictEqual(views.resolve(page.token,"previous").cursor,"second");
  read("snap","second");assert.strictEqual(views.resolve(page.token,"previous").cursor,"");assert.strictEqual(views.eventPages.length,2);
 } finally {if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;}
})();

(function boundedCacheRetainsNavigationAndSkipsUnchangedWrites(){
 var Cache=require("../src/common/collections/cache"),s=storage(),scope=JSON.stringify({server:"a"});
 var cache=new Cache.Cache(s,scope,{maxBytes:16000,maxPages:6,maxRecords:12});
 cache.data.collections=[{id:"col_note",kind:"note"}];
 var first={records:[{id:"note",revision:"1",title:"First"}],snapshot_id:"pinned"};
 cache.putPage("note:active::",first,true);cache.merge(first.records);cache.save(scope);
 for(var i=0;i<100;i++){
  cache.putPage("note:1:"+i,{text:"José 🌙 ".repeat(80),cursor:String(i)},false);
  cache.save(scope);
  assert.ok(s.values[Cache.KEY].length*2<=16000);
  assert.ok(Object.keys(cache.data.pages).length<=6);
 }
 assert.ok(cache.page("note:active::"),"useful first page retained");
 assert.ok(cache.page("note:1:99"),"current page retained");
 var written=cache.stats.writtenBytes,serialized=cache.stats.serializedBytes;
 var current=cache.page("note:1:99");
 cache.putPage("note:1:99",current,false);cache.save(scope);
 assert.strictEqual(cache.stats.writtenBytes,written,"identical response skips storage write");
 assert.strictEqual(cache.stats.serializedBytes-serialized,JSON.stringify(current).length*2,"only incoming page is serialized");
 var reopened=new Cache.Cache(s,scope,{maxBytes:16000,maxPages:6,maxRecords:12});
 assert.deepStrictEqual(reopened.page("note:1:99"),current);
 assert.deepStrictEqual(reopened.data.collections,cache.data.collections);
 reopened.merge([{id:"note",revision:"2",title:"New"}]);reopened.save(scope);
 assert.strictEqual(reopened.page("note:active::").records[0].revision,"1","snapshot stays pinned");
 assert.strictEqual(reopened.data.records.note.revision,"2");
 s.fail(true);reopened.putPage("note:2:",{text:"fresh"},true);
 assert.doesNotThrow(function(){reopened.save(scope);});
 assert.strictEqual(reopened.page("note:2:").text,"fresh","failed persistence keeps current in-memory read");
 var other=new Cache.Cache(s,JSON.stringify({server:"b"}));
 assert.deepStrictEqual(other.data.pages,{},"scope change rejects old cache");
 console.log("✓ bounded cache: evictions="+cache.stats.evictions+", serialized bytes="+cache.stats.serializedBytes+", written bytes="+written);
})();

(function normalizedJournalMigrationAndExactReplay(){
 var f=enrolled(),one=input(1),op=f.j.accept(one),legacy=J.clone(f.j.data);
 legacy.entries[0].input=one;
 legacy.receipts[one.ingress].hash=JSON.stringify(one);
 delete legacy.receipts[one.ingress].input;
 var payload=JSON.stringify(legacy);
 function envelope(generation){return JSON.stringify({schema:1,generation:generation,payload:payload,checksum:J.checksum(payload)});}
 f.s.values[J.PREFIX+0]=envelope(20);f.s.values[J.PREFIX+1]=envelope(21);
 var migrated=new J.Journal(f.s),before=Object.assign({},f.s.values);
 assert.deepStrictEqual(migrated.accept(one),op);
 assert.deepStrictEqual(f.s.values,before,"load and replay do not rewrite accepted legacy input");
 assert.strictEqual(migrated.data.entries[0].operation,migrated.data.receipts[one.ingress].operation);
 var save=f.s.setItem;
 f.s.setItem=function(k,v){save(k,v.slice(0,20));};
 assert.throws(function(){migrated.accept(input(2));},/verification/);
 assert.deepStrictEqual(new J.Journal(f.s).accept(one),op,"old winning slot survives a torn migration");
 f.s.setItem=save;
 migrated=new J.Journal(f.s);migrated.accept(input(2));migrated.accept(input(3));
 [0,1].forEach(function(slot){assert.strictEqual(JSON.parse(f.s.values[J.PREFIX+slot]).schema,2);});
 var restarted=new J.Journal(f.s);
 assert.deepStrictEqual(restarted.accept(one),op);
 var different=input(1);different.view="new-view";
 assert.throws(function(){restarted.accept(different);},/reused/);
 different=input(1);different.payload.body+="!";
 assert.throws(function(){restarted.accept(different);},/reused/);
})();

(function journalSizeAndAcknowledgedLifecycle(){
 [20,100].forEach(function(count){
  var f=enrolled(),written=0,save=f.s.setItem;
  f.s.setItem=function(k,v){written+=v.length*2;save(k,v);};
  for(var i=0;i<count;i++)f.j.accept(input(i));
  var current=JSON.parse(f.s.values[J.PREFIX+f.j.slot]),legacy=J.clone(f.j.data);
  legacy.entries.forEach(function(entry){entry.input=input(Number(entry.operation.sequence)-1);});
  Object.keys(legacy.receipts).forEach(function(key){var receipt=legacy.receipts[key];receipt.hash=JSON.stringify(input(Number(receipt.operation.sequence)-1));delete receipt.input;});
  assert.ok(current.payload.length<JSON.stringify(legacy).length/2);
  console.log("✓ normalized journal "+count+" notes: payload bytes="+current.payload.length*2+", legacy="+JSON.stringify(legacy).length*2+", cumulative envelope writes="+written);
 });
 var f=enrolled();f.j.options.maxBytes=20000;
 var accepted=[],full=false;
 for(var i=0;i<100;i++){
  var value=input(i);value.payload.body="small";
  var op;
  try{op=f.j.accept(value);}catch(e){assert.match(e.message,/full/);full=true;break;}
  accepted.push({input:value,operation:op});
  try{f.j.receipts([{operation_id:op.id,outcome:"applied",revision:"1",durably_recorded:true}]);}
  catch(e){assert.match(e.message,/full/);full=true;break;}
  var records={};records[op.record_id]={revision:"1"};f.j.compact(records);
 }
 assert.ok(full,"byte budget bounds live exact replay receipts");
 var restored=new J.Journal(f.s);
 accepted.forEach(function(item){assert.deepStrictEqual(restored.accept(item.input),item.operation);});
 var pending=restored.data.entries.filter(function(e){return !e.receipt;}).length;
 restored.bridge("next_bridge");assert.strictEqual(Object.keys(restored.data.receipts).length,pending);
 assert.throws(function(){restored.accept(accepted[0].input);},/Stale/);
})();
