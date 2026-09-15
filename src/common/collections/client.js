"use strict";
var J=require("./journal");
var CACHE="codey.collections.cache.v1";
function Client(options){this.options=options;this.storage=options.storage;var self=this;this.journal=new J.Journal(this.storage,{evictCache:function(){self.storage.removeItem(CACHE);self.cache={pages:{},records:{}};}});this.cache={pages:{},records:{}};try{var c=JSON.parse(this.storage.getItem(CACHE));if(c&&c.scope===JSON.stringify(this.journal.data.scope))this.cache=c;}catch(_){}this.busy=false;this.quarantined=false;this.collections=[];}
Client.prototype.saveCache=function(){this.cache.scope=JSON.stringify(this.journal.data.scope);var raw=JSON.stringify(this.cache);if(raw.length*2>1024*1024){this.cache={pages:{},records:{},scope:this.cache.scope};raw=JSON.stringify(this.cache);}try{this.storage.setItem(CACHE,raw);}catch(_){this.storage.removeItem(CACHE);}};
Client.prototype.request=function(method,path,body,done,recovery){var options=this.options,scope=this.journal.data.scope,base=options.base(),token=options.token();if(!recovery&&scope&&(scope.base!==base||scope.credential!==J.checksum(token))){this.quarantined=true;done(new Error("Server settings changed. Original pending work is quarantined."));return;}if(!base||!token){done(new Error("Configure the collection server URL and bearer token."));return;}if(!/^https:\/\//.test(base)&&!(options.allowHTTP&&options.allowHTTP())){done(new Error("Collection HTTP requires explicit development permission."));return;}var xhr,ended=false;function finish(e,v){if(ended)return;ended=true;done(e,v);}try{xhr=new options.XMLHttpRequest();xhr.open(method,base.replace(/\/$/,"")+path,true);xhr.timeout=15000;xhr.setRequestHeader("Authorization","Bearer "+token);xhr.setRequestHeader("Content-Type","application/json");xhr.onload=function(){var v;try{v=JSON.parse(xhr.responseText);}catch(_){finish(new Error("Invalid collection server response."));return;}if(xhr.status<200||xhr.status>=300){var e=new Error(v.message||"Collection request failed.");e.code=v.code;e.status=xhr.status;finish(e);return;}finish(null,v);};xhr.onerror=xhr.ontimeout=function(){finish(new Error("Collection server unavailable."));};xhr.send(body==null?null:JSON.stringify(body));}catch(e){finish(e);}};
Client.prototype.connect=function(done){
 var self=this;
 if(this.connectWaiters){this.connectWaiters.push(done);return;}
 this.connectWaiters=[done];
 this.connectOnce(function(e){var waiters=self.connectWaiters;self.connectWaiters=null;waiters.forEach(function(callback){callback(e);});});
};
Client.prototype.ensure=function(done){
 if(this.journal.data.scope&&(this.collections.length||(this.cache.collections||[]).length)){done();return;}
 this.connect(done);
};
Client.prototype.connectOnce=function(done){var self=this;this.request("GET","/v1/sync/info",null,function(e,info){if(e)return done(e);if(info.protocol_version!==1||!info.server_instance_id||!info.store_epoch)return done(new Error("Unsupported collection server."));var scope=self.journal.data.scope;if(scope&&(scope.server_instance_id!==info.server_instance_id||scope.store_epoch!==info.store_epoch||scope.principal!==info.principal)){self.quarantined=true;return done(new Error("Server/store identity changed. Queue recovery required."));}function ready(){self.request("GET","/v1/collections?utc_offset_minutes="+(-new Date().getTimezoneOffset()),null,function(e,cols){if(!e){self.collections=cols;if(JSON.stringify(self.cache.collections)!==JSON.stringify(cols)){self.cache.collections=cols;self.saveCache();}}done(e);});}if(scope)return ready();self.request("POST","/v1/sync/clients",{},function(e,enrollment){if(e)return done(e);if(enrollment.server_instance_id!==info.server_instance_id||enrollment.store_epoch!==info.store_epoch)return done(new Error("Server identity changed during enrollment."));enrollment.base=self.options.base();enrollment.credential=J.checksum(self.options.token());try{self.journal.enroll(enrollment);}catch(e){return done(e);}ready();});});};
Client.prototype.collection=function(kind){var list=this.collections.length?this.collections:this.cache.collections||[];var c=list.filter(function(c){return c.kind===kind;})[0];if(!c)throw new Error("Connect collection server first.");return c;};
Client.prototype.accept=function(input){if(this.quarantined)throw new Error("Queue is quarantined. Recover original server first.");var scope=this.journal.data.scope;if(!scope||scope.base!==this.options.base()||scope.credential!==J.checksum(this.options.token()))throw new Error("Connect original collection server before saving.");return this.journal.accept(input);};
Client.prototype.drain=function(done){var self=this;if(this.busy)return done&&done();var entries=this.journal.data.entries.filter(function(e){return !e.receipt;});if(!entries.length)return done&&done();this.busy=true;var scope=this.journal.data.scope,batch={protocol_version:1,server_instance_id:scope.server_instance_id,store_epoch:scope.store_epoch,client_id:scope.client_id,operations:entries.slice(0,20).map(function(e){return e.operation;})};this.request("POST","/v1/sync/mutations",batch,function(e,data){self.busy=false;if(!e){try{data.results.forEach(function(r){self.journal.receipt(r);});}catch(error){e=error;}}if(e&&["store_epoch_changed","server_mismatch","binding_changed"].indexOf(e.code)>=0)self.quarantined=true;if(done)done(e,data);});};
Client.prototype.merge=function(records){var self=this;records.forEach(function(r){var old=self.cache.records[r.id];if(!old||J.compare(r.revision,old.revision)>=0)self.cache.records[r.id]=r;});};
Client.prototype.list=function(kind,state,snapshot,cursor,done,preferCache){var self=this;this.ensure(function(e){if(e)return done(e);self.listReady(kind,state,snapshot,cursor,done,preferCache);});};
Client.prototype.listReady=function(kind,state,snapshot,cursor,done,preferCache){
 var self=this,col;
 try{col=this.collection(kind);}catch(e){done(e);return;}
 var key=kind+":"+state+":"+(snapshot||"")+":"+(cursor||"");
 if(preferCache&&this.cache.pages[key]){done(null,this.project(this.cache.pages[key],kind,state));return;}
 function receive(e,p){
  if(e){
   var cached=self.cache.pages[key];
   if(cached){cached=J.clone(cached);cached.stale=true;done(null,self.project(cached,kind,state));}
   else done(e);
   return;
  }
  self.merge(p.records);self.cache.pages[key]=p;self.saveCache();
  try{self.journal.compact(self.cache.records);}catch(_){}
  done(null,self.project(p,kind,state));
 }
 if(snapshot){
  this.request("GET","/v1/sync/snapshots/"+encodeURIComponent(snapshot)+"?limit=8&page_token="+encodeURIComponent(cursor||""),null,receive);
 }else{
  this.request("POST","/v1/sync/snapshots",{collection_id:col.id,state:state,utc_offset_minutes:-new Date().getTimezoneOffset(),limit:8},receive);
 }
};
Client.prototype.project=function(page,kind,state){var p=J.clone(page),map={},self=this;p.records.forEach(function(r){var newer=self.cache.records[r.id];map[r.id]=newer&&J.compare(newer.revision,r.revision)>0?J.clone(newer):r;});this.journal.data.entries.forEach(function(e){var op=e.operation;if(op.collection_id!=="col_"+kind)return;if(e.receipt&&e.receipt.outcome!=="applied")return;var r=map[op.record_id];if(!r&&op.type.indexOf(".create")>0){r={id:op.record_id,collection_id:op.collection_id,kind:kind,revision:"",title:op.payload.title,completed:false,start:op.payload.start,end:op.payload.end,location:op.payload.location,body_complete:true,capabilities:kind==="event"?[]:kind==="note"?["note.replace","note.append"]:["task.complete","task.restore"]};map[r.id]=r;}if(!r)return;r.pending=true;if(op.payload.title)r.title=op.payload.title;if(op.type==="task.complete")r.completed=true;if(op.type==="task.restore")r.completed=false;if(op.type==="record.delete")r.deleted=true;if(e.receipt&&e.receipt.record)Object.assign(r,e.receipt.record);});p.records=Object.keys(map).map(function(k){return map[k];}).filter(function(r){return !r.deleted&&(kind==="event"?new Date(r.end.length===10?r.end+"T00:00:00":r.end).getTime()>Date.now():kind==="note"||r.completed===(state==="completed"));});
if(kind==="event")p.records.sort(function(a,b){return new Date(a.start.length===10?a.start+"T00:00:00":a.start)-new Date(b.start.length===10?b.start+"T00:00:00":b.start);});
p.total=Math.max(0,(typeof page.total==="number"?page.total:page.records.length)+p.records.length-page.records.length);
p.pending_count=this.journal.data.entries.filter(function(e){return !e.receipt;}).length;if(p.records.length>8){p.records=p.records.slice(0,8);p.partial=true;}return p;};
Client.prototype.body=function(record,cursor,done){var self=this,key=record.id+":"+record.revision+":"+(cursor||"");this.request("GET","/v1/records/"+encodeURIComponent(record.id)+"/body?revision="+encodeURIComponent(record.revision)+"&max_bytes=704&cursor="+encodeURIComponent(cursor||""),null,function(e,v){if(e){v=self.cache.pages[key];if(v){v=J.clone(v);v.stale=true;done(null,v);}else done(e);return;}self.cache.pages[key]=v;self.saveCache();done(null,v);});};
Client.prototype.recover=function(done){var self=this,scope=this.journal.data.scope;if(!scope)return this.connect(done);
 this.request("GET","/v1/sync/info",null,function(e,info){if(e)return done(e);if(info.server_instance_id!==scope.server_instance_id)return done(new Error("Recovery requires the original server identity."));var batch={protocol_version:1,server_instance_id:scope.server_instance_id,store_epoch:scope.store_epoch,client_id:scope.client_id,operations:self.journal.data.entries.filter(function(e){return !e.receipt;}).map(function(e){return e.operation;})};
 self.request("POST","/v1/sync/recovery",batch,function(e,data){if(e)return done(e);try{data.results.forEach(function(r){self.journal.receipt(r);});}catch(e){return done(e);}self.request("POST","/v1/sync/clients",{},function(e,next){if(e)return done(e);if(next.server_instance_id!==info.server_instance_id||next.store_epoch!==info.store_epoch)return done(new Error("Store changed during recovery."));next.base=self.options.base();next.credential=J.checksum(self.options.token());try{self.journal.update(function(d){if(d.entries.some(function(e){return !e.receipt||!e.receipt.durably_recorded;}))throw new Error("Pending input has not been handed off.");d.entries=[];d.receipts={};d.sequence=0;d.scope=next;});self.cache={pages:{},records:{}};self.saveCache();self.quarantined=false;done();}catch(e){done(e);}},true);},true);},true);
};
Client.prototype.exportJournal=function(){return JSON.stringify(this.journal.data);};
Client.prototype.agent=function(input,done){var self=this,old=this.journal.data.receipts[input.ingress];if(old){try{done(null,this.accept(input));}catch(e){done(e);}return;}this.request("GET","/v1/sync/ingress/"+encodeURIComponent(input.ingress),null,function(e,r){if(!e){if(r.request.type!==input.type||J.stable(r.request.payload)!==J.stable(input.payload)){done(new Error("Agent ingress identity reused with different input."));return;}done(null,r.request);return;}if(e.status!==404){done(e);return;}try{done(null,self.accept(input));}catch(e){done(e);}});};
module.exports={Client:Client,CACHE:CACHE};
