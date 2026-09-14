"use strict";
var Pam=require("./pam"),Wire=require("./watch-protocol");
function line(kind,attrs){return "  "+kind+" "+Pam.formatAttributes(attrs)+"\n";}
function Views(client){this.client=client;this.sequence=0;this.requestSequence=0;this.current=null;}
Views.prototype.begin=function(kind){this.current={token:(++this.sequence).toString(36),kind:kind,aliases:{}};return this.current;};
Views.prototype.resolve=function(token,alias){if(!this.current||this.current.token!==token||!this.current.aliases[alias])throw new Error("Stale view. Reopen the collection.");return this.current.aliases[alias];};
Views.prototype.list=function(kind,state,snapshot,cursor,done){var self=this,request=++this.requestSequence;this.client.list(kind,state,snapshot,cursor,function(e,p){if(request!==self.requestSequence)return done(new Error("View superseded"));if(e)return done(e);var view=self.begin(kind),source="pam version=1\nscreen "+Pam.formatAttributes({id:kind==="note"?"notes":"todos",layout:"list",title:kind==="note"?"Notes":state==="completed"?"Completed":"To-dos",status:true})+"\n";
 if(p.pending_count)source+=line("text",{id:"pending",value:p.pending_count+" saved on phone · Pending server"});
 if(p.partial)source+=line("text",{id:"partial",value:"Showing first 8 items; more available after sync"});
 if(p.stale)source+=line("text",{id:"stale",value:"Cached · Server unavailable"});
 p.records.forEach(function(r,i){var alias="r"+i;view.aliases[alias]={record:r,state:state};source+=line(kind==="task"?"choice":"item",{id:alias,title:kind==="note"?Wire.truncateUtf8(r.title,71):"",value:kind==="task"?Wire.truncateUtf8(r.title,179):"",action:kind==="note"?"local.note.open":r.completed?"local.todo.restore":"local.todo.complete",checked:!!r.completed,todo:kind==="task",subtitle:r.pending?"Pending server":r.provider_state==="synced"?"Synced":r.provider_state==="pending"?"Backend pending":"Saved on server"});});
 if(!p.records.length)source+=line("text",{id:"empty",value:"No items"});
 if(p.next_cursor){view.aliases.next={snapshot:p.snapshot_id,cursor:p.next_cursor,state:state};source+=line("item",{id:"next",title:"Next page",action:kind==="note"?"local.note.list":"local.todo.list",value:"next"});}
 source+=line("item",{id:"refresh",title:"Refresh / first page",action:kind==="note"?"local.notes":"local.todos"});
 if(kind==="task")source+=line("item",{id:"state",title:state==="completed"?"Active tasks":"Completed tasks",action:state==="completed"?"local.todos":"local.todo.archive"});
 done(null,{source:source+"done\n",token:view.token,list:{kind:kind,state:state,titles:p.records.map(function(r){return Wire.truncateUtf8(String(r.title||"").replace(/\s+/g," ").trim()||"Untitled",71);}),states:p.records.map(function(r){return r.pending?"p":r.provider_state==="synced"?"s":r.provider_state==="pending"?"b":"d";}).join(""),next:!!p.next_cursor,stale:!!p.stale,partial:!!p.partial,first:!snapshot&&state==="active",pending:p.pending_count||0}});});};
Views.prototype.body=function(record,cursor,done){var self=this,request=++this.requestSequence;this.client.body(record,cursor,function(e,p){if(request!==self.requestSequence)return done(new Error("View superseded"));if(e)return done(e);var view=self.begin("note");view.aliases.note={record:record};view.aliases.append={record:record};var source="pam version=1\nscreen "+Pam.formatAttributes({id:"note-detail",layout:"list",title:Wire.truncateUtf8(record.title,71),status:true})+"\n";if(p.stale)source+=line("text",{id:"stale",value:"Cached · Server unavailable"});Wire.splitUtf8(p.body,179).forEach(function(part,i){source+=line("text",{id:"body-"+i,value:part});});
 if(p.next_cursor){view.aliases.next={record:record,cursor:p.next_cursor};source+=line("item",{id:"next",title:"Next page",action:"local.note.page",note:"next",value:"next"});}
 if(record.body_complete&&(record.capabilities||[]).indexOf("note.replace")>=0)source+=line("item",{id:"note",title:"Replace entire note",action:"local.note.edit"});
 if(record.body_complete&&(record.capabilities||[]).indexOf("note.append")>=0)source+=line("item",{id:"append",title:"Append to note",action:"local.note.append"});
 source+=line("item",{id:"back",title:"Back to notes",action:"local.notes"});done(null,{source:source+"done\n",token:view.token});});};
module.exports=Views;
