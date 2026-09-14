"use strict";

var Endpoints = require("../common/endpoints");
var Pam = require("../common/pam");
var Model = require("../common/model");
var WatchProtocol = require("../common/watch-protocol");
var AgentClient = require("../common/agent-client").AgentClient;
var JobModule = require("../common/jobs");
var Settings = require("../common/settings");
var Capabilities = require("../common/capabilities");
var Weather = require("../common/weather");
var DashboardStatus = require("../common/dashboard-status");
var CollectionClient = require("../common/collections/client").Client;
var CollectionViews = require("../common/collection-views");
var LocalDictation = require("../common/local-dictation");

var Key = WatchProtocol.Key;
var settings = Settings.load();
var client = new AgentClient();
var requestSequence = 0;
var activeRequestId = 0;
var activePipeline = null;
var currentScreen = { id: "", layout: "", selected: "" };
var watchInfo = {};
var watchReady = false;
var failedDeliveries = {};
var sessionId = loadSessionId();
var commandSequence = loadCommandSequence();
var collections=null, collectionViews=null, collectionError="", collectionTimer=null;
function collectionBase() {
 return (Endpoints.normalize(settings.endpoint)||"").replace(/\/v1\/agent$/,"").replace(/^ws:/,"http:").replace(/^wss:/,"https:");
}
try {
 collections=new CollectionClient({storage:localStorage,XMLHttpRequest:typeof XMLHttpRequest!=="undefined"?XMLHttpRequest:null,base:collectionBase,token:function(){return settings.token;},allowHTTP:function(){return settings.collectionDevelopmentHTTP;}});
 collectionViews=new CollectionViews(collections);
 collections.journal.bridge(Date.now().toString(36)+"-"+Math.floor(Math.random()*0xffffff).toString(36));
} catch(e){collectionError=e.message;}
function collectionHandshake(){
 if(!collections)return;
 var m={};m[Key.messageType]="bridge";m[Key.operation]="collections";m[Key.collectionProtocol]=1;m[Key.bridgeSession]=collections.journal.data.bridge;watchQueue.enqueue(m);
}
function syncCollections(){
 if(!collections||!collectionBase()||!settings.token)return;
 collections.connect(function(e){if(!e)collections.drain();});
 if(collectionTimer)clearTimeout(collectionTimer);
 collectionTimer=setTimeout(syncCollections,60000);
 if(collectionTimer&&collectionTimer.unref)collectionTimer.unref();
}
function collectionAck(payload,state,text){var m={};m[Key.messageType]="collection-ack";m[Key.bridgeSession]=String(read(payload,Key.bridgeSession,"BridgeSession")||"");m[Key.eventSequence]=Number(read(payload,Key.eventSequence,"EventSequence")||0);m[Key.deliveryState]=state;m[Key.value]=text;if(state==="rejected")m[Key.errorCode]=/stale|session|view/i.test(text)?"stale_view":/reused/i.test(text)?"idempotency_mismatch":"invalid_input";watchQueue.enqueue(m);}
function renderCollection(requestId,error,view){
 if(requestId!==activeRequestId)return;
 if(error){sendStatus(error.message,"error",requestId);return;}
 var m={};m[Key.requestId]=requestId;m[Key.viewToken]=view.token;
 if(view.list){
  var list=view.list;m[Key.messageType]="collection-list";m[Key.operation]=list.kind;
  m[Key.value]=list.titles.join("\n");m[Key.meta]=list.states;
  m[Key.flags]=(list.state==="completed"?1:0)|(list.next?2:0)|(list.stale?4:0)|(list.partial?8:0)|(list.first?16:0);
  m[Key.subtitle]=list.stale?"Cached · Server unavailable":list.pending?list.pending+" pending server":list.partial?"First 8 · More after sync":"Saved on server";
  watchQueue.enqueue(m);
 }else{m[Key.messageType]="collection-view";watchQueue.enqueue(m);capabilityContext(requestId).renderPam(view.source);}
 sendAnswerNotification(requestId,"complete",true);
}
function handleCollectionRequest(kind,action,id,value,token,payload){
 var requestId=nextRequestId();activeRequestId=requestId;sendAnswerNotification(requestId,"begin",true,token);
 if(!collections){sendStatus(collectionError||"Collections unavailable","error",requestId);return;}
 var started=Date.now(),viewToken=String(read(payload,Key.viewToken,"ViewToken")||""),done=function(e,v){log("collection read "+kind+" "+action+" ms="+(Date.now()-started));renderCollection(requestId,e,v);};
 try {
  if(action==="list"||action==="archive"){
   if(value==="next"){var page=collectionViews.resolve(viewToken,"next");collectionViews.list(kind,page.state,page.snapshot,page.cursor,done);}
   else collectionViews.list(kind,action==="archive"?"completed":"active","","",done);
   collections.drain();return;
  }
  var session=String(read(payload,Key.bridgeSession,"BridgeSession")||""),seq=Number(read(payload,Key.eventSequence,"EventSequence")||0),ingress="watch:"+session+":"+seq;
  var receipt=collections.journal.data.receipts[ingress];
  if(receipt){if(receipt.alias!==id||receipt.view!==viewToken||receipt.operation.type!==({edit:"note.replace",append:"note.append",complete:"task.complete",restore:"task.restore"}[action])||JSON.stringify(receipt.operation.payload)!==JSON.stringify(action==="edit"?{body:value,whole_note:true}:action==="append"?{text:value}:{}))throw new Error("Event identity reused with different input.");collectionAck(payload,"accepted_phone","Saved on phone · Pending server");collections.drain();return;}
  var target=collectionViews.resolve(viewToken,id);
  if(action==="read"){collectionViews.body(target.record,target.cursor||"",done);return;}
  if(session!==collections.journal.data.bridge||seq<=0)throw new Error("Stale collection session.");
  var type={edit:"note.replace",append:"note.append",complete:"task.complete",restore:"task.restore"}[action];if(!type||(target.record.capabilities||[]).indexOf(type)<0)throw new Error("Action unavailable for this record.");
  var col=collections.collection(kind);var accepted=collections.accept({alias:id,view:viewToken,ingress:ingress,collection_id:col.id,generation:col.binding_generation,record_id:target.record.id,revision:target.record.revision,type:type,payload:action==="edit"?{body:value,whole_note:true}:action==="append"?{text:value}:{}});
  collectionAck(payload,"accepted_phone","Saved on phone · Pending server");
  collections.drain(function(e,data){if(!e&&data&&data.results.some(function(r){return r.operation_id===accepted.id&&r.durably_recorded&&r.outcome==="applied";}))collectionAck(payload,"accepted_server","Saved on server");else if(!e&&data&&data.results.some(function(r){return r.operation_id===accepted.id&&r.durably_recorded;}))collectionAck(payload,"needs_attention","Needs attention in server settings");});
  collectionViews.list(kind,target.state||"active","","",function(e,v){if(e){sendStatus("Saved on phone · Pending server. List unavailable.","show",requestId);sendAnswerNotification(requestId,"complete",true);}else done(null,v);});
 }catch(e){collectionAck(payload,"rejected",e.message);sendStatus(e.message,"error",requestId);}
}
function phoneCollection(attrs,requestId,complete,job,commandIndex){
 if(!collections){sendStatus(collectionError||"Collections unavailable","error",requestId);if(complete)complete(false);return;}
 collections.ensure(function(e){
  if(e){sendStatus(e.message,"error",requestId);if(complete)complete(false);return;}
  phoneCollectionReady(attrs,requestId,complete,job,commandIndex);
 });
}
function phoneCollectionReady(attrs,requestId,complete,job,commandIndex){
 var kind=attrs.type==="todo"?"task":"note";
 function finish(e,op){if(e){sendStatus(e.message,"error",requestId);if(complete)complete(false);return;}var delivery="Saved on phone · Pending server";collections.drain(function(error,data){if(error||!op||!data)return;data.results.forEach(function(r){if(r.operation_id===op.id&&r.durably_recorded){delivery=r.outcome==="applied"?"Saved on server":"Needs attention in server settings";if(requestId===activeRequestId)sendStatus(delivery,"show",requestId);}});});collectionViews.list(kind,"active","","",function(e,v){if(e&&op){sendStatus(delivery+" · List unavailable","show",requestId);sendAnswerNotification(requestId,"complete",true);if(complete)complete(true);return;}renderCollection(requestId,e,v);if(op)sendStatus(delivery,"show",requestId);if(complete)complete(!e);});}
 try{if(!collections)throw new Error(collectionError);if(attrs.command==="list"||attrs.command==="archive"){collectionViews.list(kind,attrs.command==="archive"?"completed":"active","","",function(e,v){renderCollection(requestId,e,v);if(complete)complete(!e);});return;}if(attrs.command!=="add")throw new Error("Open the collection and choose a record to edit.");var col=collections.collection(kind),scope=collections.journal.data.scope;
 var input={ingress:job?"agent:"+scope.server_instance_id+":"+job.id+":"+commandIndex:"direct:"+scope.client_id+":"+nextCommandId(),collection_id:col.id,generation:col.binding_generation,type:kind+".create",payload:kind==="note"?{title:WatchProtocol.truncateUtf8(String(attrs.title||attrs.value).replace(/\s+/g," "),71),body:String(attrs.value||""),body_format:"plain"}:{title:String(attrs.value||attrs.title||"")}};
 if(job)collections.agent(input,finish);else finish(null,collections.accept(input));
 }catch(e){finish(e);}
}


