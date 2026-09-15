"use strict";
var assert=require("assert"),J=require("../src/common/collections/journal"),Client=require("../src/common/collections/client").Client,Views=require("../src/common/collection-views");
function storage(){var values={},fail=false;return {values:values,getItem:function(k){return values[k]||null;},setItem:function(k,v){if(fail)throw new Error("disk full");values[k]=v;},removeItem:function(k){delete values[k];},fail:function(v){fail=v;}};}
function enrolled(){var s=storage(),j=new J.Journal(s);j.enroll({client_id:"client_a",server_instance_id:"server_a",store_epoch:"epoch_a"});j.bridge("bridge_a");return {s:s,j:j};}
function input(seq){return {ingress:"watch:bridge_a:"+seq,collection_id:"col_note",generation:"1",type:"note.create",payload:{title:"Unicode",body:"José 🌙 ".repeat(100)}};}
(function durableHandoff(){var f=enrolled(),op=f.j.accept(input(1));assert.strictEqual(op.id,"op:client_a:1");var recovered=new J.Journal(f.s);assert.deepStrictEqual(recovered.accept(input(1)),op);assert.strictEqual(recovered.data.entries.length,1);var different=input(1);different.payload.body="other";assert.throws(function(){recovered.accept(different);},/reused/);f.s.fail(true);assert.throws(function(){recovered.accept(input(2));},/disk full/);f.s.fail(false);assert.strictEqual(new J.Journal(f.s).data.sequence,1);})();
(function tornSlot(){var f=enrolled();f.j.accept(input(1));var previous=f.j.generation;f.s.values[J.PREFIX+(f.j.slot===0?1:0)]='{"schema":1,"generation":999,"payload":"torn"}';var j=new J.Journal(f.s);assert.strictEqual(j.generation,previous);assert.strictEqual(j.data.entries.length,1);})();
(function dependentAndQuota(){var f=enrolled(),op=f.j.accept(input(1)),edit={ingress:"watch:bridge_a:2",collection_id:"col_note",generation:"1",record_id:op.record_id,type:"note.append",payload:{text:" more"}};var second=f.j.accept(edit);assert.strictEqual(second.base_operation_id,op.id);assert.strictEqual(second.base_revision,"");var j=new J.Journal(f.s,{maxOperations:2});assert.throws(function(){j.accept(input(3));},/full/);assert.strictEqual(new J.Journal(f.s).data.entries.length,2);})();
(function staleSessionsAndOverlay(){var f=enrolled(),op=f.j.accept(input(1));f.j.receipt({operation_id:op.id,outcome:"applied",durably_recorded:true,revision:"1"});f.j.bridge("bridge_b");assert.throws(function(){f.j.accept(input(1));},/Stale/);var cache={pages:{},records:{}};var client=Object.create(Client.prototype);client.journal=f.j;client.cache=cache;f.j.update(function(d){d.bridge="bridge_a";});var next=f.j.accept(input(2));var page=client.project({records:[]},"note","active");assert.strictEqual(page.records[0].id,next.record_id);})();
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
 views.list("event","active","","",function(e,v){assert.ifError(e);assert.match(v.list.titles[0],/Sep 15 .*Planning/);assert.strictEqual(views.resolve(v.token,"r0").record.kind,"event");assert.strictEqual(v.list.total,1);views.body(views.resolve(v.token,"r0").record,"",function(e,v){assert.ifError(e);assert.match(v.source,/Room A/);assert.match(v.source,/Agenda/);assert.match(v.source,/bind .*action=local.events.*input=back/);assert.ok(!v.source.includes("Back to calendar"));assert.ok(!v.source.includes("local.note.edit"));});});
})();

(function compactionOnlyWritesWhenDurableWorkCanBeRemoved(){
 var f=enrolled(),before=f.j.generation;
 f.j.compact({});assert.strictEqual(f.j.generation,before);
 var op=f.j.accept(input(1));before=f.j.generation;
 f.j.compact({});assert.strictEqual(f.j.generation,before);
 f.j.receipt({operation_id:op.id,outcome:"applied",durably_recorded:true,revision:"10"});before=f.j.generation;
 var records={};records[op.record_id]={revision:"9"};f.j.compact(records);assert.strictEqual(f.j.generation,before);
 records[op.record_id].revision="10";f.s.fail(true);assert.throws(function(){f.j.compact(records);},/disk full/);
 assert.strictEqual(f.j.data.entries.length,1);f.s.fail(false);f.j.compact(records);
 assert.strictEqual(new J.Journal(f.s).data.entries.length,0);
 assert.ok(f.j.data.receipts[op.ingress_id],"watch duplicate receipts must survive compaction");
 before=f.j.generation;f.j.compact(records);assert.strictEqual(f.j.generation,before);
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
