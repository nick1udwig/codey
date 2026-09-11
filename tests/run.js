"use strict";

var assert = require("assert");
var Pam = require("../src/common/pam");
var Model = require("../src/common/model");
var Watch = require("../src/common/watch-protocol");
var AgentClientModule = require("../src/common/agent-client");
var Settings = require("../src/common/settings");
var Capabilities = require("../src/common/capabilities");
var Weather = require("../src/common/weather");
var Writer = require("../src/common/writer");

var tests = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function parse(source, options) {
  var nodes = [];
  var parser = new Pam.Parser(Object.assign({
    onNode: function(node) { nodes.push(node); }
  }, options || {}));
  parser.push(source);
  parser.finish();
  return nodes;
}

test("PAM streams complete lines and preserves hierarchy", function() {
  var nodes = [];
  var parser = new Pam.Parser({ onNode: function(node) { nodes.push(node); } });
  parser.push("pam version=1\nscreen id=home layout=list title=\"Hel");
  assert.strictEqual(nodes.length, 1);
  parser.push("lo\"\n  section id=main title=Main\n  item id=one title=\"First row\" value=\"a\\nb\"\n");
  parser.finish();
  assert.strictEqual(nodes.length, 4);
  assert.strictEqual(nodes[1].attrs.title, "Hello");
  assert.strictEqual(nodes[2].parent, nodes[1]);
  assert.strictEqual(nodes[3].parent, nodes[1]);
  assert.strictEqual(nodes[3].attrs.value, "a\nb");
});

test("PAM rejects skipped indentation and duplicate attributes", function() {
  assert.throws(function() {
    parse("pam version=1\n    item id=x\n");
  }, /skips a parent/);
  assert.throws(function() {
    parse("pam version=1\nscreen id=x id=y layout=list\n");
  }, /duplicate attribute/);
});

test("PAM stops after the first reported stream error", function() {
  var nodes = [];
  var errors = [];
  var parser = new Pam.Parser({
    onNode: function(node) { nodes.push(node); },
    onError: function(error) { errors.push(error); }
  });
  parser.push("pam version=1\n    item id=bad\nscreen id=ignored layout=list\n");
  parser.finish();
  assert.strictEqual(errors.length, 1);
  assert.deepStrictEqual(nodes.map(function(node) { return node.kind; }), ["pam"]);
});

test("PAM formats attributes deterministically", function() {
  assert.strictEqual(Pam.formatAttributes({ z: "hello world", a: "safe/value" }),
                     "a=safe/value z=\"hello world\"");
});

test("PAM parses identically at every transport chunk boundary", function() {
  var source = "pam version=1\r\nscreen id=home layout=list title=\"Café 🙂\"\n" +
    "  section id=main title=Main\n" +
    "    item id=one title=\"Quoted \\\"row\\\"\" value=one\n" +
    "done\n";
  var expected = parse(source).map(function(node) {
    return [node.kind, node.depth, node.path, Object.assign({}, node.attrs)];
  });
  for (var split = 0; split <= source.length; split += 1) {
    var nodes = [];
    var parser = new Pam.Parser({ onNode: function(node) { nodes.push(node); } });
    parser.push(source.slice(0, split));
    parser.push(source.slice(split));
    parser.finish();
    assert.deepStrictEqual(nodes.map(function(node) {
      return [node.kind, node.depth, node.path, Object.assign({}, node.attrs)];
    }), expected);
  }
});

test("PAM enforces byte limits before an unterminated line can grow", function() {
  var errors = [];
  var parser = new Pam.Parser({
    maxLineLength: 12,
    onError: function(error) { errors.push(error); }
  });
  parser.push("ééééééé");
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /line is too long/);
  assert.strictEqual(parser.buffer, "");
  assert.throws(function() {
    Pam.parseLine("text value=🙂🙂", 1, { maxLineLength: 16 });
  }, /line is too long/);
});

test("PAM quoting round-trips escapes, Unicode, comments, and empty values", function() {
  var attrs = {
    backslash: "a\\b",
    empty: "",
    quote: "say \"hello\"",
    single: "it's fine",
    text: "line one\nline two\t🙂"
  };
  var parsed = Pam.parseLine("item " + Pam.formatAttributes(attrs) + " # comment", 1, {});
  Object.keys(attrs).forEach(function(key) {
    assert.strictEqual(parsed.attrs[key], attrs[key]);
  });
  assert.strictEqual(Pam.utf8ByteLength("é🙂"), 6);
});

test("PAM rejects malformed headers, indentation, names, quotes, and escapes", function() {
  [
    "screen id=x layout=list\n",
    "pam version=2\n",
    "pam version=1\n   item id=x\n",
    "pam version=1\n\titem id=x\n",
    "pam version=1\nItem id=x\n",
    "pam version=1\nitem Bad=x\n",
    "pam version=1\nitem value=\"open\n",
    "pam version=1\nitem value=\"bad\\q\"\n"
  ].forEach(function(source) {
    assert.throws(function() { parse(source); }, Pam.Error);
  });
  assert.throws(function() {
    parse("pam version=1\n                  item id=x\n", { maxDepth: 8 });
  }, /maximum nesting depth/);
});

test("PAM parser lifecycle rejects writes after finish", function() {
  var parser = new Pam.Parser();
  parser.push("pam version=1\n");
  parser.finish();
  parser.finish();
  assert.throws(function() { parser.push("done\n"); }, /cannot push after finish/);
});