function loadCommandSequence() {
  try {
    var value = Number(localStorage.getItem("pebble-agent.command-sequence.v1"));
    if (value >= 0 && value < 2147483647 && Math.floor(value) === value) { return value; }
  } catch (error) { /* Use a per-runtime fallback if storage is unavailable. */ }
  return Math.floor(Math.random() * 1073741824);
}

function nextCommandId() {
  commandSequence = commandSequence >= 2147483646 ? 1 : commandSequence + 1;
  try { localStorage.setItem("pebble-agent.command-sequence.v1", String(commandSequence)); }
  catch (error) { log("command sequence could not be saved", error); }
  return commandSequence;
}

function log(message, detail) {
  if (typeof console !== "undefined" && console.log) {
    console.log("[agent] " + message + (detail ? ": " + (detail.message || String(detail)) : ""));
  }
}

function read(payload, numericKey, namedKey) {
  if (!payload) { return undefined; }
  if (payload[numericKey] != null) { return payload[numericKey]; }
  return payload[namedKey];
}

function loadSessionId() {
  var key = "pebble-agent.session.v1";
  var value;
  try {
    value = localStorage.getItem(key);
    if (!value) {
      value = String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
      localStorage.setItem(key, value);
    }
    return value;
  } catch (error) {
    return String(Date.now());
  }
}

