"use strict";

var Endpoints = require("./endpoints");
var Settings = require("./settings");

function ServerFeatures(XMLHttpRequest) {
  this.XMLHttpRequest = XMLHttpRequest;
  this.cache = {};
  this.pending = {};
}

ServerFeatures.prototype.get = function(endpoint, token, callback) {
  var self = this;
  var url = Endpoints.api(endpoint, "capabilities");
  var key = url + "\n" + (token || "");
  if (!url || !this.XMLHttpRequest) { callback(false); return; }
  if (Object.prototype.hasOwnProperty.call(this.cache, key)) { callback(this.cache[key]); return; }
  if (this.pending[key]) { this.pending[key].push(callback); return; }
  this.pending[key] = [callback];
  var settled = false;
  function finish(supported, cache) {
    if (settled) { return; }
    settled = true;
    if (cache) { self.cache[key] = supported; }
    var waiters = self.pending[key];
    delete self.pending[key];
    waiters.forEach(function(done) { done(supported); });
  }
  try {
    var xhr = new this.XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 5000;
    if (token) { xhr.setRequestHeader("Authorization", "Bearer " + token); }
    xhr.onload = function() {
      var supported = false;
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          supported = data.protocol_version === 1 && Array.isArray(data.features) &&
            data.features.indexOf("request.settings") >= 0;
        } catch (_) {}
      }
      // A missing route identifies an older server. Transient failures can be
      // retried on the next request without ever sending unsupported fields.
      finish(supported, xhr.status === 200 || xhr.status === 404);
    };
    xhr.onerror = xhr.ontimeout = function() { finish(false, false); };
    xhr.send();
  } catch (_) { finish(false, false); }
};

function prepare(request, supportsSettings) {
  if (supportsSettings) { return request; }
  var legacy = Object.assign({}, request);
  delete legacy.settings;
  // The new app default may not be in an older server's model catalog.
  // Preserve an explicitly selected older model; let the old server validate it.
  legacy.backend = Object.assign({}, request.backend);
  if (legacy.backend.model === Settings.DEFAULTS.codexModel) {
    legacy.backend.model = "";
    legacy.backend.effort = "";
  }
  return legacy;
}

module.exports = { ServerFeatures: ServerFeatures, prepare: prepare };
