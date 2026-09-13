"use strict";

function unknown() {
  return { remainingPercent: null, activeThreads: null, state: "unknown" };
}

// Startup and watch refresh events share a single, once-per-minute request.
function Status(options) {
  this.options = options;
  this.busy = false;
  this.last = null;
  this.key = "";
  this.generation = 0;
}

Status.prototype.refresh = function() {
  var self = this;
  var settings = self.options.settings();
  var match = /^(https?|wss?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(settings.endpoint || "");
  var key = (settings.endpoint || "") + ":" + (settings.token || "");
  if (key !== self.key) {
    self.key = key;
    self.last = null;
    self.busy = false;
    self.generation++;
    self.options.update(unknown());
  }
  var now = Date.now();
  if (self.busy || (self.last !== null && now - self.last < 60000)) { return; }
  self.last = now;
  if (!match || !self.options.XMLHttpRequest) {
    self.options.update(unknown());
    return;
  }
  var generation = self.generation;
  var settled = false;
  self.busy = true;
  function done(value) {
    if (settled || generation !== self.generation) { return; }
    settled = true;
    self.busy = false;
    self.options.update(value || unknown());
  }
  try {
    var xhr = new self.options.XMLHttpRequest();
    var scheme = /^(https|wss)$/i.test(match[1]) ? "https" : "http";
    xhr.open("GET", scheme + "://" + match[2] + "/v1/status", true);
    xhr.timeout = 17000;
    if (settings.token) { xhr.setRequestHeader("Authorization", "Bearer " + settings.token); }
    xhr.onload = function() {
      try {
        if (xhr.status !== 200) { throw new Error("Status unavailable"); }
        var data = JSON.parse(xhr.responseText);
        done({
          remainingPercent: typeof data.remainingPercent === "number" ? Math.max(0, Math.min(100, Math.floor(data.remainingPercent))) : null,
          activeThreads: typeof data.activeThreads === "number" ? Math.max(0, Math.min(2147483647, Math.floor(data.activeThreads))) : null,
          state: ["idle", "working", "error"].indexOf(data.state) >= 0 ? data.state : "unknown"
        });
      } catch (_) { done(); }
    };
    xhr.onerror = xhr.ontimeout = function() { done(); };
    xhr.send();
  } catch (_) { done(); }
};

module.exports = Status;