var watchQueue = new WatchProtocol.MessageQueue(function(message, success, failure) {
  var started=Date.now();
  Pebble.sendAppMessage(message, function(){if(message[Key.messageType]==="collection-list")log("collection Bluetooth ack ms="+(Date.now()-started));success();}, failure);
}, {
  maxQueue: 96,
  maxRetries: 3,
  retryDelay: 120,
  onError: function(error, message) {
    if (message && message[Key.requestId]) { failedDeliveries[message[Key.requestId]] = true; watchQueue.clearRequest(message[Key.requestId]); }
    log("watch message failed", error);
  }
});

function startNewSession() {
  var next = String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
  if (next === sessionId) { next += "-new"; }
  localStorage.setItem("pebble-agent.session.v1", next);
  var previous = activeRequestId;
  activeRequestId = 0;
  activePipeline = null;
  client.abort();
  if (previous) { watchQueue.clearRequest(previous); }
  sessionId = next;
  currentScreen = { id: "", layout: "", selected: "" };
}

function sendStatus(text, operation, requestId) {
  var message = {};
  message[Key.messageType] = "status";
  message[Key.requestId] = requestId || activeRequestId || 0;
  message[Key.operation] = operation || "show";
  message[Key.value] = WatchProtocol.truncateUtf8(text || "", 180);
  watchQueue.enqueue(message);
}

function sendControl(operation, requestId) {
  var message = {};
  message[Key.messageType] = "control";
  message[Key.requestId] = requestId || 0;
  message[Key.operation] = operation || "";
  watchQueue.enqueue(message);
}

var lastDashboardStatus="";
var dashboardStatus=new DashboardStatus({
 settings:function(){return settings;},XMLHttpRequest:typeof XMLHttpRequest!=="undefined"?XMLHttpRequest:null,
 update:function(status){
  var signature=JSON.stringify(status);if(signature===lastDashboardStatus)return;lastDashboardStatus=signature;
  var m={};m[Key.messageType]="bridge";m[Key.operation]="codex-status";
  m[Key.value]=status.remainingPercent===null?"-1":String(status.remainingPercent);
  m[Key.index]=status.activeThreads===null?-1:status.activeThreads;m[Key.subtitle]=status.state;watchQueue.enqueue(m);
 }
});
function sendPreferences() {
  var m={};m[Key.messageType]="bridge";m[Key.operation]="preferences";
  m[Key.flags]=settings.tapAnimation?1:0;watchQueue.enqueue(m);
}
function sendNoteMessage(command,id,value) {
  var m={};m[Key.messageType]="notes";m[Key.operation]=command;
  m[Key.elementId]=id||"";m[Key.value]=String(value||"");watchQueue.enqueue(m);
}