test("screen model supports every public layout", function() {
  Object.keys(Model.LAYOUTS).forEach(function(layout) {
    var operations = [];
    var model = new Model.ScreenModel({ onOperation: function(op) { operations.push(op); } });
    var nodes = parse("pam version=1\nscreen id=s layout=" + layout + "\n  text value=Hello\ndone\n");
    nodes.forEach(function(node) { model.accept(node); });
    assert.deepStrictEqual(operations.map(function(op) { return op.type; }),
                           ["header", "begin", "node", "end"]);
    assert.ok(operations[2].node.attrs.id.indexOf("_text") === 0);
  });
});

test("screen patches carry the merged element state", function() {
  var operations = [];
  var model = new Model.ScreenModel({ onOperation: function(op) { operations.push(op); } });
  parse("pam version=1\nscreen id=s layout=list\n  item id=a title=Old checked=true\npatch target=a title=New\n")
    .forEach(function(node) { model.accept(node); });
  var patch = operations[operations.length - 1];
  assert.strictEqual(patch.type, "patch");
  assert.strictEqual(patch.attrs.title, "New");
  assert.strictEqual(patch.attrs.checked, "true");
});

test("screen model preserves generated hierarchy and resets on replacement", function() {
  var operations = [];
  var model = new Model.ScreenModel({ onOperation: function(op) { operations.push(op); } });
  parse("pam version=1\n" +
        "screen id=first layout=list\n" +
        "  section title=Parent\n" +
        "    item title=Child\n" +
        "screen id=second layout=text\n" +
        "  text value=Replacement\n")
    .forEach(function(node) { model.accept(node); });
  var nodes = operations.filter(function(op) { return op.type === "node"; });
  assert.strictEqual(nodes[0].node.attrs.id, "_section1");
  assert.strictEqual(nodes[1].node.parentId, "_section1");
  assert.strictEqual(nodes[2].node.parentId, "second");
  assert.strictEqual(model.activeScreen.id, "second");
  assert.strictEqual(model.elements._section1, undefined);
});

test("screen model rejects invalid roots and references", function() {
  [
    "pam version=1\nscreen layout=list\n",
    "pam version=1\nscreen id=x layout=unknown\n",
    "pam version=1\nitem id=x title=X\n",
    "pam version=1\nscreen id=x layout=list\n  item id=a\n  item id=a\n",
    "pam version=1\nscreen id=x layout=list\npatch target=missing value=x\n",
    "pam version=1\nscreen id=x layout=list\nremove target=missing\n",
    "pam version=1\ncapability type=timer\n",
    "pam version=1\nscreen id=x layout=list\n  capability type=timer command=start\n"
  ].forEach(function(source) {
    var model = new Model.ScreenModel();
    assert.throws(function() {
      parse(source).forEach(function(node) { model.accept(node); });
    }, Model.Error);
  });
});

test("screen model emits remove and agent error operations", function() {
  var types = [];
  var model = new Model.ScreenModel({ onOperation: function(op) { types.push(op.type); } });
  parse("pam version=1\nscreen id=x layout=list\n  item id=a title=A\nremove target=a\n" +
        "error message=failed\ndone\n")
    .forEach(function(node) { model.accept(node); });
  assert.deepStrictEqual(types, ["header", "begin", "node", "remove", "agent_error", "end"]);
});

test("watch encoder maps nodes and splits UTF-8 safely", function() {
  var longValue = new Array(120).join("é🙂");
  var messages = Watch.encodeOperation({
    type: "node",
    node: {
      kind: "text",
      parentId: "screen",
      attrs: { id: "body", value: longValue, action: "open", checked: "true" }
    }
  }, 7);
  assert.ok(messages.length > 2);
  assert.strictEqual(messages[0][Watch.Key.kind], "text");
  assert.strictEqual(messages[0][Watch.Key.flags] & 2, 2);
  messages.forEach(function(message) {
    if (message[Watch.Key.value]) {
      assert.ok(Buffer.byteLength(message[Watch.Key.value], "utf8") <= 180);
    }
  });
  assert.strictEqual(messages.map(function(message) { return message[Watch.Key.value] || ""; }).join(""),
                     longValue);
});

test("watch encoder keeps metadata out of core flags", function() {
  var messages = Watch.encodeOperation({
    type: "node",
    node: {
      kind: "progress",
      parentId: "s",
      attrs: { id: "p", value: "4", min: "0", max: "10", selected: "true" }
    }
  }, 1);
  assert.strictEqual(messages[0][Watch.Key.meta], "max=10 min=0");
  assert.strictEqual(messages[0][Watch.Key.flags] & 64, 64);
});

test("field type reaches the native metadata parser and patches can clear values", function() {
  var add = Watch.encodeOperation({
    type: "node",
    node: {
      kind: "field",
      parentId: "s",
      attrs: { id: "count", title: "Count", value: "2", type: "number", min: "1", max: "5" }
    }
  }, 1)[0];
  var patch = Watch.encodeOperation({
    type: "patch",
    target: "count",
    attrs: { id: "count", title: "Count", value: "", type: "number", min: "1", max: "5" },
    node: { kind: "patch", attrs: { target: "count" } }
  }, 1)[0];
  assert.strictEqual(add[Watch.Key.meta], "max=5 min=1 type=number");
  assert.ok(Object.prototype.hasOwnProperty.call(patch, Watch.Key.value));
  assert.strictEqual(patch[Watch.Key.value], "");
});

