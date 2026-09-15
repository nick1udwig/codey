"use strict";
var assert=require("assert"), Jobs=require("../src/common/jobs").Jobs;
module.exports=function(test){
 function fixture(storage){
  var requests=[],updates=[],data=storage||{};
  function XHR(){requests.push(this);}XHR.prototype.open=function(m,u){this.method=m;this.url=u;};XHR.prototype.setRequestHeader=function(){};XHR.prototype.send=function(body){this.body=body;};
  var options={storage:{getItem:function(k){return data[k];},setItem:function(k,v){data[k]=v;}},XMLHttpRequest:XHR,token:function(){return "";},update:function(j,buzz){updates.push({status:j.status,buzz:buzz});}};
  var jobs=new Jobs(options);
  function reply(index,job,status,result,http){var x=requests[index];x.status=http||200;x.responseText=JSON.stringify({id:job.id,status:status,result:result||""});x.onload();}
  return {jobs:jobs,options:options,data:data,requests:requests,updates:updates,reply:reply};
 }
 var request={id:1,session:"one",endpoint:"https://agent.test/v1/agent",timeoutSeconds:45,input:{kind:"dictation",text:"Long work"}};
 test("Jobs do one bounded completion wait, then only explicit manual checks",function(){
  var f=fixture(),j=f.jobs.submit(request);
  assert.ok(f.data["pebble-agent.jobs.v1"].includes(j.id));
  f.reply(0,j,"working");assert.strictEqual(f.requests.length,2);assert.ok(f.requests[1].url.endsWith("?wait=45"));
  f.reply(1,j,"working");assert.strictEqual(f.requests.length,2);assert.strictEqual(j.status,"working");
  f.jobs.check(j.id,function(e,done){assert.ifError(e);assert.strictEqual(done.status,"done");});
  f.reply(2,j,"done","saved PAM");assert.strictEqual(f.requests.length,3);assert.ok(!f.updates.some(function(u){return u.buzz;}));
  var restored=fixture(f.data);restored.jobs.check(j.id,function(e,done){assert.ifError(e);assert.strictEqual(done.result,"saved PAM");});assert.strictEqual(restored.requests.length,0);
 });
 test("Uncertain submissions retry the same persisted ID and exact body",function(){
  var f=fixture(),j=f.jobs.submit(request);f.requests[0].ontimeout();assert.strictEqual(j.status,"unconfirmed");
  f.jobs.check(j.id,function(e,result){assert.ifError(e);assert.strictEqual(result.status,"working");});
  f.reply(1,j,"", "",404);assert.strictEqual(f.requests[2].url,f.requests[0].url);assert.strictEqual(f.requests[2].body,f.requests[0].body);f.reply(2,j,"working");
 });
 test("Lost wait connection does not cancel jobs, and explicit cancel does",function(){
  var f=fixture(),j=f.jobs.submit(request);f.reply(0,j,"working");f.requests[1].onerror();assert.strictEqual(j.status,"working");assert.strictEqual(f.requests.length,2);
  f.jobs.cancel(j.id,function(e,canceled){assert.ifError(e);assert.strictEqual(canceled.status,"canceled");});assert.ok(f.requests[2].url.endsWith("/cancel"));f.reply(2,j,"canceled");
 });
 test("A stale waiting response cannot overwrite a manually fetched result",function(){
  var f=fixture(),j=f.jobs.submit(request);f.reply(0,j,"working");f.jobs.check(j.id,function(e){assert.ifError(e);});f.reply(2,j,"done","result");f.reply(1,j,"working");assert.strictEqual(j.status,"done");assert.strictEqual(j.result,"result");
 });
 test("Opening Notifications checks every ongoing job once and keeps checking transient",function(){
  var entries=["working","canceling","unconfirmed","done","failed","canceled"].map(function(status,i){return {id:String(i+1).padStart(30,"0"),status:status,endpoint:"https://agent.test/v1/jobs/",accepted:true};});
  entries.push({id:"999999999999999999999999999999",status:"working",opened:true});
  var f=fixture({"pebble-agent.jobs.v1":JSON.stringify(entries)});
  f.jobs.refreshAll();
  assert.strictEqual(f.requests.length,3);
  assert.deepStrictEqual(f.updates.map(function(u){return u.status;}),["checking","checking","checking"]);
  assert.strictEqual(f.jobs.entries[0].status,"working");
  assert.strictEqual(JSON.parse(f.data["pebble-agent.jobs.v1"])[0].status,"working");
  f.jobs.refreshAll();assert.strictEqual(f.requests.length,3,"no duplicate in-flight checks");
  f.reply(0,entries[0],"done","PAM result");f.reply(1,entries[1],"canceled");f.requests[2].ontimeout();
  assert.strictEqual(f.jobs.entries[0].result,"PAM result");
  assert.ok(!f.updates.some(function(u){return u.buzz;}));
  assert.strictEqual(f.updates[f.updates.length-1].status,"unconfirmed");
  assert.strictEqual(f.requests.length,3,"no recurring polling");
  f.jobs.refreshAll();assert.strictEqual(f.requests.length,4,"only remaining ongoing job checked on reopen");
 });
 test("A late submission timeout cannot regress a job resolved by pane refresh",function(){
  var f=fixture(),j=f.jobs.submit(request);f.jobs.refreshAll();f.reply(1,j,"done","result");f.requests[0].ontimeout();assert.strictEqual(j.status,"done");assert.strictEqual(j.result,"result");
 });
 test("No job is submitted if the phone cannot persist its ID",function(){
  var f=fixture();f.options.storage.setItem=function(){throw new Error("full");};assert.throws(function(){f.jobs.submit(request);},/not sent/);assert.strictEqual(f.requests.length,0);
 });
 test("Opened payloads become durable receipts and failed acknowledgments survive restart",function(){
  var f=fixture(),j=f.jobs.submit(request);f.reply(0,j,"working");
  f.jobs.check(j.id,function(e){assert.ifError(e);});f.reply(2,j,"done","x".repeat(16384));
  j.commands={0:123};f.jobs.save();
  f.jobs.acknowledge(j);f.jobs.acknowledge(j);
  assert.strictEqual(f.requests.length,4,"one in-flight acknowledgment");
  assert.ok(f.data["pebble-agent.jobs.v1"].length<250);
  assert.ok(!j.result&&!j.body&&!j.commands);
  f.reply(1,j,"working");assert.strictEqual(j.status,"done");
  f.requests[3].onerror();
  var restored=fixture(f.data);restored.jobs.retryAcknowledgements();
  assert.strictEqual(restored.requests.length,1);
  var x=restored.requests[0];x.status=200;x.responseText=JSON.stringify({id:j.id,status:"done",retrieved:true});x.onload();
  assert.strictEqual(restored.jobs.entries.length,0);
  restored.jobs.accept(j,{id:j.id,status:"working"},true);
  assert.strictEqual(restored.jobs.entries.length,0,"late response cannot resurrect the job");
 });
 test("Failed receipt writes preserve results and failed cleanup writes remain retryable",function(){
  var f=fixture(),j=f.jobs.submit(request);f.reply(0,j,"done","PAM");
  var save=f.options.storage.setItem;f.options.storage.setItem=function(){throw new Error("full");};
  assert.throws(function(){f.jobs.acknowledge(j);},/full/);
  assert.strictEqual(j.result,"PAM");assert.ok(!j.opened);assert.strictEqual(f.requests.length,1);
  f.options.storage.setItem=save;f.jobs.acknowledge(j);
  f.options.storage.setItem=function(){throw new Error("full");};
  var x=f.requests[1];x.status=200;x.responseText=JSON.stringify({id:j.id,retrieved:true});x.onload();
  assert.strictEqual(f.jobs.entries.length,1);
  f.options.storage.setItem=save;f.jobs.retryAcknowledgements();
  f.reply(2,j,"","",404);assert.strictEqual(f.jobs.entries.length,0,"expired server jobs need no ack");
 });
 test("Result persistence failure rolls back terminal status so a check can retry",function(){
  var f=fixture(),j=f.jobs.submit(request),save=f.options.storage.setItem;
  f.options.storage.setItem=function(){throw new Error("full");};f.reply(0,j,"done","PAM");
  assert.strictEqual(j.status,"sending");assert.ok(!j.result);
  f.options.storage.setItem=save;f.jobs.check(j.id,function(e){assert.ifError(e);});
  f.reply(1,j,"done","PAM");assert.strictEqual(j.result,"PAM");
 });
 test("Acknowledged history stays empty while 24 pending jobs remain supported",function(){
  var f=fixture();
  for(var i=0;i<100;i++){
   var n=f.requests.length,j=f.jobs.submit(request);f.reply(n,j,"done","x".repeat(16384));f.jobs.acknowledge(j);
   var x=f.requests[n+1];x.status=200;x.responseText=JSON.stringify({id:j.id,retrieved:true});x.onload();
  }
  assert.strictEqual(f.data["pebble-agent.jobs.v1"],"[]");
  for(var k=0;k<24;k++)f.jobs.submit(request);
  assert.throws(function(){f.jobs.submit(request);},/24 pending/);
 });
};