function sendConnection() {
  var message = {};
  message[Key.messageType] = "bridge";
  message[Key.value] = settings.endpoint ? "codey connected · Hold Select to talk" : "Configure endpoint in phone settings";
  watchQueue.enqueue(message);
}

function sendAnswerNotification(requestId, operation, quiet, token) {
  var message = {};
  message[Key.messageType] = "answer";
  message[Key.requestId] = requestId;
  message[Key.operation] = operation || "complete";
  message[Key.flags] = !quiet && settings.answerVibrate ? 1 : 0;
  if (token) message[Key.index] = token;
  watchQueue.enqueue(message);
}

function nextRequestId() {
  requestSequence += 1;
  if (requestSequence > 65535) {
    requestSequence = 1;
  }
  return requestSequence;
}

var weatherBusy = false;
var weatherHandler = Weather.createWeatherHandler();
var lastWeatherMessage = "";
var weatherCacheKey = "pebble-agent.weather.v1";
function sendWeather(summary) {
  var message = {};
  message[Key.messageType] = "bridge";
  message[Key.operation] = "weather";
  message[Key.value] = summary ? summary.temperature + summary.unit : "";
  message[Key.subtitle] = summary ? "L " + summary.low + " H " + summary.high : "";
  message[Key.meta] = summary ? "icon=" + summary.icon : "";
  var signature = JSON.stringify(message);
  if (signature !== lastWeatherMessage) {
    lastWeatherMessage = signature;
    watchQueue.enqueue(message);
  }
}
function saveWeather(summary) {
  try { localStorage.setItem(weatherCacheKey, JSON.stringify(summary)); } catch (_) {}
  sendWeather(summary);
}
function refreshWeather() {
  if (!watchReady || weatherBusy) { return; }
  try {
    var cached = JSON.parse(localStorage.getItem(weatherCacheKey) || "null");
    sendWeather(cached && Date.now() - cached.updated < 60 * 60 * 1000 ? cached : null);
    if (cached && Date.now() >= cached.updated && Date.now() - cached.updated < 15 * 60 * 1000) { return; }
  } catch (_) { sendWeather(null); }
  weatherBusy = true;
  weatherHandler({ command: "current" }, {
    settings: settings,
    summary: saveWeather,
    status: function() {},
    renderPam: function() { weatherBusy = false; },
    error: function(reason) { weatherBusy = false; log("Dashboard weather unavailable", reason); }
  });
}

function capabilityContext(requestId, complete, isFailed, job, commandIndex) {
  return {
    settings: settings,
    summary: saveWeather,
    phoneNote: function(attrs) { phoneCollection(attrs,requestId,complete,job,commandIndex); },
    sendWatchCapability: function(operation) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      // Assign once before queueing; retries retain the same ID, while new
      // model commands (even in the same response) receive different IDs.
      if (job) {
        if (!job.commands[commandIndex]) { job.commands[commandIndex] = nextCommandId(); jobManager.save(); }
        operation.invocationId = job.commands[commandIndex];
      } else { operation.invocationId = nextCommandId(); }
      watchQueue.enqueueOperation(operation, requestId);
      if (complete) { complete(true); }
    },
    renderPam: function(source) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      var pipeline = createPipeline(requestId);
      pipeline.parser.push(source);
      pipeline.parser.finish();
      if (complete) { complete(!pipeline.failed()); }
    },
    status: function(text) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      sendStatus(text, "show", requestId);
    },
    error: function(text) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      sendStatus(text, "error", requestId);
      if (complete) { complete(false); }
    }
  };
}

var capabilityRegistry = Capabilities.installBuiltins(
  new Capabilities.CapabilityRegistry(),
  weatherHandler
);
capabilityRegistry.register("note", function(attrs, context) { attrs.type="note"; context.phoneNote(attrs); });
capabilityRegistry.register("todo", function(attrs, context) { attrs.type="todo"; context.phoneNote(attrs); });