test("UTF-8 splitting preserves valid and malformed JavaScript strings", function() {
  var sources = [
    "plain ASCII",
    "é漢🙂".repeat(90),
    "before\uD800after",
    "low\uDC00surrogate",
    "🙂".repeat(100)
  ];
  sources.forEach(function(source) {
    [4, 7, 31, 180].forEach(function(limit) {
      var chunks = Watch.splitUtf8(source, limit);
      assert.strictEqual(chunks.join(""), source);
      chunks.forEach(function(chunk) {
        assert.ok(Buffer.byteLength(chunk, "utf8") <= limit,
                  "chunk exceeded " + limit + " bytes");
      });
    });
  });
});

test("watch encoder covers begin, remove, end, error, and capability operations", function() {
  var begin = Watch.encodeOperation({
    type: "begin",
    node: { attrs: { id: "home", layout: "grid", title: "Home", columns: "3", actionbar: "true", status: "true" } }
  }, 8)[0];
  var remove = Watch.encodeOperation({ type: "remove", target: "old", node: { attrs: {} } }, 8)[0];
  var end = Watch.encodeOperation({ type: "end", node: { attrs: {} } }, 8)[0];
  var error = Watch.encodeOperation({ type: "agent_error", node: { attrs: { message: "Nope" } } }, 8)[0];
  var capability = Watch.encodeOperation({
    type: "capability",
    node: { attrs: { type: "timer", command: "start", id: "tea", title: "Tea", duration: "5m" } }
  }, 8)[0];
  assert.strictEqual(begin[Watch.Key.kind], "grid");
  assert.strictEqual(begin[Watch.Key.meta], "actionbar=true columns=3");
  assert.strictEqual(begin[Watch.Key.flags], 16);
  assert.strictEqual(remove[Watch.Key.operation], "remove");
  assert.strictEqual(end[Watch.Key.operation], "end");
  assert.strictEqual(error[Watch.Key.messageType], "status");
  assert.strictEqual(error[Watch.Key.value], "Nope");
  assert.strictEqual(capability[Watch.Key.meta], "duration=5m");
});

test("watch encoder maps all boolean flags without accepting false-like values", function() {
  var enabled = Watch.encodeOperation({
    type: "node",
    node: { kind: "item", parentId: "x", attrs: {
      id: "a", disabled: "yes", checked: "1", destructive: "true",
      primary: "yes", selected: "true"
    } }
  }, 1)[0];
  var disabled = Watch.encodeOperation({
    type: "node",
    node: { kind: "item", parentId: "x", attrs: {
      id: "b", disabled: "false", checked: "0", destructive: "no",
      primary: "false", selected: "0"
    } }
  }, 1)[0];
  assert.strictEqual(enabled[Watch.Key.flags], 1 | 2 | 4 | 8 | 64);
  assert.strictEqual(disabled[Watch.Key.flags], 0);
});

test("watch encoder truncates bounded fields on UTF-8 boundaries", function() {
  var message = Watch.encodeOperation({
    type: "node",
    node: { kind: "item", parentId: "p".repeat(40), attrs: {
      id: "🙂".repeat(30),
      title: "é".repeat(80),
      subtitle: "漢".repeat(80),
      action: "🙂".repeat(30)
    } }
  }, 1)[0];
  assert.ok(Buffer.byteLength(message[Watch.Key.elementId], "utf8") <= 32);
  assert.ok(Buffer.byteLength(message[Watch.Key.parentId], "utf8") <= 32);
  assert.ok(Buffer.byteLength(message[Watch.Key.title], "utf8") <= 72);
  assert.ok(Buffer.byteLength(message[Watch.Key.subtitle], "utf8") <= 100);
  assert.ok(Buffer.byteLength(message[Watch.Key.action], "utf8") <= 48);
});

test("a capability is a standalone render result", function() {
  var operations = [];
  var model = new Model.ScreenModel({
    onOperation: function(operation) { operations.push(operation.type); },
    onError: function() {}
  });
  parse("pam version=1\ncapability type=timer command=start duration=1m\ndone\n")
    .forEach(function(node) { model.accept(node); });
  assert.deepStrictEqual(operations, ["header", "capability"]);
});

test("watch message queue preserves order and retries", function(done) {
  var attempts = [];
  var failFirst = true;
  var queue = new Watch.MessageQueue(function(message, success, failure) {
    attempts.push(message.value);
    setTimeout(function() {
      if (failFirst) {
        failFirst = false;
        failure(new Error("busy"));
      } else {
        success();
      }
    }, 1);
  }, { retryDelay: 1, maxRetries: 2 });
  queue.enqueue({ value: "one" });
  queue.enqueue({ value: "two" });
  setTimeout(function() {
    assert.deepStrictEqual(attempts, ["one", "one", "two"]);
    done();
  }, 30);
});

