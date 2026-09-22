"use strict";

var Endpoints = require("../common/endpoints");
var Pam = require("../common/pam");
var Model = require("../common/model");
var WatchProtocol = require("../common/watch-protocol");
var Settings = require("../common/settings");
var Capabilities = require("../common/capabilities");
var Weather = require("../common/weather");
var DashboardStatus = require("../common/dashboard-status");
var LocalDictation = require("../common/local-dictation");

var Key = WatchProtocol.Key;
var settings = Settings.load();
var requestSequence = 0;
var activeRequestId = 0;
var currentScreen = { id: "", layout: "", selected: "" };
var watchInfo = {};
var watchReady = false;
var failedDeliveries = {};
var sessionId = loadSessionId();
var commandSequence = loadCommandSequence();
var collectionController = require("./collection-controller")({
 storage:localStorage, XMLHttpRequest:typeof XMLHttpRequest!=="undefined"?XMLHttpRequest:null,
 settings:function(){return settings;}, enqueue:function(message){watchQueue.enqueue(message);},
 beginRequest:function(){activeRequestId=nextRequestId();return activeRequestId;},
 isCurrent:function(id){return id===activeRequestId;},
 read:read,sendStatus:sendStatus,sendAnswerNotification:sendAnswerNotification,
 capabilityContext:capabilityContext,log:log,nextCommandId:nextCommandId
});

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
    if(jobPresentation)jobPresentation.deliveryError(message);
    collectionController.resetCounts(); // Retry counts after failed delivery.
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
  m[Key.flags]=settings.tapAnimation?1:0;m[Key.index]=settings.doubleTap?1:0;watchQueue.enqueue(m);
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
    phoneNote: function(attrs) { collectionController.command(attrs,requestId,complete,job,commandIndex); },
    changeSetting: function(attrs) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      applySetting(attrs);
      if (job) {
        job.executed = job.executed || {};
        job.executed[commandIndex] = true;
        try { jobPresentation.save(); }
        catch (error) { delete job.executed[commandIndex]; throw error; }
      }
    },
    sendWatchCapability: function(operation) {
      if (requestId !== activeRequestId || (isFailed && isFailed())) { return; }
      // Assign once before queueing; retries retain the same ID, while new
      // model commands (even in the same response) receive different IDs.
      if (job) {
        if (!job.commands[commandIndex]) { job.commands[commandIndex] = nextCommandId(); jobPresentation.save(); }
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
capabilityRegistry.register("calendar", function(attrs, context) { attrs.type="calendar"; context.phoneNote(attrs); });
capabilityRegistry.register("note", function(attrs, context) { attrs.type="note"; context.phoneNote(attrs); });
capabilityRegistry.register("todo", function(attrs, context) { attrs.type="todo"; context.phoneNote(attrs); });
capabilityRegistry.register("settings", function(attrs, context) {
  try {
    context.changeSetting(attrs);
    context.renderPam(settingsConfirmation(Settings.parseCapability(attrs).label));
  } catch (error) { context.error("Could not save settings: " + error.message); }
});

function savePreference(preference) {
  var updated = Settings.normalize(settings);
  Object.keys(preference.patch).forEach(function(key) { updated[key] = preference.patch[key]; });
  settings = Settings.save(updated);
  sendPreferences();
  if (preference.patch.units !== undefined) {
    localStorage.setItem(weatherCacheKey, "null");
    refreshWeather();
  }
}

function applySetting(attrs) {
  savePreference(Settings.parseCapability(attrs));
}

function settingsConfirmation(label) {
  return "pam version=1\nscreen id=settings layout=card title=\"Settings\"\n  text id=saved " +
    Pam.formatAttributes({value:"Saved · " + label}) + "\ndone\n";
}

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
      if (!job) { sendAnswerNotification(requestId); } else { jobPresentation.presented(job, requestId); }
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
        if (job && job.executed && job.executed[capabilityIndex]) {
          if (operation.node.attrs.type === "settings") {
            capabilityContext(requestId).renderPam(settingsConfirmation(Settings.parseCapability(operation.node.attrs).label));
          }
          capabilityIndex++;
          return;
        }
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
  var previous = activeRequestId;
  var now = new Date();

  if (previous) {
    watchQueue.clearRequest(previous);
  }
  activeRequestId = requestId;
  var preference = input.kind === "dictation" ? Settings.parseDictation(input.text) : null;
  if (preference) {
    sendAnswerNotification(requestId, "begin");
    jobPresentation.send({id:"pending"}, false, "remove");
    try {
      savePreference(preference);
      var confirmation=createPipeline(requestId);
      confirmation.parser.push(settingsConfirmation(preference.label));
      confirmation.parser.finish();confirmation.finishAnswer();
    } catch(error) { sendStatus("Could not save settings: "+error.message,"error",requestId); }
    return;
  }
  var local = input.kind === "dictation" ? LocalDictation.parse(input.text, now) : null;
  if (local) { sendAnswerNotification(requestId, "begin"); }
  if (local) {
    jobPresentation.send({ id:"pending" }, false, "remove");
    var pipeline = createPipeline(requestId);
    pipeline.model.accept({ kind: local.node.kind, attrs: local.node.attrs, depth: 0 });
    pipeline.finishAnswer();
    return;
  }
  try { jobPresentation.submit({
    id: requestId,
    session: sessionId,
    endpoint: settings.endpoint,
    token: settings.token,
    timeoutSeconds: settings.timeoutSeconds,
    input: input,
    settings: Settings.agentPreferences(settings),
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
  catch(error) { jobPresentation.send({id:"pending",title:input.text || "Agent request",status:"failed",error:error.message},false); }

}


var jobPresentation = require("./job-coordinator")({
 storage:localStorage, XMLHttpRequest:typeof XMLHttpRequest!=="undefined"?XMLHttpRequest:null,
 settings:function(){return settings;},enqueue:function(message){watchQueue.enqueue(message);},
 nextCommandId:nextCommandId,collectionCommand:collectionController.command,applySetting:applySetting,
 beginRequest:function(){activeRequestId=nextRequestId();delete failedDeliveries[activeRequestId];return activeRequestId;},
 isCurrent:function(id){return id===activeRequestId;},deliveryFailed:function(id){return failedDeliveries[id];},
 resumeSession:function(id){sessionId=id;localStorage.setItem("pebble-agent.session.v1",id);},
 createPipeline:createPipeline,sendAnswerNotification:sendAnswerNotification
});

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
    jobPresentation.ready();
    sendConnection();
    refreshWeather();
    sendPreferences();
    collectionController.ready();
    return;
  }
  if (type === "capability_event" && operation === "status") {dashboardStatus.refresh();return;}
  if (type === "capability_event" && (operation === "note" || operation === "todo" || operation === "calendar")) { collectionController.handle(operation==="calendar"?"event":operation==="note"?"note":"task",action,element,value,Number(read(payload,Key.meta,"Meta"))||0,payload);return; }
  if (type === "capability_event" && operation === "job") {
    if (action === "executed" || action === "execution-failed") {
      jobPresentation.receipt(element,value,action);
      return;
    }
    if (action === "refresh") { jobPresentation.refresh(); return; }
    if (action === "retrieved" || action === "dismiss") {
      jobPresentation.dismiss(element);
    } else { jobPresentation.open(element, action === "cancel"); }
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
    collectionController.setup(function(e,setup){
      Pebble.openURL(Settings.buildConfigUrl(settings,Date.now(),catalog,e?e.message:null,e?null:setup));
    });
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
  if(updated.recoverCollections)collectionController.recover();else collectionController.sync();
  if (updated.newSession) { startNewSession(); }
  if (watchReady) { sendConnection(); refreshWeather(); sendPreferences(); dashboardStatus.refresh(); }
});