function createPipeline(requestId, job) {
  var capabilityIndex = 0;
  var pipeline = {};
  var sawRenderable = false;
  var failed = false;
  var finished = false;
  var pendingCapabilities = 0;
  var notified = false;
  function notifyIfFinished() {
    if (finished && !pendingCapabilities && !failed && sawRenderable && !notified && requestId === activeRequestId) {
      notified = true;
      sendStatus("", "idle", requestId);
      if (!job) { sendAnswerNotification(requestId); } else { sendJobPresented(job, requestId); }
    }
  }
  var model = new Model.ScreenModel({
    onOperation: function(operation) {
      if (failed) { return; }
      if (operation.type === "agent_error") {
        pipeline.fail(operation.node.attrs.message || operation.node.attrs.value || "Agent request failed");
        return;
      }
      if (operation.type === "begin") {
        sawRenderable = true;
        currentScreen.id = operation.node.attrs.id;
        currentScreen.layout = operation.node.attrs.layout;
        currentScreen.selected = "";
      }
      if (operation.type === "capability") {
        sawRenderable = true;
        pendingCapabilities += 1;
        var completed = false;
        if (!capabilityRegistry.handle(operation, capabilityContext(requestId, function(success) {
          if (completed) { return; }
          completed = true;
          pendingCapabilities -= 1;
          if (!success) { failed = true; }
          notifyIfFinished();
        }, function() { return failed; }, job, capabilityIndex++))) {
          pendingCapabilities -= 1;
          failed = true;
          sendStatus("Unsupported capability: " + operation.node.attrs.type, "error", requestId);
        }
        return;
      }
      watchQueue.enqueueOperation(operation, requestId);
    },
    onError: function(error) {
      failed = true;
      sendStatus("Bad agent UI at line " + error.line + ": " + error.message, "error", requestId);
    }
  });
  var parser = new Pam.Parser({
    requireHeader: true,
    maxDepth: 8,
    maxLineLength: 2048,
    onNode: function(node) {
      model.accept(node);
    },
    onError: function(error) {
      failed = true;
      sendStatus("Bad PAM at line " + error.line + ": " + error.message, "error", requestId);
    }
  });
  pipeline.parser = parser;
  pipeline.model = model;
  pipeline.sawRenderable = function() { return sawRenderable; };
  pipeline.failed = function() { return failed; };
  pipeline.fail = function(message) {
    if (failed) { return; }
    failed = true;
    sendStatus(message || "Agent request failed", "error", requestId);
  };
  pipeline.finishAnswer = function() { finished = true; notifyIfFinished(); };
  return pipeline;
}

function platformName(info) {
  return info.platform || info.model || "unknown";
}

function requestAgent(input) {
  var requestId = nextRequestId();
  var pipeline = createPipeline(requestId);
  var previous = activeRequestId;
  var now = new Date();

  if (previous) {
    watchQueue.clearRequest(previous);
  }
  activeRequestId = requestId;
  activePipeline = pipeline;
  var local = input.kind === "dictation" ? LocalDictation.parse(input.text, now) : null;
  if (local) { sendAnswerNotification(requestId, "begin"); }
  if (local) {
    sendJob({ id:"pending" }, false, "remove");
    // Invalidate callbacks before aborting: a canceled server response must not
    // replace a local result or start a second timer. Use the normal capability
    // queue so delivery retries keep the same invocation ID.
    client.abort();
    pipeline.model.accept({ kind: local.node.kind, attrs: local.node.attrs, depth: 0 });
    pipeline.finishAnswer();
    return;
  }
  selectedJob = "";
  try { jobManager.submit({
    id: requestId,
    session: sessionId,
    endpoint: settings.endpoint,
    token: settings.token,
    timeoutSeconds: settings.timeoutSeconds,
    input: input,
    context: { screen: currentScreen.id, layout: currentScreen.layout, selected: currentScreen.selected },
    backend: {
      model: settings.codexModel, effort: settings.codexEffort, fast_mode: String(settings.fastMode),
      web_search: settings.webSearch, file_access: settings.fileAccess,
      network_access: String(settings.networkAccess), shell_access: String(settings.shellAccess),
      auto_review: String(settings.autoReview)
    },
    device: {
      platform: platformName(watchInfo),
      model: watchInfo.model || "unknown",
      shape: platformName(watchInfo) === "gabbro" ? "round" : "rect",
      touch: platformName(watchInfo) === "emery" || platformName(watchInfo) === "gabbro",
      now: Math.floor(now.getTime() / 1000),
      utc_offset_minutes: -now.getTimezoneOffset()
    }
  }); }
  catch(error) { sendJob({id:"pending",title:input.text || "Agent request",status:"failed",error:error.message},false); }

}