test("watch message queue reports overflow and exhausted retries", function(done) {
  var failures = [];
  var sendFailures = [];
  var callbacks = [];
  var queue = new Watch.MessageQueue(function(message, success, failure) {
    callbacks.push(function() { failure(new Error("busy " + message.value)); });
  }, {
    maxQueue: 2,
    maxRetries: 0,
    retryDelay: 1,
    onError: function(error) { failures.push(error.message); }
  });
  assert.strictEqual(queue.enqueue({ value: "one" }), true);
  assert.strictEqual(queue.enqueue({ value: "two" }), true);
  assert.strictEqual(queue.enqueue({ value: "three" }), false);
  callbacks.shift()();
  setTimeout(function() {
    assert.deepStrictEqual(failures, ["watch message queue is full", "busy one"]);
    assert.strictEqual(callbacks.length, 1);
    callbacks.shift()();
    setTimeout(function() {
      sendFailures.push.apply(sendFailures, failures);
      assert.deepStrictEqual(sendFailures, [
        "watch message queue is full", "busy one", "busy two"
      ]);
      done();
    }, 2);
  }, 2);
});

test("watch message queue clears stale requests but lets the in-flight send finish", function() {
  var sent = [];
  var complete;
  var queue = new Watch.MessageQueue(function(message, success) {
    sent.push(message[Watch.Key.requestId]);
    complete = success;
  });
  queue.enqueue((function() { var m = {}; m[Watch.Key.requestId] = 1; return m; }()));
  queue.enqueue((function() { var m = {}; m[Watch.Key.requestId] = 1; return m; }()));
  queue.enqueue((function() { var m = {}; m[Watch.Key.requestId] = 2; return m; }()));
  queue.clearRequest(1);
  assert.strictEqual(queue.queue.length, 2);
  complete();
  assert.deepStrictEqual(sent, [1, 2]);
});

test("agent request is hierarchical PAM, not JSON", function() {
  var source = AgentClientModule.buildRequest({
    id: 3,
    session: "abc",
    endpoint: "https://example.test",
    input: { kind: "dictation", text: "timer \"tea\"" },
    context: { screen: "home", layout: "list" },
    device: { platform: "emery", touch: true, now: 1788220800, utc_offset_minutes: -420 }
  });
  assert.ok(source.indexOf("pam version=1\nrequest id=3") === 0);
  assert.ok(source.indexOf("  input") !== -1);
  assert.ok(source.indexOf("text=\"timer \\\"tea\\\"\"") !== -1);
  assert.ok(source.indexOf("now=1788220800") !== -1);
  assert.ok(source.indexOf("utc_offset_minutes=-420") !== -1);
  assert.doesNotThrow(function() { parse(source, { requireHeader: true }); });
});

test("HTTP agent client forwards incremental response deltas once", function() {
  function FakeXHR() {
    this.headers = {};
    this.responseText = "";
    this.readyState = 0;
    this.status = 0;
  }
  FakeXHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  FakeXHR.prototype.setRequestHeader = function(name, value) { this.headers[name] = value; };
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() {};
  var chunks = [];
  var completed = 0;
  var client = new AgentClientModule.AgentClient({ XMLHttpRequest: FakeXHR });
  var xhr = client.send({ endpoint: "https://agent.test", id: 1 }, {
    onChunk: function(chunk) { chunks.push(chunk); },
    onDone: function() { completed += 1; }
  });
  xhr.responseText = "pam version=1\n";
  xhr.readyState = 3;
  xhr.onreadystatechange();
  xhr.responseText += "screen id=x layout=text\n";
  xhr.onprogress();
  xhr.status = 200;
  xhr.readyState = 4;
  xhr.onreadystatechange();
  if (xhr.onload) { xhr.onload(); }
  assert.deepStrictEqual(chunks, ["pam version=1\n", "screen id=x layout=text\n"]);
  assert.strictEqual(completed, 1);
  assert.strictEqual(xhr.headers.Accept, "text/x-pebble-agent-markup; version=1");
});

test("agent client validates endpoints and reports HTTP failure modes once", function() {
  var errors = [];
  var client = new AgentClientModule.AgentClient({ XMLHttpRequest: function() {} });
  assert.strictEqual(client.send({ endpoint: "" }, { onError: function(error) { errors.push(error.message); } }), null);
  assert.strictEqual(client.send({ endpoint: "ftp://bad" }, { onError: function(error) { errors.push(error.message); } }), null);
  assert.deepStrictEqual(errors, [
    "Configure an agent endpoint in the phone app",
    "Agent endpoint must use HTTPS, HTTP, WSS, or WS"
  ]);

  function FakeXHR() { this.headers = {}; this.responseText = ""; }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.setRequestHeader = function(name, value) { this.headers[name] = value; };
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() { this.aborted = true; if (this.onerror) { this.onerror(); } };
  client = new AgentClientModule.AgentClient({ XMLHttpRequest: FakeXHR });
  var firstErrors = 0;
  var first = client.send({ endpoint: "https://one.test", token: "secret", timeoutSeconds: 500 }, {
    onError: function() { firstErrors += 1; }
  });
  var secondErrors = [];
  var second = client.send({ endpoint: "https://two.test", timeoutSeconds: 1 }, {
    onError: function(error) { secondErrors.push(error.message); }
  });
  assert.strictEqual(first.aborted, true);
  assert.strictEqual(firstErrors, 0);
  assert.strictEqual(first.headers.Authorization, "Bearer secret");
  assert.strictEqual(first.timeout, 120000);
  assert.strictEqual(second.timeout, 10000);
  second.status = 503;
  second.readyState = 4;
  second.onreadystatechange();
  if (second.onerror) { second.onerror(); }
  assert.deepStrictEqual(secondErrors, ["Agent HTTP 503"]);
});

