"use strict";
var assert = require("assert");
var Endpoints = require("../src/common/endpoints");
var Settings = require("../src/common/settings");
var AgentClient = require("../src/common/agent-client").AgentClient;
var Jobs = require("../src/common/jobs").Jobs;
var Status = require("../src/common/dashboard-status");

module.exports = function(test) {
  test("Nested server bases route every client API under the same prefix", function() {
    ["foo.com/bar/baz/biz", "https://foo.com/bar/baz/biz/", "https://foo.com/bar/baz/biz/v1/agent/",
      "wss://foo.com/bar/baz/biz", "WSS://FOO.COM/bar/baz/biz/v1/agent"].forEach(function(input) {
      var requests = [], sockets = [], data = {};
      function XHR() { this.headers = {}; requests.push(this); }
      XHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
      XHR.prototype.setRequestHeader = function(k, v) { this.headers[k] = v; };
      XHR.prototype.send = function(body) { this.body = body; };
      function Socket(url) { this.url = url; sockets.push(this); }
      Socket.prototype.close = function() {};
      var base = "https://foo.com/bar/baz/biz/v1/";
      var settings = Settings.normalize({ endpoint: input, token: "secret" });
      var client = new AgentClient({ XMLHttpRequest: XHR, WebSocket: Socket,
        setTimeout: function() {}, clearTimeout: function() {} });
      client.send({ endpoint: input, token: "secret" });
      if (/^wss:/i.test(input)) { assert.strictEqual(sockets[0].url, base.replace(/^https:/, "wss:") + "agent"); }
      else { assert.strictEqual(requests.pop().url, base + "agent"); }
      var jobs = new Jobs({ storage: { getItem: function(k) { return data[k]; }, setItem: function(k, v) { data[k] = v; } },
        XMLHttpRequest: XHR, token: function() { return "secret"; }, endpoint: function() { return Endpoints.api(settings.endpoint, "jobs/"); }, update: function() {} });
      var job = jobs.submit({ endpoint: input, id: 1, session: "test", input: { text: "hello" }, timeoutSeconds: 45 });
      assert.strictEqual(requests[0].url, base + "jobs/" + job.id);
      assert.strictEqual(requests[0].headers.Authorization, "Bearer secret");
      requests[0].status = 200; requests[0].responseText = JSON.stringify({ id: job.id, status: "working" }); requests[0].onload();
      assert.strictEqual(requests[1].url, base + "jobs/" + job.id + "?wait=45");
      requests[1].status = 200; requests[1].responseText = requests[0].responseText; requests[1].onload();
      jobs.cancel(job.id, function() {});
      assert.strictEqual(requests[2].url, base + "jobs/" + job.id + "/cancel");
      var status = new Status({ settings: function() { return settings; }, XMLHttpRequest: XHR, update: function() {} });
      status.refresh();
      assert.strictEqual(requests[3].url, base + "status");
      assert.strictEqual(requests[3].headers.Authorization, "Bearer secret");
    });
  });

  test("Endpoint normalization supports local servers and rejects ambiguous URLs", function() {
    assert.strictEqual(Endpoints.api("localhost:8787/codey", "models"), "https://localhost:8787/codey/v1/models");
    assert.strictEqual(Endpoints.api("ws://[::1]:8787/codey/", "models"), "http://[::1]:8787/codey/v1/models");
    assert.strictEqual(Endpoints.api(" https://foo.com/a%20b/ ", "models"), "https://foo.com/a%20b/v1/models");
    ["ftp://foo.com", "https://user:secret@foo.com/codey", "https://foo.com/path?token=secret", "https://foo.com/#x",
      "https://foo.com/../bar", "https://foo.com/%2e%2e/bar", "https://foo.com/a b", "https://foo.com:99999", "https://foo.com/%xy", "https://foo.com\\bar"].forEach(function(url) {
      assert.strictEqual(Endpoints.normalize(url), null, url);
      assert.strictEqual(Endpoints.api(url, "models"), "", url);
    });
    assert.strictEqual(Endpoints.normalize(""), "");
  });

  test("Changing server prefixes cannot send a new token to a previous job endpoint", function() {
    var data = {}, calls = 0, current = "https://foo.com/old/v1/jobs/";
    function XHR() { calls++; }
    XHR.prototype.open = XHR.prototype.setRequestHeader = XHR.prototype.send = function() {};
    var jobs = new Jobs({ storage: { getItem: function(k) { return data[k]; }, setItem: function(k, v) { data[k] = v; } },
      XMLHttpRequest: XHR, token: function() { return "secret"; }, endpoint: function() { return current; }, update: function() {} });
    var job = jobs.submit({ endpoint: "foo.com/old", id: 1, input: { text: "hello" } });
    current = "https://foo.com/new/v1/jobs/";
    jobs.cancel(job.id, function(error) { assert.match(error.message, /original server/); });
    assert.strictEqual(calls, 1);
  });
};
