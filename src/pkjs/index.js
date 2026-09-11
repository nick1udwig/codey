"use strict";

var Pam = require("../common/pam");
var Model = require("../common/model");
var WatchProtocol = require("../common/watch-protocol");
var AgentClient = require("../common/agent-client").AgentClient;
var Settings = require("../common/settings");
var Capabilities = require("../common/capabilities");
var Weather = require("../common/weather");
var LocalDictation = require("../common/local-dictation");

var Key = WatchProtocol.Key;
var settings = Settings.load();
var client = new AgentClient();
var requestSequence = 0;
var activeRequestId = 0;
var activePipeline = null;
var currentScreen = { id: "", layout: "", selected: "" };
var watchInfo = {};
var nativeDashboard = false;
var sessionId = loadSessionId();
var commandSequence = loadCommandSequence();

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
  Pebble.sendAppMessage(message, success, failure);
}, {
  maxQueue: 96,
  maxRetries: 3,
  retryDelay: 120,
  onError: function(error) {
    log("watch message failed", error);
  }
});

function sendStatus(text, operation, requestId) {
  var message = {};
  message[Key.messageType] = "status";
  message[Key.requestId] = requestId || activeRequestId || 0;
  message[Key.operation] = operation || "show";
  message[Key.value] = WatchProtocol.truncateUtf8(text || "", 180);
  watchQueue.enqueue(message);
}

function sendConnection() {
  var message = {};
  message[Key.messageType] = "bridge";
  message[Key.value] = settings.endpoint ? "Agent connected · Hold Select to talk" : "Configure endpoint in phone settings";
  watchQueue.enqueue(message);
}

function nextRequestId() {
  requestSequence += 1;
  if (requestSequence > 65535) {
    requestSequence = 1;
  }
  return requestSequence;
}

function capabilityContext(requestId) {
  return {
    settings: settings,
    sendWatchCapability: function(operation) {
      if (requestId !== activeRequestId) { return; }
      // Assign once before queueing; retries retain the same ID, while new
      // model commands (even in the same response) receive different IDs.
      operation.invocationId = nextCommandId();
      watchQueue.enqueueOperation(operation, requestId);
    },
    renderPam: function(source) {
      if (requestId !== activeRequestId) { return; }
      var pipeline = createPipeline(requestId);
      pipeline.parser.push(source);
      pipeline.parser.finish();
    },
    status: function(text) {
      if (requestId !== activeRequestId) { return; }
      sendStatus(text, "show", requestId);
    },
    error: function(text) {
      if (requestId !== activeRequestId) { return; }
      sendStatus(text, "error", requestId);
    }
  };
}

var capabilityRegistry = Capabilities.installBuiltins(
  new Capabilities.CapabilityRegistry(),
  Weather.createWeatherHandler()
);

function createPipeline(requestId) {
  var pipeline = {};
  var sawRenderable = false;
  var model = new Model.ScreenModel({
    onOperation: function(operation) {
      if (operation.type === "begin") {
        sawRenderable = true;
        currentScreen.id = operation.node.attrs.id;
        currentScreen.layout = operation.node.attrs.layout;
        currentScreen.selected = "";
      }
      if (operation.type === "capability") {
        sawRenderable = true;
        if (!capabilityRegistry.handle(operation, capabilityContext(requestId))) {
          sendStatus("Unsupported capability: " + operation.node.attrs.type, "error", requestId);
        }
        return;
      }
      watchQueue.enqueueOperation(operation, requestId);
    },
    onError: function(error) {
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
      sendStatus("Bad PAM at line " + error.line + ": " + error.message, "error", requestId);
    }
  });
  pipeline.parser = parser;
  pipeline.model = model;
  pipeline.sawRenderable = function() { return sawRenderable; };
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
  if (local) {
    // Invalidate callbacks before aborting: a canceled server response must not
    // replace a local result or start a second timer. Use the normal capability
    // queue so delivery retries keep the same invocation ID.
    client.abort();
    capabilityRegistry.handle(local, capabilityContext(requestId));
    return;
  }
  sendStatus(input.kind === "dictation" ? "Thinking" : "Loading", "loading", requestId);
  client.send({
    id: requestId,
    session: sessionId,
    endpoint: settings.endpoint,
    token: settings.token,
    timeoutSeconds: settings.timeoutSeconds,
    input: input,
    context: currentScreen,
    backend: {
      model: settings.codexModel, effort: settings.codexEffort,
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
  }, {
    onChunk: function(chunk) {
      if (requestId !== activeRequestId) { return; }
      pipeline.parser.push(chunk);
    },
    onDone: function() {
      if (requestId !== activeRequestId) { return; }
      pipeline.parser.finish();
      if (!pipeline.sawRenderable()) {
        sendStatus("Agent returned no screen", "error", requestId);
      } else {
        sendStatus("", "idle", requestId);
      }
    },
    onError: function(error) {
      if (requestId !== activeRequestId) { return; }
      log("agent request failed", error);
      sendStatus(error.message || "Agent request failed", "error", requestId);
    },
    onStatus: function(status) {
      log(status);
    }
  });
}

function onboardingPam() {
  var configured = !!settings.endpoint;
  var source = "pam version=1\n";
  source += "screen id=home layout=list title=\"Pebble Agent\" status=true\n";
  source += "  item id=talk title=\"Hold Select to talk\" subtitle=\"Dictation is always available\"\n";
  if (configured) {
    source += "  item id=ready title=\"Agent connected\" subtitle=\"Ask for anything, a timer, or weather\"\n";
  } else {
    source += "  item id=setup title=\"Configure endpoint\" subtitle=\"Open this app's settings on your phone\"\n";
  }
  source += "  item id=formats title=\"Dynamic screens\" subtitle=\"Lists, grids, cards, forms, and more\"\n";
  source += "done\n";
  return source;
}

function renderOnboarding() {
  var pipeline = createPipeline(0);
  pipeline.parser.push(onboardingPam());
  pipeline.parser.finish();
}

function handleWatchMessage(event) {
  var payload = event && event.payload || {};
  var type = String(read(payload, Key.messageType, "MessageType") || "");
  var operation = String(read(payload, Key.operation, "Operation") || "");
  var value = String(read(payload, Key.value, "Value") || "");
  var action = String(read(payload, Key.action, "Action") || "");
  var element = String(read(payload, Key.elementId, "ElementId") || "");

  if (type === "ready") {
    nativeDashboard = value === "local-active";
    if (nativeDashboard) { sendConnection(); }
    if (value !== "local-active") {
      renderOnboarding();
    }
    return;
  }
  if (type === "input") {
    if (operation === "selection") {
      currentScreen.selected = element;
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
  var match = /^(https?|wss?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(settings.endpoint);
  if (!match || match[2].indexOf("@") >= 0 || typeof XMLHttpRequest === "undefined") {
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
    xhr.open("GET", match[1].toLowerCase().replace(/^ws/, "http") + "://" + match[2] + "/v1/models", true);
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
  settings = Settings.save(updated);
  if (nativeDashboard) { sendConnection(); }
  else { renderOnboarding(); }
});