test("agent client reports HTTP network and timeout errors", function() {
  function FakeXHR() { this.headers = {}; this.responseText = ""; }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function() {};
  FakeXHR.prototype.abort = function() {};
  var client = new AgentClientModule.AgentClient({ XMLHttpRequest: FakeXHR });
  var messages = [];
  var xhr = client.send({ endpoint: "https://agent.test" }, {
    onError: function(error) { messages.push(error.message); }
  });
  xhr.onerror();
  xhr.ontimeout();
  assert.deepStrictEqual(messages, ["Could not reach agent endpoint"]);
  xhr = client.send({ endpoint: "https://agent.test" }, {
    onError: function(error) { messages.push(error.message); }
  });
  xhr.ontimeout();
  assert.deepStrictEqual(messages, ["Could not reach agent endpoint", "Agent request timed out"]);
});

test("WebSocket agent client sends PAM, streams messages, and handles close codes", function() {
  var sockets = [];
  var timers = [];
  function FakeSocket(endpoint, protocol) {
    this.endpoint = endpoint;
    this.protocol = protocol;
    this.sent = [];
    sockets.push(this);
  }
  FakeSocket.prototype.send = function(value) { this.sent.push(value); };
  FakeSocket.prototype.close = function() { this.closed = true; };
  var client = new AgentClientModule.AgentClient({
    WebSocket: FakeSocket,
    setTimeout: function(fn) { timers.push(fn); return timers.length; },
    clearTimeout: function() {}
  });
  var chunks = [];
  var done = 0;
  var errors = [];
  var socket = client.send({
    endpoint: "wss://agent.test/socket", id: 4, session: "s", token: "token"
  }, {
    onChunk: function(chunk) { chunks.push(chunk); },
    onDone: function() { done += 1; },
    onError: function(error) { errors.push(error.message); }
  });
  assert.strictEqual(socket.protocol, "pam.v1");
  socket.onopen();
  assert.match(socket.sent[0], /\n  auth bearer=token\n/);
  socket.onmessage({ data: "pam version=1\n" });
  socket.onmessage({ data: "screen id=x layout=text\n" });
  socket.onclose({ code: 1000 });
  assert.deepStrictEqual(chunks, ["pam version=1\n", "screen id=x layout=text\n"]);
  assert.strictEqual(done, 1);
  assert.deepStrictEqual(errors, []);

  socket = client.send({ endpoint: "ws://agent.test", id: 5 }, {
    onError: function(error) { errors.push(error.message); }
  });
  socket.onclose({ code: 1006 });
  assert.strictEqual(errors[0], "Agent WebSocket closed 1006");
});

test("WebSocket timeout closes the socket and abort suppresses stale callbacks", function() {
  var timerCallbacks = [];
  function FakeSocket() {}
  FakeSocket.prototype.send = function() {};
  FakeSocket.prototype.close = function() {
    this.closed = true;
    if (this.onclose) { this.onclose({ code: 1000 }); }
  };
  var client = new AgentClientModule.AgentClient({
    WebSocket: FakeSocket,
    setTimeout: function(fn) { timerCallbacks.push(fn); return timerCallbacks.length; },
    clearTimeout: function() {}
  });
  var errors = [];
  var done = 0;
  var first = client.send({ endpoint: "wss://one.test" }, {
    onDone: function() { done += 1; },
    onError: function(error) { errors.push(error.message); }
  });
  var second = client.send({ endpoint: "wss://two.test" }, {
    onDone: function() { done += 1; },
    onError: function(error) { errors.push(error.message); }
  });
  assert.strictEqual(first.closed, true);
  assert.strictEqual(done, 0);
  timerCallbacks[1]();
  assert.strictEqual(second.closed, true);
  assert.deepStrictEqual(errors, ["Agent request timed out"]);
  assert.strictEqual(done, 0);
});

test("settings normalize and round-trip", function() {
  var data = {};
  var storage = {
    getItem: function(key) { return data[key] || null; },
    setItem: function(key, value) { data[key] = value; }
  };
  Settings.save({ endpoint: "  https://agent.test  ", units: "bogus", timeoutSeconds: 500 }, storage);
  var loaded = Settings.load(storage);
  assert.strictEqual(loaded.endpoint, "https://agent.test");
  assert.strictEqual(loaded.units, "auto");
  assert.strictEqual(loaded.timeoutSeconds, 120);
  assert.deepStrictEqual(Settings.parseConfigResponse(encodeURIComponent(JSON.stringify(loaded))), loaded);
});

test("settings recover from corrupt storage and reject canceled configuration", function() {
  var storage = {
    getItem: function() { return "{bad"; },
    setItem: function() { throw new Error("unexpected write"); }
  };
  assert.deepStrictEqual(Settings.load(storage), {
    endpoint: "",
    token: "",
    units: "auto",
    locationLabel: "Current location",
    timeoutSeconds: 45
  });
  assert.strictEqual(Settings.parseConfigResponse("CANCELLED"), null);
  assert.strictEqual(Settings.parseConfigResponse("%not-json"), null);
  assert.strictEqual(Settings.parseConfigResponse(""), null);
});

