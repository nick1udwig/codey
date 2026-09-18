"use strict";
var assert=require("assert"), Actions=require("../src/common/job-actions");
module.exports=function(test){
 test("automatic actions validate the whole response and leave form choices untouched",function(){
  assert.equal(Actions.inspect('pam version=1\ncapability type=timer command=start duration=5m\nbogus broken\n'),null);
  var plan=Actions.inspect('pam version=1\nscreen id=choose layout=choice\n  choice id=one title=One action=local.run capability=timer seconds=60 task=Tea\ndone\n');
  assert.equal(plan.actions.length,0);
  plan=Actions.inspect('pam version=1\ncapability type=timer command=start duration=5m\nscreen id=answer layout=card\n  text id=t value=Started\ndone\n');
  assert.equal(plan.actions.length,1);assert.equal(plan.onlyActions,false);
 });
 test("automatic action receipts survive restart and failed receipt writes retry safely",function(){
  var executions=[],saved,complete=0,failSave=false;
  var job={id:"abc",status:"done",result:'pam version=1\ncapability type=timer command=start duration=5m\ncapability type=note command=add value=Hello\n'};
  var options={save:function(){if(failSave)throw Error("disk full");saved=JSON.stringify(job);},run:function(j,a,done){executions.push({index:a.index,done:done});},update:function(){},complete:function(){complete++;}};
  var runner=new Actions.Runner(options);runner.process(job);runner.process(job);assert.equal(executions.length,1);
  executions[0].done();assert.equal(executions[1].index,1);
  job=JSON.parse(saved);runner=new Actions.Runner(options);runner.process(job);assert.equal(executions[2].index,1);
  failSave=true;executions[2].done();assert.equal(complete,0);assert.ok(!job.executed[1]);
  failSave=false;runner.process(job);executions[3].done();assert.equal(complete,1);
 });
};