var selectedJob = "";
function sendJob(job, buzz, operation) {
  var message = {};
  message[Key.messageType] = "job";
  message[Key.operation] = operation || (job.status === "checking" ? "checking" : "upsert");
  message[Key.elementId] = job.id || "";
  message[Key.title] = WatchProtocol.truncateUtf8(job.title || "Agent request", 71);
  message[Key.subtitle] = job.status || "";
  message[Key.value] = WatchProtocol.truncateUtf8(job.error || "", 179);
  message[Key.flags] = buzz && settings.answerVibrate ? 1 : 0;
  watchQueue.enqueue(message);
}
var jobManager = new JobModule.Jobs({
  storage: localStorage, XMLHttpRequest: typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null,
  token: function() { return settings.token; },
  endpoint: function() { return JobModule.endpoint(settings.endpoint); },
  update: function(job, buzz) { if (!job.opened) { sendJob(job, buzz); } }
});
function sendJobPresented(job, requestId) {
  if (failedDeliveries[requestId]) { return; }
  var presented = {};
  presented[Key.messageType] = "job-result";
  presented[Key.requestId] = requestId;
  presented[Key.elementId] = job.id;
  watchQueue.enqueue(presented);
}
function openJob(id, cancel) {
  selectedJob = id;
  var requestId = nextRequestId();
  activeRequestId = requestId;
  delete failedDeliveries[requestId];
  sendAnswerNotification(requestId, "begin");
  var callback = function(error, job) {
    if (selectedJob !== id || activeRequestId !== requestId) { return; }
    if (error) {
      var cached = jobManager.find(id);
      sendJob({id:id,title:cached ? cached.title : "Agent request",status:cached ? cached.status : "Unknown",error:error.message},false);
      return;
    }
    if (job.status === "done" && job.result) {
      // Resume the conversation that produced this form, even if the user
      // started another thread while it was running.
      sessionId = job.session;
      localStorage.setItem("pebble-agent.session.v1", sessionId);
      var pipeline = createPipeline(requestId, job);
      activePipeline = pipeline;
      pipeline.parser.push(job.result); pipeline.parser.finish(); pipeline.finishAnswer();

    } else { sendJob(job, false); }
  };
  if (cancel) { jobManager.cancel(id, callback); } else { jobManager.check(id, callback); }
}

function handleWatchMessage(event) {
  var payload = event && event.payload || {};
  var type = String(read(payload, Key.messageType, "MessageType") || "");
  var operation = String(read(payload, Key.operation, "Operation") || "");
  var value = String(read(payload, Key.value, "Value") || "");
  var action = String(read(payload, Key.action, "Action") || "");
  var element = String(read(payload, Key.elementId, "ElementId") || "");
  var requestId = Number(read(payload, Key.requestId, "RequestId") || 0);

  if (type === "ready") {
    watchReady = true;
    lastWeatherMessage = "";
    lastDashboardStatus="";dashboardStatus.last=null;dashboardStatus.refresh();
    sendJob({}, false, "reset");
    jobManager.entries.forEach(function(job) { if (!job.opened) { sendJob(job, false); } });
    sendConnection();
    refreshWeather();
    sendPreferences();
    if(collections){collections.journal.bridge(Date.now().toString(36)+"-"+Math.floor(Math.random()*0xffffff).toString(36));}
    collectionHandshake(); syncCollections();
    return;
  }
  if (type === "capability_event" && operation === "status") {dashboardStatus.refresh();return;}
  if (type === "capability_event" && (operation === "note" || operation === "todo")) { handleCollectionRequest(operation==="note"?"note":"task",action,element,value,Number(read(payload,Key.meta,"Meta"))||0,payload);return; }
  if (type === "capability_event" && operation === "job") {
    if (action === "refresh") { jobManager.refreshAll(); return; }
    if (action === "retrieved" || action === "dismiss") {
      var job = jobManager.find(element);
      if (job) { jobManager.acknowledge(job); sendJob(job, false, "remove"); }
    } else { openJob(element, action === "cancel"); }
    return;
  }
  if (type === "capability_event" && operation === "weather" && action === "refresh") { refreshWeather(); return; }
  if (type === "input") {
    if (operation === "new-chat" && action === "local.new-chat") {
      startNewSession();
      sendControl("dictate", requestId);
      return;
    }
    if (operation === "selection") {
      currentScreen.selected = element;
    }
    if (action === "local.weather") {
      requestAgent({ kind: "dictation", text: "weather", action: action, element: "", value: "" });
      return;
    }
    requestAgent({
      kind: operation || "event",
      text: value,
      action: action,
      element: element,
      value: String(read(payload, Key.meta, "Meta") || "")
    });
    return;
  }
  if (type === "capability_event") {
    // Local completion, reset and acknowledgment must not launch a model turn
    // that replaces the notification dashboard or repeats an executed command.
    if (action !== "stopwatch.lap") { return; }
    requestAgent({
      kind: "capability",
      action: action || operation,
      element: element,
      value: value
    });
  }
}

