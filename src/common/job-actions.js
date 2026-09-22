"use strict";
var Pam=require("./pam"), Model=require("./model");

// Validate the complete result before executing any standalone command. Form
// actions are choices for the user, not commands to execute on completion.
function inspect(source) {
  var actions=[],index=0,failed=false,other=false;
  var model=new Model.ScreenModel({onError:function(){failed=true;},onOperation:function(op){
    if(op.type==="agent_error")failed=true;
    if(op.type==="begin")other=true;
    if(op.type!=="capability")return;
    var a=op.node.attrs, current=index++;
    var local=/^(timer|alarm|reminder|stopwatch)$/.test(a.type) && !/^(show|list)$/.test(a.command);
    var collection=/^(todo|note|calendar)$/.test(a.type) && a.command==="add";
    var settings=a.type==="settings" && a.command==="set";
    if(local||collection||settings)actions.push({attrs:a,index:current});else other=true;
    // Keep the result available so opening it can show the saved preference.
    if(settings)other=true;
  }});
  var parser=new Pam.Parser({requireHeader:true,maxDepth:8,maxLineLength:2048,onNode:function(n){model.accept(n);},onError:function(){failed=true;}});
  parser.push(source);parser.finish();
  return failed?null:{actions:actions,onlyActions:actions.length>0&&!other};
}

function Runner(options){this.options=options;this.busy={};}
Runner.prototype.process=function(job){
  var self=this, o=self.options;
  if(job.opened||job.status!=="done"||!job.result||self.busy[job.id])return false;
  var plan=inspect(job.result);if(!plan||!plan.actions.length)return false;
  self.busy[job.id]=true;
  function next(){
    var action=plan.actions.filter(function(a){return !(job.executed||{})[a.index];})[0];
    if(!action){delete self.busy[job.id];try{if(plan.onlyActions)o.complete(job);else o.update(job);}catch(e){job.error="Could not save completion receipt. Open the job to retry.";o.update(job);}return;}
    o.run(job,action,function(error){
      if(error){delete self.busy[job.id];job.error=error.message;o.update(job);return;}
      job.executed=job.executed||{};job.executed[action.index]=true;
      try{o.save();}catch(e){delete job.executed[action.index];delete self.busy[job.id];job.error="Could not save action receipt. Reconnect to retry.";o.update(job);return;}
      job.error="";next();
    });
  }
  next();return true;
};
module.exports={inspect:inspect,Runner:Runner};