test("configuration URL embeds normalized state without exposing it in the query", function() {
  var url = Settings.buildConfigUrl({
    endpoint: " https://agent.test ",
    token: "secret",
    units: "metric",
    locationLabel: "A".repeat(100),
    timeoutSeconds: 2
  }, "nonce");
  var hash = url.slice(url.indexOf("#") + 1);
  var state = JSON.parse(decodeURIComponent(hash));
  assert.match(url, /\?v=nonce#/);
  assert.strictEqual(url.slice(0, url.indexOf("#")).indexOf("secret"), -1);
  assert.strictEqual(state.endpoint, "https://agent.test");
  assert.strictEqual(state.token, "secret");
  assert.strictEqual(state.locationLabel.length, 64);
  assert.strictEqual(state.timeoutSeconds, 10);
});

test("capability registry is extensible and built-ins route locally", function() {
  var seen = [];
  var registry = Capabilities.installBuiltins(new Capabilities.CapabilityRegistry());
  registry.register("custom", function(attrs) { seen.push(attrs.command); });
  assert.ok(registry.has("timer"));
  assert.ok(registry.handle({ node: { attrs: { type: "custom", command: "go" } } }, {}));
  assert.deepStrictEqual(seen, ["go"]);
});

test("capability registry validates registrations and reports unknown modules", function() {
  var registry = new Capabilities.CapabilityRegistry();
  assert.throws(function() { registry.register("Bad Name", function() {}); }, /invalid capability/);
  assert.throws(function() { registry.register("valid", null); }, /invalid capability/);
  assert.strictEqual(registry.handle({ node: { attrs: { type: "missing" } } }, {}), false);
});

test("inline weather capability emits a complete card", function() {
  var rendered = "";
  Weather.renderInline({
    id: "wx",
    location: "Portland",
    temperature: "70",
    unit: "°F",
    condition: "Clear",
    high: "74",
    low: "53"
  }, {
    settings: { locationLabel: "Here" },
    renderPam: function(source) { rendered = source; }
  });
  var nodes = parse(rendered);
  assert.strictEqual(nodes[1].attrs.layout, "card");
  assert.strictEqual(nodes[2].attrs.value, "70°F");
  assert.strictEqual(nodes[nodes.length - 1].kind, "done");
});

test("weather fetch builds a metric request and renders a validated forecast", function() {
  var requests = [];
  function FakeXHR() { requests.push(this); }
  FakeXHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  FakeXHR.prototype.send = function() { this.sent = true; };
  var statuses = [];
  var errors = [];
  var rendered = "";
  var handler = Weather.createWeatherHandler({ XMLHttpRequest: FakeXHR });
  handler({ command: "current", id: "wx", latitude: "45.5", longitude: "-122.6" }, {
    settings: { units: "metric", locationLabel: "Portland" },
    status: function(value) { statuses.push(value); },
    error: function(value) { errors.push(value); },
    renderPam: function(value) { rendered = value; }
  });
  assert.strictEqual(requests.length, 1);
  assert.match(requests[0].url, /latitude=45.5/);
  assert.match(requests[0].url, /longitude=-122.6/);
  assert.doesNotMatch(requests[0].url, /temperature_unit=fahrenheit/);
  assert.deepStrictEqual(statuses, ["Loading weather"]);
  requests[0].status = 200;
  requests[0].responseText = JSON.stringify({
    current: { temperature_2m: 12.6, apparent_temperature: 11.2, weather_code: 2, wind_speed_10m: 9.8 },
    current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
    daily: {
      time: ["2026-08-30", "2026-08-31", "2026-09-01"],
      weather_code: [2, 61, 95],
      temperature_2m_max: [18.2, 16.9, 15.1],
      temperature_2m_min: [8.4, 7.1, 6.2]
    }
  });
  requests[0].onload();
  assert.deepStrictEqual(errors, []);
  var nodes = parse(rendered);
  assert.strictEqual(nodes[1].attrs.title, "Portland");
  assert.strictEqual(nodes[2].attrs.value, "13°C");
  assert.strictEqual(nodes[3].attrs.value, "Partly cloudy");
  assert.strictEqual(nodes.filter(function(node) { return node.kind === "item"; }).length, 3);
});

test("weather uses geolocation, imperial units, and reports permission errors", function() {
  var requests = [];
  var geolocation = {
    getCurrentPosition: function(success) {
      success({ coords: { latitude: 37.7, longitude: -122.4 } });
    }
  };
  function FakeXHR() { requests.push(this); }
  FakeXHR.prototype.open = function(method, url) { this.url = url; };
  FakeXHR.prototype.send = function() {};
  var statuses = [];
  var errors = [];
  var handler = Weather.createWeatherHandler({ XMLHttpRequest: FakeXHR, geolocation: geolocation });
  handler({ command: "fetch", units: "imperial" }, {
    settings: { units: "auto", locationLabel: "Here" },
    status: function(value) { statuses.push(value); },
    error: function(value) { errors.push(value); },
    renderPam: function() {}
  });
  assert.deepStrictEqual(statuses, ["Finding location", "Loading weather"]);
  assert.match(requests[0].url, /temperature_unit=fahrenheit/);
  assert.match(requests[0].url, /wind_speed_unit=mph/);

  handler = Weather.createWeatherHandler({
    XMLHttpRequest: FakeXHR,
    geolocation: { getCurrentPosition: function(success, failure) { failure(); } }
  });
  handler({ command: "current" }, {
    settings: { units: "metric" },
    status: function() {},
    error: function(value) { errors.push(value); },
    renderPam: function() {}
  });
  assert.strictEqual(errors[0], "Location permission is required for weather");
});

test("weather rejects unsupported commands and malformed network responses", function() {
  var errors = [];
  var requests = [];
  function FakeXHR() { requests.push(this); }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.send = function() {};
  var context = {
    settings: { units: "metric" },
    status: function() {},
    error: function(value) { errors.push(value); },
    renderPam: function() { throw new Error("should not render"); }
  };
  var handler = Weather.createWeatherHandler({ XMLHttpRequest: FakeXHR });
  handler({ command: "delete", latitude: "1", longitude: "2" }, context);
  assert.strictEqual(errors.pop(), "Unsupported weather command");
  handler({ command: "current", latitude: "1", longitude: "2" }, context);
  requests[0].status = 200;
  requests[0].responseText = "{}";
  requests[0].onload();
  assert.strictEqual(errors.pop(), "Weather response was incomplete");
  handler({ command: "current", latitude: "1", longitude: "2" }, context);
  requests[1].onerror();
  assert.strictEqual(errors.pop(), "Could not load weather");
});

test("writer API produces valid streaming screens and capabilities", function() {
  var streamed = [];
  var writer = new Writer.Writer({ onLine: function(line) { streamed.push(line); } });
  writer.beginScreen("home", "grid", { title: "Home", columns: 2 })
    .item({ id: "one", title: "One", action: "open.one" })
    .item({ id: "two", title: "Two", action: "open.two" })
    .bind({ id: "voice-help", input: "down", action: "help", title: "Help" })
    .endScreen()
    .capability("timer", "start", { id: "tea", duration: "5m" });
  assert.strictEqual(streamed.length, 7);
  assert.doesNotThrow(function() { parse(writer.toString()); });
  assert.ok(writer.toString().indexOf("capability command=start duration=5m id=tea type=timer") !== -1);
});

test("writer API enforces state and supports nested element trees", function() {
  var writer = new Writer.Writer();
  assert.throws(function() { writer.item({ id: "early" }); }, /no open screen/);
  assert.throws(function() { writer.beginScreen("x", "unknown"); }, /invalid screen/);
  writer.beginScreen("x", "list")
    .open("section", { id: "parent", title: "Parent" })
    .item({ id: "child", title: "Child" })
    .close()
    .endScreen()
    .patch("child", { title: "Changed" })
    .remove("child")
    .error("failed");
  var nodes = parse(writer.toString());
  assert.strictEqual(nodes[3].parent.attrs.id, "parent");
  assert.strictEqual(nodes[nodes.length - 1].kind, "error");
  assert.throws(function() { writer.close(); }, /no nested element/);
  assert.throws(function() { writer.endScreen(); }, /no screen is open/);
});

test("writer exports every model layout, element, and bindable input", function() {
  assert.deepStrictEqual(Writer.Layouts.slice().sort(), Object.keys(Model.LAYOUTS).sort());
  assert.deepStrictEqual(Writer.Elements.slice().sort(), Object.keys(Model.NODE_KINDS).sort());
  ["up", "select", "down", "back", "tap", "swipe-left", "swipe-right", "swipe-up", "swipe-down"]
    .forEach(function(input) { assert.ok(Writer.Inputs.indexOf(input) >= 0); });
  assert.strictEqual(Writer.Inputs.indexOf("long-select"), -1);
});

function loadPkjsHarness(options) {
  options = options || {};
  var handlers = {};
  var sent = [];
  var opened = [];
  var storageData = options.storageData || {};
  var modulePath = require.resolve("../src/pkjs/index");
  global.localStorage = {
    getItem: function(key) { return storageData[key] == null ? null : storageData[key]; },
    setItem: function(key, value) { storageData[key] = String(value); }
  };
  if (options.XMLHttpRequest) { global.XMLHttpRequest = options.XMLHttpRequest; }
  if (options.WebSocket) { global.WebSocket = options.WebSocket; }
  global.Pebble = {
    addEventListener: function(name, handler) { handlers[name] = handler; },
    sendAppMessage: function(message, success) {
      sent.push(message);
      if (success) { success(); }
    },
    openURL: function(url) { opened.push(url); },
    getActiveWatchInfo: function() {
      return options.watchInfo || { platform: "emery", model: "pebble_time_2" };
    }
  };
  delete require.cache[modulePath];
  require(modulePath);
  return {
    handlers: handlers,
    sent: sent,
    opened: opened,
    storageData: storageData,
    cleanup: function() {
      delete require.cache[modulePath];
      delete global.Pebble;
      delete global.localStorage;
      delete global.XMLHttpRequest;
      delete global.WebSocket;
      delete global.navigator;
    }
  };
}

test("PebbleKit bridge renders onboarding and round-trips configuration", function() {
  var harness = loadPkjsHarness();
  try {
    harness.handlers.appmessage({ payload: { 0: "ready", 8: "" } });
    assert.deepStrictEqual(harness.sent.map(function(message) { return message[Watch.Key.operation]; }),
                           ["begin", "add", "add", "add", "end"]);
    assert.strictEqual(harness.sent[0][Watch.Key.kind], "list");
    assert.strictEqual(harness.sent[0][Watch.Key.title], "Pebble Agent");
    harness.handlers.showConfiguration();
    assert.strictEqual(harness.opened.length, 1);
    assert.ok(harness.opened[0].indexOf(Settings.CONFIG_URL) === 0);
    harness.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({
      endpoint: "https://agent.test", token: "t", units: "metric",
      locationLabel: "Here", timeoutSeconds: 30
    })) });
    assert.match(harness.storageData[Settings.STORAGE_KEY], /https:\/\/agent\.test/);
    assert.ok(harness.sent.some(function(message) {
      return message[Watch.Key.title] === "Agent connected";
    }));
  } finally {
    harness.cleanup();
  }
});

