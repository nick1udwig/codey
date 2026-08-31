"use strict";

var Pam = require("./pam");

function line(kind, attrs, depth) {
  var suffix = Pam.formatAttributes(attrs || {});
  return new Array((depth || 0) * 2 + 1).join(" ") + kind + (suffix ? " " + suffix : "") + "\n";
}

function buildRequest(request) {
  var output = "pam version=1\n";
  var input = request.input || {};
  var context = request.context || {};
  var device = request.device || {};

  output += line("request", { id: request.id, session: request.session || "", protocol: "pam/1" });
  output += line("input", {
    kind: input.kind || "event",
    text: input.text || "",
    action: input.action || "",
    element: input.element || "",
    value: input.value || ""
  }, 1);
  output += line("context", {
    screen: context.screen || "",
    layout: context.layout || "",
    selected: context.selected || ""
  }, 1);
  output += line("device", {
    platform: device.platform || "unknown",
    model: device.model || "unknown",
    shape: device.shape || "unknown",
    touch: device.touch ? "true" : "false"
  }, 1);
  if (request.token && /^wss?:/i.test(request.endpoint || "")) {
    output += line("auth", { bearer: request.token }, 1);
  }
  output += "done\n";
  return output;
}

function AgentClient(options) {
  this.options = options || {};
  this.XMLHttpRequest = this.options.XMLHttpRequest || (typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null);
  this.WebSocket = this.options.WebSocket || (typeof WebSocket !== "undefined" ? WebSocket : null);
  this.setTimeout = this.options.setTimeout || setTimeout;
  this.clearTimeout = this.options.clearTimeout || clearTimeout;
  this.active = null;
}

AgentClient.prototype.abort = function() {
  var active;
  if (!this.active) {
    return;
  }
  active = this.active;
  this.active = null;
  try {
    if (typeof active._pamCancel === "function") {
      active._pamCancel();
    }
    if (typeof active.abort === "function") {
      active.abort();
    } else if (typeof active.close === "function") {
      active.close();
    }
  } catch (ignore) {}
};

AgentClient.prototype.send = function(request, callbacks) {
  var endpoint = String(request.endpoint || "").trim();
  callbacks = callbacks || {};
  this.abort();
  if (!endpoint) {
    (callbacks.onError || function() {})(new Error("Configure an agent endpoint in the phone app"));
    return null;
  }
  if (/^wss?:\/\//i.test(endpoint)) {
    return this._sendWebSocket(endpoint, request, callbacks);
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    (callbacks.onError || function() {})(new Error("Agent endpoint must use HTTPS, HTTP, WSS, or WS"));
    return null;
  }
  return this._sendHttp(endpoint, request, callbacks);
};

AgentClient.prototype._sendHttp = function(endpoint, request, callbacks) {
  var self = this;
  var xhr;
  var consumed = 0;
  var completed = false;
  var timeout = Math.max(10, Math.min(120, request.timeoutSeconds || 45)) * 1000;

  if (!this.XMLHttpRequest) {
    (callbacks.onError || function() {})(new Error("HTTP is unavailable"));
    return null;
  }
  xhr = new this.XMLHttpRequest();
  this.active = xhr;
  xhr._pamCancel = function() { completed = true; };

  function consume() {
    var response;
    var chunk;
    try {
      response = xhr.responseText || "";
    } catch (ignore) {
      return;
    }
    if (response.length <= consumed) {
      return;
    }
    chunk = response.slice(consumed);
    consumed = response.length;
    (callbacks.onChunk || function() {})(chunk);
  }

  function finish() {
    if (completed) { return; }
    completed = true;
    consume();
    self.active = null;
    if (xhr.status >= 200 && xhr.status < 300) {
      (callbacks.onDone || function() {})();
    } else {
      (callbacks.onError || function() {})(new Error("Agent HTTP " + String(xhr.status || 0)));
    }
  }

  xhr.open("POST", endpoint, true);
  xhr.timeout = timeout;
  xhr.setRequestHeader("Content-Type", "text/x-pebble-agent-markup; version=1; charset=utf-8");
  xhr.setRequestHeader("Accept", "text/x-pebble-agent-markup; version=1");
  if (request.token) {
    xhr.setRequestHeader("Authorization", "Bearer " + request.token);
  }
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 3) {
      consume();
    } else if (xhr.readyState === 4) {
      finish();
    }
  };
  xhr.onprogress = consume;
  xhr.onload = finish;
  xhr.onerror = function() {
    if (completed) { return; }
    completed = true;
    self.active = null;
    (callbacks.onError || function() {})(new Error("Could not reach agent endpoint"));
  };
  xhr.ontimeout = function() {
    if (completed) { return; }
    completed = true;
    self.active = null;
    (callbacks.onError || function() {})(new Error("Agent request timed out"));
  };
  (callbacks.onStatus || function() {})("Connecting");
  xhr.send(buildRequest(request));
  return xhr;
};

AgentClient.prototype._sendWebSocket = function(endpoint, request, callbacks) {
  var self = this;
  var socket;
  var completed = false;
  var timeoutTimer;
  var timeout = Math.max(10, Math.min(120, request.timeoutSeconds || 45)) * 1000;

  if (!this.WebSocket) {
    (callbacks.onError || function() {})(new Error("WebSocket is unavailable"));
    return null;
  }
  socket = new this.WebSocket(endpoint, "pam.v1");
  this.active = socket;
  function clearTimer() {
    if (timeoutTimer) {
      self.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }
  socket._pamCancel = function() {
    completed = true;
    clearTimer();
  };
  timeoutTimer = this.setTimeout(function() {
    if (completed) { return; }
    completed = true;
    self.active = null;
    try { socket.close(); } catch (ignore) {}
    (callbacks.onError || function() {})(new Error("Agent request timed out"));
  }, timeout);
  socket.onopen = function() {
    (callbacks.onStatus || function() {})("Connected");
    socket.send(buildRequest(request));
  };
  socket.onmessage = function(event) {
    (callbacks.onChunk || function() {})(String(event.data || ""));
  };
  socket.onerror = function() {
    if (completed) { return; }
    completed = true;
    clearTimer();
    self.active = null;
    (callbacks.onError || function() {})(new Error("Agent WebSocket failed"));
  };
  socket.onclose = function(event) {
    if (completed) { return; }
    completed = true;
    clearTimer();
    self.active = null;
    if (!event || event.code === 1000 || event.code === 1005) {
      (callbacks.onDone || function() {})();
    } else {
      (callbacks.onError || function() {})(new Error("Agent WebSocket closed " + event.code));
    }
  };
  return socket;
};

module.exports = {
  AgentClient: AgentClient,
  buildRequest: buildRequest
};
