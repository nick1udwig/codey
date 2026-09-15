"use strict";
var Pam=require("./pam"),Wire=require("./watch-protocol");
function line(kind,attrs){return "  "+kind+" "+Pam.formatAttributes(attrs)+"\n";}
function eventTitle(r){var d=new Date(r.start),months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];var when=String(r.start).length===10?r.start+" All day":months[d.getMonth()]+" "+d.getDate()+" "+d.getHours()+":"+("0"+d.getMinutes()).slice(-2);return when+" · "+r.title;}
function eventMeta(r) {
 var allDay=String(r.start).length===10,d=new Date(r.start),end=new Date(r.end);
 // Seconds since this local day's midnight preserve DST overlaps and avoid
 // overflowing the watch's signed 32-bit integers for dates beyond 2038.
 var midnight=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
 function pad(n){return ("0"+n).slice(-2);}
 return Pam.formatAttributes({day:allDay?r.start:d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()),
  time:allDay?"All day":pad(d.getHours())+":"+pad(d.getMinutes()),
  start:allDay?0:Math.floor((d.getTime()-midnight)/1000),
  end:Math.floor((end.getTime()-(allDay?d.getTime():midnight))/1000),
  all_day:allDay,location:Wire.truncateUtf8(String(r.location||"").replace(/\s+/g," "),28)});
}
function Views(client){this.client=client;this.sequence=0;this.requestSequence=0;this.current=null;this.pages={};this.eventPages=[];}
Views.prototype.begin=function(kind){this.current={token:(++this.sequence).toString(36),kind:kind,aliases:{}};return this.current;};
Views.prototype.resolve=function(token,alias){if(!this.current||this.current.token!==token||!this.current.aliases[alias])throw new Error("Stale view. Reopen the collection.");return this.current.aliases[alias];};
Views.prototype.list=function(kind,state,snapshot,cursor,done,preferCache){
 var self=this,request=++this.requestSequence;
 this.client.list(kind,state,snapshot,cursor,function(e,p){
  if(request!==self.requestSequence)return done(new Error("View superseded"));
  if(e)return done(e);
  var view=self.begin(kind),titles=[],states=[],timeline=[];
  self.pages[kind]={state:state,snapshot:snapshot||"",cursor:cursor||"",ids:p.records.map(function(r){return r.id;})};
  if(kind==="event") {
   if(!cursor)self.eventPages=[];
   var pageIndex=-1;
   self.eventPages.forEach(function(page,i){if(page.cursor===cursor&&page.snapshot===snapshot)pageIndex=i;});
   if(pageIndex>=0)self.eventPages=self.eventPages.slice(0,pageIndex);
   if(self.eventPages.length)view.aliases.previous=self.eventPages[self.eventPages.length-1];
   self.eventPages.push(self.pages[kind]);
  }
  p.records.forEach(function(r,i){
   view.aliases["r"+i]={record:r,state:state,snapshot:snapshot||"",cursor:cursor||""};
   titles.push(Wire.truncateUtf8(String(r.title||"").replace(/\s+/g," ").trim()||"Untitled",71));
   if(kind==="event")timeline.push(eventMeta(r));
   states.push(r.pending?"p":r.provider_state==="synced"?"s":r.provider_state==="pending"?"b":"d");
  });
  if(p.next_cursor)view.aliases.next={snapshot:p.snapshot_id,cursor:p.next_cursor,state:state};
  done(null,{token:view.token,list:{kind:kind,state:state,total:p.total,titles:titles,timeline:timeline,states:states.join(""),previous:!!view.aliases.previous,next:!!p.next_cursor,stale:!!p.stale,partial:!!p.partial,first:!snapshot&&state==="active",pending:p.pending_count||0}});
 },preferCache);
};
Views.prototype.body=function(record,cursor,done){var self=this,request=++this.requestSequence;this.client.body(record,cursor,function(e,p){if(request!==self.requestSequence)return done(new Error("View superseded"));if(e)return done(e);var calendar=record.kind==="event",view=self.begin(calendar?"event":"note");view.aliases.note={record:record};view.aliases.append={record:record};var source="pam version=1\nscreen "+Pam.formatAttributes({id:calendar?"event-detail":"note-detail",layout:"list",title:Wire.truncateUtf8(record.title,71),status:true})+"\n";if(calendar){source+=line("text",{id:"when",value:eventTitle(record).split(" · ")[0]});source+=line("text",{id:"until",value:"Ends: "+(record.end.length===10?record.end+" (exclusive)":new Date(record.end).toLocaleString())});if(record.location)source+=line("text",{id:"where",value:Wire.truncateUtf8(record.location,179)});}
 if(p.stale)source+=line("text",{id:"stale",value:"Cached · Server unavailable"});Wire.splitUtf8(p.body,179).forEach(function(part,i){source+=line("text",{id:"body-"+i,value:part});});
 if(p.next_cursor){view.aliases.next={record:record,cursor:p.next_cursor};source+=line("item",{id:"next",title:"Next page",action:calendar?"local.event.page":"local.note.page",note:"next",value:"next"});}
 if(record.body_complete&&(record.capabilities||[]).indexOf("note.replace")>=0)source+=line("item",{id:"note",title:"Replace entire note",action:"local.note.edit"});
 if(record.body_complete&&(record.capabilities||[]).indexOf("note.append")>=0)source+=line("item",{id:"append",title:"Append to note",action:"local.note.append"});
 if(calendar&&self.pages.event){view.aliases.back=self.pages.event;view.aliases.back.focus=Math.max(0,self.pages.event.ids.indexOf(record.id));}
 source+=line("bind",{id:"back",input:"back",action:calendar&&view.aliases.back?"local.event.list":calendar?"local.events":"local.notes",value:calendar&&view.aliases.back?"return":""});done(null,{source:source+"done\n",token:view.token});});};
module.exports=Views;