test("PebbleKit bridge carries watch input through HTTP streaming to render operations", function() {
  var xhr;
  function FakeXHR() { this.headers = {}; this.responseText = ""; xhr = this; }
  FakeXHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  FakeXHR.prototype.setRequestHeader = function(name, value) { this.headers[name] = value; };
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() {};
  var storage = {};
  storage[Settings.STORAGE_KEY] = JSON.stringify({
    endpoint: "https://agent.test/respond", token: "secret", units: "metric",
    locationLabel: "Here", timeoutSeconds: 30
  });
  var harness = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    harness.handlers.appmessage({ payload: {
      0: "input", 2: "dictation", 4: "", 8: "show choices", 9: ""
    } });
    assert.strictEqual(xhr.method, "POST");
    assert.strictEqual(xhr.url, "https://agent.test/respond");
    assert.strictEqual(xhr.headers.Authorization, "Bearer secret");
    var requestNodes = parse(xhr.body);
    assert.strictEqual(requestNodes[2].attrs.kind, "dictation");
    assert.strictEqual(requestNodes[2].attrs.text, "show choices");
    assert.match(requestNodes[4].attrs.now, /^\d+$/);
    assert.match(requestNodes[4].attrs.utc_offset_minutes, /^-?\d+$/);
    xhr.responseText = "pam version=1\nscreen id=answer layout=choice title=Choose\n" +
      "  choice id=a title=Alpha action=choose.a\n";
    xhr.readyState = 3;
    xhr.onreadystatechange();
    assert.ok(harness.sent.some(function(message) {
      return message[Watch.Key.operation] === "add" && message[Watch.Key.elementId] === "a";
    }));
    xhr.responseText += "done\n";
    xhr.status = 200;
    xhr.readyState = 4;
    xhr.onreadystatechange();
    var operations = harness.sent.map(function(message) { return message[Watch.Key.operation]; });
    assert.ok(operations.indexOf("loading") >= 0);
    assert.ok(operations.indexOf("begin") >= 0);
    assert.ok(operations.indexOf("end") >= 0);
    assert.ok(operations.indexOf("idle") >= 0);
  } finally {
    harness.cleanup();
  }
});

