"use strict";

var buildRequest = require("./agent-client").buildRequest;
var storageKey = "pebble-agent.jobs.v1";
function terminal(job) { return /^(done|failed|canceled)$/.test(job.status); }
function uid() {
  var out = Date.now().toString(16);
  while (out.length < 30) { out += Math.floor(Math.random() * 0x100000000).toString(16); }
  return out.slice(0, 30);
}
function endpoint(url) {
  return String(url).replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "").replace(/\/v1\/agent$/, "") + "/v1/jobs/";
}
function Jobs(options) {
  this.options = options;
  this.entries = [];
  try { this.entries = JSON.parse(options.storage.getItem(storageKey) || "[]"); } catch (_) {}
  if (!Array.isArray(this.entries)) { this.entries = []; }
  this.entries = this.entries.filter(function(j) { return j && /^[a-f0-9]{30}$/.test(j.id); });
}
Jobs.prototype.save = function() { this.options.storage.setItem(storageKey, JSON.stringify(this.entries)); };
Jobs.prototype.find = function(id) { return this.entries.filter(function(j) { return j.id === id; })[0]; };
Jobs.prototype.update = function(job, buzz) { this.options.update(job, !!buzz); };
Jobs.prototype.http = function(job, method, suffix, body, seconds, callback) {
  if (this.options.endpoint && job.endpoint !== this.options.endpoint()) { callback(new Error("Restore this request’s original server address in phone settings to check it.")); return null; }
  if (!this.options.XMLHttpRequest) { callback(new Error("HTTP is unavailable on phone")); return null; }
  var xhr = new this.options.XMLHttpRequest();
  var ended = false;
  function finish(error, data) { if (ended) { return; } ended = true; callback(error, data); }
  xhr.open(method, job.endpoint + job.id + (suffix || ""), true);
  xhr.timeout = seconds * 1000;
  xhr.setRequestHeader("Content-Type", "text/x-pebble-agent-markup; version=1; charset=utf-8");
  var token = this.options.token();
  if (token) { xhr.setRequestHeader("Authorization", "Bearer " + token); }
  // onload excludes network failures; readystatechange with HTTP 0 used to
  // mask the later, more useful timeout event.
  xhr.onload = function() {
    if (xhr.status < 200 || xhr.status >= 300) { var error = new Error(xhr.status === 404 ? "Job not found or expired" : "Server returned HTTP " + xhr.status); error.status = xhr.status; finish(error); return; }
    try { finish(null, JSON.parse(xhr.responseText)); } catch (_) { finish(new Error("Invalid job response from server")); }
  };
  xhr.onerror = function() { finish(new Error("Connection lost. Tap to check again.")); };
  xhr.ontimeout = function() { finish(new Error("Status check timed out. Tap to check again.")); };
  try { xhr.send(body || null); } catch (error) { finish(error); }
  return xhr;
};
Jobs.prototype.accept = function(job, data, buzz) {
  if (data.id !== job.id || !/^(working|canceling|done|failed|canceled)$/.test(data.status)) { throw new Error("Invalid job status"); }
  // A stale long-wait response must not overwrite a manual completion result.
  if (terminal(job) || (job.status === "canceling" && data.status === "working")) { return; }
  job.status = data.status;
  job.error = data.error || "";
  job.result = data.result || "";
  job.accepted = true;
  if (data.retrieved && !job.result && data.status === "done") { job.status = "failed"; job.error = "Result was retrieved by another phone installation."; }
  this.save(); // Never acknowledge a result that is only in volatile memory.
  this.update(job, buzz && terminal(job));
};
Jobs.prototype.submit = function(request) {
  if (!/^https?:\/\//i.test(endpoint(request.endpoint))) { throw new Error("Configure an agent endpoint in phone settings"); }
  if (this.entries.filter(function(j) { return !j.opened; }).length >= 24) { throw new Error("Open existing request results before adding more (24 pending requests)."); }
  var job = { id: uid(), title: request.input.text || request.input.value || "Agent request", session: request.session,
    endpoint: endpoint(request.endpoint), status: "sending", body: buildRequest(Object.assign({}, request, { endpoint: "" })), accepted: false,
    commands: {}, opened: false };
  this.entries.push(job);
  try { this.save(); } catch (error) { this.entries.pop(); throw new Error("Could not save request on phone; request was not sent."); }
  this.update(job, false);
  this.send(job, request.timeoutSeconds || 45);
  return job;
};
Jobs.prototype.send = function(job, wait) {
  var self = this;
  self.http(job, "POST", "", job.body, 10, function(error, data) {
    if (error) { if (job.accepted || terminal(job)) { return; } job.error = error.message; job.status = "unconfirmed"; self.save(); self.update(job, false); return; }
    try { self.accept(job, data, true); } catch (e) { job.error = e.message; self.update(job, false); return; }
    if (terminal(job)) { return; }
    // One bounded wait, not recurring polling. The server's worker has an
    // independent context and survives timeout/closure of this GET.
    self.http(job, "GET", "?wait=" + Math.max(10, Math.min(120, wait)), null, wait + 5, function(error, data) {
      if (error) { return; } // Keep the job; manual checks remain available.
      try { self.accept(job, data, true); } catch (e) { job.error = e.message; self.update(job, false); }
    });
  });
};
Jobs.prototype.check = function(id, callback) {
  var self = this, job = self.find(id);
  if (!job) { callback(new Error("Request is not stored on this phone")); return; }
  if (terminal(job)) { callback(null, job); return; }
  self.http(job, "GET", "", null, 10, function(error, data) {
    if (error) {
      // Safe replay after an uncertain submission, with exactly the same ID
      // and payload. The server rejects reuse with different content.
      if (error.status === 404 && !job.accepted) {
        self.http(job, "POST", "", job.body, 10, function(err, result) { if (err) { callback(err); return; } try { self.accept(job, result, false); callback(null, job); } catch(e) { callback(e); } }); return;
      }
      callback(error); return;
    }
    try { self.accept(job, data, false); callback(null, job); } catch(e) { callback(e); }
  });
};
// A pane-open refresh is one batch, never a recurring poll. Keep "checking"
// transient so persisted server status and terminal-state guards remain valid.
Jobs.prototype.refreshAll = function() {
  var self = this;
  var pending = self.entries.filter(function(job) { return !job.opened && !terminal(job); });
  self.refreshing = self.refreshing || {};
  pending.forEach(function(job) { self.update(Object.assign({}, job, { status: "checking" }), false); });
  pending.forEach(function(job) {
    if (self.refreshing[job.id]) { return; }
    self.refreshing[job.id] = true;
    var completed = false;
    function finished(error) {
      if (completed) { return; }
      completed = true;
      delete self.refreshing[job.id];
      if (!job.opened) {
        self.update(error && !terminal(job) ? Object.assign({}, job, { error: error.message }) : job, false);
      }
    }
    try { self.check(job.id, finished); } catch (error) { finished(error); }
  });
};
Jobs.prototype.cancel = function(id, callback) {
  var self = this, job = self.find(id);
  if (!job) { callback(new Error("Unknown request")); return; }
  self.http(job, "POST", "/cancel", null, 10, function(error, data) {
    if (error) { callback(error); return; }
    try { self.accept(job, data, false); callback(null, job); } catch(e) { callback(e); }
  });
};
Jobs.prototype.acknowledge = function(job) {
  if (!terminal(job)) { return; }
  job.opened = true; this.save();
  this.http(job, "POST", "/ack", null, 10, function() {});
};
module.exports = { Jobs: Jobs, terminal: terminal, endpoint: endpoint };
