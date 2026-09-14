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
 client.request=function(method,path,body,done){pending.push({method:method,path:path,done:done});};
 client.connect(function(e){assert.ifError(e);completed++;});
 client.list("task","active","","",function(e,p){assert.ifError(e);assert.deepStrictEqual(p.records,[]);completed++;});
 assert.strictEqual(pending.length,1);
 pending.shift().done(null,{protocol_version:1,server_instance_id:"s",store_epoch:"e",principal:"operator"});
 assert.strictEqual(pending.length,1);assert.strictEqual(pending[0].path,"/v1/sync/clients");
 pending.shift().done(null,{client_id:"c",server_instance_id:"s",store_epoch:"e",principal:"operator"});
 pending.shift().done(null,[{id:"col_task",kind:"task",binding_generation:"1"}]);
 assert.strictEqual(completed,1);
 pending.shift().done(null,{snapshot_id:"snapshot"});
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