test("Capability delivery IDs distinguish identical model commands and survive bridge reload", function() {
  var xhr;
  function FakeXHR() { this.responseText = ""; xhr = this; }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function() {};
  FakeXHR.prototype.abort = function() {};
  var storage = {};
  storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test" });
  var lastId = 0;
  for (var round = 0; round < 2; ++round) {
    var harness = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
    try {
      harness.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: "start two timers" } });
      xhr.responseText = "pam version=1\n" +
        "capability type=timer command=start id=timer duration=10s\n" +
        "capability type=timer command=start id=timer duration=60s\n";
      xhr.status = 200; xhr.readyState = 4; xhr.onreadystatechange();
      var messages = harness.sent.filter(function(m) { return m[Watch.Key.messageType] === "capability"; });
      assert.strictEqual(messages.length, 2);
      assert.ok(messages[0][Watch.Key.index] > lastId);
      assert.ok(messages[1][Watch.Key.index] > messages[0][Watch.Key.index]);
      assert.strictEqual(messages[0][Watch.Key.elementId], "timer");
      assert.strictEqual(messages[1][Watch.Key.elementId], "timer");
      lastId = messages[1][Watch.Key.index];
    } finally { harness.cleanup(); }
  }
});

test("Native dashboard survives bridge startup, configuration, and local notifications", function() {
  var requests = 0;
  function FakeXHR() { requests += 1; }
  var harness = loadPkjsHarness({ XMLHttpRequest: FakeXHR });
  try {
    harness.handlers.appmessage({ payload: { 0: "ready", 8: "local-active" } });
    assert.strictEqual(harness.sent.length, 1);
    assert.strictEqual(harness.sent[0][Watch.Key.messageType], "bridge");
    ["timer.finished", "reminder.acknowledged", "stopwatch.reset"].forEach(function(action) {
      harness.handlers.appmessage({ payload: { 0: "capability_event", 9: action } });
    });
    assert.strictEqual(requests, 0);
    harness.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ endpoint: "https://agent.test" })) });
    assert.ok(harness.sent.every(function(message) { return message[Watch.Key.messageType] === "bridge"; }));
  } finally { harness.cleanup(); }
});

function runOne(entry) {
  return new Promise(function(resolve, reject) {
    var finished = false;
    function done(error) {
      if (finished) { return; }
      finished = true;
      if (error) { reject(error); } else { resolve(); }
    }
    try {
      if (entry.fn.length) {
        entry.fn(done);
      } else {
        Promise.resolve(entry.fn()).then(function() { done(); }, done);
      }
    } catch (error) {
      done(error);
    }
  });
}

(async function() {
  var passed = 0;
  for (var index = 0; index < tests.length; index += 1) {
    try {
      await runOne(tests[index]);
      passed += 1;
      process.stdout.write("✓ " + tests[index].name + "\n");
    } catch (error) {
      process.stderr.write("✗ " + tests[index].name + "\n" + (error.stack || error) + "\n");
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write("\n" + passed + " tests passed\n");
}());