Pebble.addEventListener("ready", function() {
  try {
    watchInfo = Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() || {} : {};
  } catch (error) {
    watchInfo = {};
  }
  log("PebbleKit JS ready on " + platformName(watchInfo));
});

Pebble.addEventListener("appmessage", handleWatchMessage);

Pebble.addEventListener("showConfiguration", function() {
  // Fetch through the phone bridge before opening the HTTPS settings page.
  // This also works with local HTTP/WS endpoints that a browser would block as
  // mixed content. Catalog metadata is not persisted as user settings.
  var url = Endpoints.api(settings.endpoint, "models");
  if (!url || typeof XMLHttpRequest === "undefined") {
    Pebble.openURL(Settings.buildConfigUrl(settings, Date.now()));
    return;
  }
  var opened = false;
  function open(catalog) {
    if (opened) { return; }
    opened = true;
    Pebble.openURL(Settings.buildConfigUrl(settings, Date.now(), catalog));
  }
  var xhr = new XMLHttpRequest();
  try {
    xhr.open("GET", url, true);
    xhr.timeout = 8000;
    if (settings.token) { xhr.setRequestHeader("Authorization", "Bearer " + settings.token); }
    xhr.onload = function() {
      var catalog = null;
      try {
        if (xhr.status === 200) {
          var data = JSON.parse(xhr.responseText);
          if (data && Array.isArray(data.models) && data.models.length <= 100) { catalog = data; }
        }
      } catch (_) {}
      open(catalog);
    };
    xhr.onerror = xhr.ontimeout = function() { open(); };
    xhr.send();
  } catch (_) { open(); }
});

Pebble.addEventListener("webviewclosed", function(event) {
  var updated = Settings.parseConfigResponse(event ? event.response : null);
  if (!updated) {
    return;
  }
  if (updated.units !== settings.units || updated.locationLabel !== settings.locationLabel) {
    localStorage.setItem(weatherCacheKey, "null");
  }
  if (!updated.token) updated.token=settings.token;
  settings = Settings.save(updated);
  if(updated.recoverCollections&&collections)collections.recover(function(e){sendStatus(e?e.message:"Pending input archived for recovery. Reopen collections.",e?"error":"show");if(!e)syncCollections();});else syncCollections();
  if(updated.manageIntegrations){
    function managementError(message){
      sendStatus(message,"error");
      Pebble.openURL(Settings.buildConfigUrl(settings,Date.now(),null,message));
    }
    if(!collections)managementError(collectionError||"Collections unavailable");
    else collections.request("POST","/v1/integration-sessions",{public_url:collectionBase(),provider:updated.manageCollection==="note"?settings.noteSyncProvider:settings.todoSyncProvider,collection_id:updated.manageCollection==="note"?"col_note":"col_task"},function(e,data){
      if(e){managementError(e.message);return;}
      var base=collectionBase();
      if(!data.url||data.url.indexOf(base.replace(/\/$/,"")+"/integrations?ticket=")!==0){managementError("Sync settings returned an unexpected server URL.");return;}
      Pebble.openURL(data.url);
    });
  }
  if (updated.newSession) { startNewSession(); }
  if (watchReady) { sendConnection(); refreshWeather(); sendPreferences(); dashboardStatus.refresh(); }
});
