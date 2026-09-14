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
var LocalDictation = require("../src/common/local-dictation");

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

test("forms add one dictated fallback and preserve deferred local actions", function() {
  var ops = [], m = new Model.ScreenModel({ onOperation: function(op) { ops.push(op); } });
  parse('pam version=1\nscreen id=q layout=choice\n  choice id=day title="Day" action=local.run capability=reminder seconds=86400 task="Card"\ndone\n').forEach(function(n) { m.accept(n); });
  assert.strictEqual(ops.filter(function(op) { return op.type === "capability"; }).length, 0);
  assert.strictEqual(ops.filter(function(op) { return op.node.attrs.action === "local.answer"; }).length, 1);
  assert.strictEqual(m.elements.day.attrs.seconds, "86400");
  assert.throws(function() { var bad = new Model.ScreenModel(); parse('pam version=1\nscreen id=q layout=form\n  field id=x type=dial min=10 max=1 step=1 value=2\ndone\n').forEach(function(n) { bad.accept(n); }); }, /Invalid control/);
});

test("screen model supports every public layout", function() {
  Object.keys(Model.LAYOUTS).forEach(function(layout) {
    var operations = [];
    var model = new Model.ScreenModel({ onOperation: function(op) { operations.push(op); } });
    var nodes = parse("pam version=1\nscreen id=s layout=" + layout + "\n  text value=Hello\ndone\n");
    nodes.forEach(function(node) { model.accept(node); });
    assert.deepStrictEqual(operations.map(function(op) { return op.type; }),
                           (layout === "form" || layout === "choice") ? ["header", "begin", "node", "node", "end"] : ["header", "begin", "node", "end"]);
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
      assert.strictEqual(Watch.truncateUtf8(source, limit), chunks[0]);
      assert.strictEqual(chunks.join(""), source);
      chunks.forEach(function(chunk) {
        assert.ok(Buffer.byteLength(chunk, "utf8") <= limit,
                  "chunk exceeded " + limit + " bytes");
      });
    });
  });
});

test("UTF-8 truncation handles short budgets and stops scanning after the prefix", function() {
  [null, undefined, "", 123, "é漢🙂end", "\uD800x\uDC00"].forEach(function(source) {
    [0, 1, 2, 3, 4, 7, 31].forEach(function(limit) {
      assert.strictEqual(Watch.truncateUtf8(source, limit), Watch.splitUtf8(source, limit)[0]);
    });
  });
  var source = "🙂".repeat(32768);
  var charCodeAt = String.prototype.charCodeAt;
  var reads = 0;
  String.prototype.charCodeAt = function(index) {
    reads++;
    return charCodeAt.call(this, index);
  };
  try {
    assert.strictEqual(Watch.truncateUtf8(source, 71), "🙂".repeat(17));
    assert.ok(reads <= 36, "truncation scanned beyond the next code point");
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
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
  assert.deepStrictEqual(secondErrors, ["Server returned HTTP 503. Try again shortly."]);
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
  assert.strictEqual(loaded.answerVibrate, true);
  assert.strictEqual(Settings.save({ answerVibrate: false }, storage).answerVibrate, false);
  assert.strictEqual(Settings.load(storage).answerVibrate, false);
  assert.deepStrictEqual(Settings.parseConfigResponse(encodeURIComponent(JSON.stringify(loaded))), loaded);
});

test("settings recover from corrupt storage and reject canceled configuration", function() {
  var storage = {
    getItem: function() { return "{bad"; },
    setItem: function() { throw new Error("unexpected write"); }
  };
  assert.deepStrictEqual(Settings.load(storage), Object.assign({}, Settings.DEFAULTS));
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
  assert.strictEqual(state.token, "");
  assert.strictEqual(state.tokenConfigured, true);
  assert.ok(!url.includes("secret"));
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
  var summary;
  var handler = Weather.createWeatherHandler({ XMLHttpRequest: FakeXHR });
  handler({ command: "current", id: "wx", latitude: "45.5", longitude: "-122.6" }, {
    settings: { units: "metric", locationLabel: "Portland" },
    summary: function(value) { summary = value; },
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
  assert.strictEqual(summary.temperature, "13");
  assert.strictEqual(summary.high, "18");
  assert.strictEqual(summary.low, "8");
  assert.strictEqual(summary.unit, "C");
  assert.strictEqual(summary.icon, "partly-cloudy");
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
  var statusRequests = [];
  var storageData = options.storageData || {};
  var modulePath = require.resolve("../src/pkjs/index");
  global.localStorage = {
    getItem: function(key) { return storageData[key] == null ? null : storageData[key]; },
    setItem: function(key, value) { storageData[key] = String(value); }
  };
  if (options.XMLHttpRequest) {
    // Keep telemetry requests separate from each feature's network fixtures.
    global.XMLHttpRequest = function() {};
    global.XMLHttpRequest.prototype.open = function(method, url, async) {
      if (/\/v1\/status$/.test(url)) {
        this.url = url; statusRequests.push(this);
        this.setRequestHeader = function() {};
        this.send = function() {};
        return;
      }
      var xhr = new options.XMLHttpRequest();
      xhr.open(method, url, async);
      var self = this;
      this.setRequestHeader = function(k,v) { xhr.setRequestHeader(k,v); };
      this.abort = function() { if(xhr.abort) xhr.abort(); };
      this.send = function(body) {
        Object.keys(self).forEach(function(k) { if(k !== "send" && k !== "abort" && k !== "setRequestHeader") xhr[k] = self[k]; });
        ["onload","onerror","ontimeout","onreadystatechange","onprogress"].forEach(function(k) {
          if(typeof self[k] === "function") xhr[k] = function() {
            ["status","responseText","readyState"].forEach(function(v) { self[v] = xhr[v]; });
            self[k]();
          };
        });
        xhr.send(body);
      };
    };
  }
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
    statusRequests: statusRequests,
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

function jobReply(h, xhr, source, status, open) {
  var entries = JSON.parse(h.storageData["pebble-agent.jobs.v1"]);
  var job = entries[entries.length - 1];
  xhr.status = 200;
  xhr.responseText = JSON.stringify({id:job.id,status:status || "done",result:source,error:status === "failed" ? "Request failed: invalid agent response" : ""});
  xhr.onload();
  if (open !== false) { h.handlers.appmessage({payload:{0:"capability_event",2:"job",4:job.id,9:"check"}}); }
  return job.id;
}

test("PebbleKit bridge keeps native dashboard and round-trips configuration", function() {
  var harness=loadPkjsHarness();
  try{
    harness.handlers.appmessage({payload:{0:"ready"}});
    assert.ok(!harness.sent.some(function(m){return m[0]==="render";}));
    harness.handlers.showConfiguration();assert.strictEqual(harness.opened.length,1);
    harness.handlers.webviewclosed({response:JSON.stringify({endpoint:"https://agent.test",token:"t",units:"metric"})});
    assert.match(harness.storageData[Settings.STORAGE_KEY],/agent.test/);
    assert.ok(harness.sent.some(function(m){return m[0]==="bridge" && /codey connected/.test(m[8]);}));
  }finally{harness.cleanup();}
});

test("new-session settings preserve old jobs and persist a fresh conversation", function() {
  var requests = [], aborted = 0;
  function FakeXHR() { this.responseText = ""; requests.push(this); }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() { aborted += 1; };
  var storage = { "pebble-agent.session.v1": "old-session" };
  var config = { endpoint: "https://agent.test", answerVibrate: false };
  storage[Settings.STORAGE_KEY] = JSON.stringify(config);
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  var fresh;
  function query() { h.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: "look up this app" } }); }
  try {
    h.handlers.appmessage({ payload: { 0: "ready" } });
    h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify(config)) });
    assert.strictEqual(storage["pebble-agent.session.v1"], "old-session");
    query();
    assert.strictEqual(parse(requests[0].body)[1].attrs.session, "old-session");
    requests[0].responseText = "pam version=1\nscreen id=old layout=card\n";

    h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify(Object.assign({}, config, { newSession: true }))) });
    fresh = storage["pebble-agent.session.v1"];
    assert.notStrictEqual(fresh, "old-session");
    assert.strictEqual(aborted, 0);
    assert.strictEqual(JSON.parse(storage[Settings.STORAGE_KEY]).newSession, undefined);
    assert.strictEqual(JSON.parse(storage[Settings.STORAGE_KEY]).answerVibrate, false);
    var sent = h.sent.length;
    jobReply(h, requests[0], "pam version=1\nscreen id=old layout=card\ndone\n", "done", false);
    assert.ok(h.sent.slice(sent).every(function(m) { return m[0] === "job"; }));
    query();
    var nodes = parse(requests[1].body);
    assert.strictEqual(nodes[1].attrs.session, fresh);
    assert.strictEqual(nodes[3].attrs.screen, "");
    h.handlers.webviewclosed({ response: "CANCELLED" });
    assert.strictEqual(storage["pebble-agent.session.v1"], fresh);
  } finally { h.cleanup(); }
  h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    query();
    assert.strictEqual(parse(requests[2].body)[1].attrs.session, fresh);
  } finally { h.cleanup(); }
});

test("New Chat resets the session before acknowledging dictation and carries no stale reset flag", function() {
  var requests = [], aborted = 0;
  function FakeXHR() { this.responseText = ""; requests.push(this); }
  FakeXHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() { this.aborted = true; aborted += 1; };
  var storage = { "pebble-agent.session.v1": "old-session" };
  storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test/respond" });
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    h.handlers.appmessage({ payload: { 0: "input", 1: 5, 2: "dictation", 8: "old request" } });
    assert.strictEqual(parse(requests[0].body)[1].attrs.session, "old-session");
    h.handlers.appmessage({ payload: { 0: "input", 1: 91, 2: "new-chat", 9: "local.new-chat" } });
    var fresh = storage["pebble-agent.session.v1"];
    assert.notStrictEqual(fresh, "old-session");
    assert.strictEqual(aborted, 0);
    assert.strictEqual(requests[0].aborted, undefined);
    var control = h.sent.filter(function(message) { return message[Watch.Key.messageType] === "control"; })[0];
    assert.ok(control);
    assert.strictEqual(control[Watch.Key.operation], "dictate");
    assert.strictEqual(control[Watch.Key.requestId], 91);
    h.handlers.appmessage({ payload: { 0: "input", 1: 6, 2: "dictation", 8: "fresh request" } });
    assert.strictEqual(parse(requests[1].body)[1].attrs.session, fresh);
    assert.strictEqual(storage["pebble-agent.session.v1"], fresh);
  } finally { h.cleanup(); }
});

test("Weather dashboard action opens the built-in local weather capability without contacting the agent", function() {
  var requests = [];
  function FakeXHR() { this.responseText = ""; requests.push(this); }
  FakeXHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() {};
  var storage = {};
  storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test/respond", units: "metric", locationLabel: "Here" });
  global.navigator = { geolocation: { getCurrentPosition: function(success) {
    success({ coords: { latitude: 45.5, longitude: -122.6 } });
  } } };
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    h.handlers.appmessage({ payload: { 0: "input", 1: 4, 2: "dictation", 8: "weather", 9: "local.weather" } });
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "GET");
    assert.match(requests[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    assert.match(requests[0].url, /latitude=45\.5/);
    assert.doesNotMatch(requests[0].url, /agent\.test/);
    assert.ok(h.sent.some(function(message) {
      return message[Watch.Key.messageType] === "status" && message[Watch.Key.value] === "Loading weather";
    }));
  } finally { h.cleanup(); }
});

test("Agent jobs notify without replacing the dashboard, render on tap, and acknowledge watch delivery", function() {
  var requests=[];
  function XHR(){requests.push(this);} XHR.prototype.open=function(m,u){this.method=m;this.url=u;};
  XHR.prototype.setRequestHeader=function(){}; XHR.prototype.send=function(body){this.body=body;};
  var storage={};storage[Settings.STORAGE_KEY]=JSON.stringify({endpoint:"https://agent.test/v1/agent"});
  var h=loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
  try {
    h.handlers.appmessage({payload:{0:"input",2:"dictation",8:"show choices"}});
    assert.match(requests[0].url,/\/v1\/jobs\/[a-f0-9]{30}$/);
    assert.ok(!h.sent.some(function(m){return m[0]==="render"||m[2]==="loading";}));
    var id=jobReply(h,requests[0],'pam version=1\nscreen id=answer layout=choice title=Choose\n  choice id=a title=Alpha action=choose.a\ndone\n',"done",false);
    assert.ok(h.sent.some(function(m){return m[0]==="job"&&m[7]==="done"&&m[11]===1;}));
    assert.ok(!h.sent.some(function(m){return m[0]==="render";}));
    h.handlers.appmessage({payload:{0:"capability_event",2:"job",4:id,9:"check"}});
    assert.ok(h.sent.some(function(m){return m[2]==="add"&&m[4]==="a";}));
    assert.ok(h.sent.some(function(m){return m[0]==="job-result";}));
    assert.strictEqual(requests.length,1,"no acknowledgement before watch confirms delivery");
    h.handlers.appmessage({payload:{0:"capability_event",2:"job",4:id,9:"retrieved"}});
    assert.ok(requests[1].url.endsWith("/ack"));
    assert.ok(JSON.parse(storage["pebble-agent.jobs.v1"])[0].result);
  } finally {h.cleanup();}
});

test("Notifications refresh updates rows without opening results", function() {
  var requests=[];
  function XHR(){requests.push(this);} XHR.prototype.open=function(method,url){this.url=url;};
  XHR.prototype.setRequestHeader=function(){}; XHR.prototype.send=function(){};
  var a="111111111111111111111111111111",b="222222222222222222222222222222";
  var storage={};storage[Settings.STORAGE_KEY]=JSON.stringify({endpoint:"https://agent.test"});
  storage["pebble-agent.jobs.v1"]=JSON.stringify([a,b].map(function(id){return {id:id,title:"Request",status:"working",accepted:true,endpoint:"https://agent.test/v1/jobs/"};}));
  var h=loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
  try {
    h.handlers.appmessage({payload:{0:"capability_event",2:"job",9:"refresh"}});
    assert.strictEqual(requests.length,2);
    assert.deepStrictEqual(h.sent.map(function(m){return m[2];}),["checking","checking"]);
    requests[0].status=200;requests[0].responseText=JSON.stringify({id:a,status:"done",result:"pam version=1\nscreen id=a layout=card\ndone\n"});requests[0].onload();
    requests[1].ontimeout();
    assert.ok(h.sent.every(function(m){return m[0]==="job"&&m[11]===0;}));
    assert.ok(h.sent.some(function(m){return m[4]===a&&m[7]==="done";}));
    assert.ok(h.sent.some(function(m){return m[4]===b&&/timed out/.test(m[8]);}));
    assert.strictEqual(requests.length,2);
  }finally{h.cleanup();}
});

test("Failed jobs retain the agent error in notifications", function() {
  var xhr;function XHR(){xhr=this;}XHR.prototype.open=XHR.prototype.setRequestHeader=XHR.prototype.send=function(){};
  var storage={};storage[Settings.STORAGE_KEY]=JSON.stringify({endpoint:"https://agent.test"});
  var h=loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
  try {
    h.handlers.appmessage({payload:{0:"input",2:"dictation",8:"find files"}});
    jobReply(h,xhr,"","failed");
    assert.ok(h.sent.some(function(m){return m[0]==="job"&&m[7]==="failed"&&m[8]==="Request failed: invalid agent response";}));
    assert.ok(!h.sent.some(function(m){return m[0]==="render";}));
  }finally{h.cleanup();}
});

test("Job submission timeout preserves an unconfirmed ID and a useful error", function() {
  var xhr;function XHR(){xhr=this;}XHR.prototype.open=XHR.prototype.setRequestHeader=XHR.prototype.send=function(){};
  var storage={};storage[Settings.STORAGE_KEY]=JSON.stringify({endpoint:"https://agent.test"});
  var h=loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
  try{
    h.handlers.appmessage({payload:{0:"input",2:"dictation",8:"find files"}});
    xhr.ontimeout();
    var j=JSON.parse(storage["pebble-agent.jobs.v1"])[0];assert.strictEqual(j.status,"unconfirmed");assert.match(j.error,/timed out/);
    assert.ok(h.sent.some(function(m){return m[0]==="job"&&m[7]==="unconfirmed";}));
  }finally{h.cleanup();}
});

test("Codex dashboard status throttles, reports missing data, and ignores old endpoints", function() {
 var Status=require("../src/common/dashboard-status"),requests=[],updates=[],settings={endpoint:"https://one.test/v1/agent",token:"secret"};
 function XHR(){requests.push(this);}XHR.prototype.open=function(method,url){this.url=url;};XHR.prototype.setRequestHeader=function(k,v){this.auth=v;};XHR.prototype.send=function(){};
 var status=new Status({settings:function(){return settings;},XMLHttpRequest:XHR,update:function(d){updates.push(d);}});
 status.refresh();status.refresh();assert.strictEqual(requests.length,1);assert.strictEqual(requests[0].url,"https://one.test/v1/status");assert.strictEqual(requests[0].auth,"Bearer secret");
 settings={endpoint:"https://two.test",token:"new"};status.refresh();assert.strictEqual(requests.length,2);
 requests[0].status=200;requests[0].responseText=JSON.stringify({remainingPercent:99,activeThreads:0,state:"idle"});requests[0].onload();assert.strictEqual(updates[updates.length-1].state,"unknown");
 requests[1].status=200;requests[1].responseText=JSON.stringify({remainingPercent:42,activeThreads:3,state:"working"});requests[1].onload();assert.strictEqual(updates[updates.length-1].activeThreads,3);
 status.refresh();assert.strictEqual(requests.length,2);status.last=Date.now()-61000;status.refresh();requests[2].ontimeout();assert.strictEqual(updates[updates.length-1].remainingPercent,null);
});

test("unenrolled collection writes are rejected without legacy phone persistence", function() {
  var storage={},h=loadPkjsHarness({storageData:storage});
  try {h.handlers.appmessage({payload:{0:"capability_event",2:"note",9:"list",8:"0",10:"42"}});
  assert.ok(h.sent.some(function(m){return m[0]==="answer"&&m[2]==="begin"&&m[12]===42;}));
  assert.ok(h.sent.some(function(m){return m[0]==="status"&&m[2]==="error";}));
  assert.strictEqual(storage["pebble-agent.notes.v1"],undefined);
  }finally{h.cleanup();}
});

test("note dictation preserves content and requires collection enrollment", function() {
  ["make a note ", "create a note: ", "please add a note ", "note: ", "note:"].forEach(function(prefix) {
    var attrs=LocalDictation.parse(prefix+"Call José tomorrow at 7").node.attrs;
    assert.strictEqual(attrs.type,"note");assert.strictEqual(attrs.command,"add");
    assert.strictEqual(attrs.value,"Call José tomorrow at 7");
  });
  var edit=LocalDictation.parse("edit a note Call José to Call Jane").node.attrs;
  assert.strictEqual(edit.command,"edit");assert.strictEqual(edit.match,"Call José");assert.strictEqual(edit.value,"Call Jane");
  assert.strictEqual(LocalDictation.parse("edit a note").node.attrs.command,"list");
  assert.strictEqual(LocalDictation.parse("show my notes").node.attrs.command,"list");
  ["make a note", "note:", "do not make a note Coffee", "explain how to create a note"].forEach(function(text){assert.strictEqual(LocalDictation.parse(text),null);});
  var h=loadPkjsHarness({XMLHttpRequest:function(){throw new Error("Note must stay local");}});
  try {
    h.handlers.appmessage({payload:{0:"input",2:"dictation",8:"note: set an alarm for 7 am"}});
    assert.ok(h.sent.some(function(m){return m[0]==="status" && m[2]==="error";}));
    assert.ok(!h.sent.some(function(m){return m[0]==="capability";}));
  } finally {h.cleanup();}
});

test("todo phrases accept creation verbs and preserve the complete task", function() {
  ["make a to-do to ", "set a task to ", "create a task to ", "please add a todo to ", "put down a task to "].forEach(function(prefix) {
    assert.strictEqual(LocalDictation.parse(prefix + "Call José about the New York trip").node.attrs.value, "Call José about the New York trip");
  });
  ["do not make a todo to buy milk", "can you explain how to set a task", "make a todo"].forEach(function(phrase) {
    assert.strictEqual(LocalDictation.parse(phrase), null);
  });
});
test("weather icons distinguish day, night, clouds and precipitation", function() {
  [[0,1,"sun"],[0,0,"moon"],[2,1,"partly-cloudy"],[2,0,"night-cloud"],[3,1,"cloud"],
    [63,1,"rain"],[73,1,"snow"],[95,0,"storm"],[999,1,"unknown"]].forEach(function(row) {
      assert.strictEqual(Weather.weatherIcon(row[0], row[1]), row[2]);
    });
});

test("bare todo prefix creates an item without interpreting its text as an alarm", function() {
  ["to-do", "To-do", "todo", "to do", "To-do:"].forEach(function(prefix) {
    var result = LocalDictation.parse(prefix + " send a birthday card to John.");
    assert.strictEqual(result.node.attrs.type, "todo");
    assert.strictEqual(result.node.attrs.command, "add");
    assert.strictEqual(result.node.attrs.value, "send a birthday card to John.");
  });
  assert.strictEqual(LocalDictation.parse("to-do set an alarm for 7 am").node.attrs.type, "todo");
  assert.strictEqual(LocalDictation.parse("to-do"), null);
  assert.strictEqual(LocalDictation.parse("please explain the to-do list"), null);
});

test("todo voice commands preserve item text and use the local capability", function() {
  var todo = LocalDictation.parse("Add a todo to Buy Milk and call José", new Date());
  assert.strictEqual(todo.node.attrs.type, "todo");
  assert.strictEqual(todo.node.attrs.command, "add");
  assert.strictEqual(todo.node.attrs.value, "Buy Milk and call José");
  assert.strictEqual(LocalDictation.parse("show my todos", new Date()).node.attrs.command, "list");
  assert.ok(Capabilities.installBuiltins(new Capabilities.CapabilityRegistry()).has("todo"));
});

test("Background completion honors vibration settings and keeps independent jobs alive", function() {
  [true,false].forEach(function(enabled){
    var requests=[];function XHR(){requests.push(this);}XHR.prototype.open=XHR.prototype.setRequestHeader=XHR.prototype.send=function(){};
    var storage={};storage[Settings.STORAGE_KEY]=JSON.stringify({endpoint:"https://agent.test",answerVibrate:enabled});
    var h=loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
    try{
      h.handlers.appmessage({payload:{0:"input",2:"dictation",8:"first request"}});
      jobReply(h,requests[0],"pam version=1\nscreen id=a layout=card\ndone\n","done",false);
      var arrived=h.sent.filter(function(m){return m[0]==="job"&&m[7]==="done";});
      assert.strictEqual(arrived.length,1);assert.strictEqual(arrived[0][11],enabled?1:0);
    }finally{h.cleanup();}
  });
});

test("answer arrival waits for phone weather and suppresses failed weather", function() {
  [true, false].forEach(function(success) {
    var requests = [];
    function FakeXHR() { this.responseText = ""; requests.push(this); }
    FakeXHR.prototype.open = function() {};
    FakeXHR.prototype.setRequestHeader = function() {};
    FakeXHR.prototype.send = function() {};
    FakeXHR.prototype.abort = function() {};
    var storage = {};
    storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test" });
    var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
    function completions() { return h.sent.filter(function(m) { return m[Watch.Key.messageType] === "job-result"; }); }
    try {
      h.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: "look up Portland conditions" } });
      requests[0].responseText = 'pam version=1\ncapability type=weather command=current latitude=45.5 longitude=-122.6\ndone\n';
      jobReply(h, requests[0], requests[0].responseText);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(completions().length, 0);
      if (success) {
        requests[1].status = 200;
        requests[1].responseText = JSON.stringify({ current: { temperature_2m: 12, apparent_temperature: 11, weather_code: 2, wind_speed_10m: 9 }, current_units: { temperature_2m: "C" }, daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [] } });
        requests[1].onload();
      } else { requests[1].onerror(); }
      assert.strictEqual(completions().length, success ? 1 : 0);
    } finally { h.cleanup(); }
  });
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
      jobReply(harness, xhr, xhr.responseText);
      var messages = harness.sent.filter(function(m) { return m[Watch.Key.messageType] === "capability"; });
      assert.strictEqual(messages.length, 2);
      assert.ok(messages[0][Watch.Key.index] > lastId);
      assert.ok(messages[1][Watch.Key.index] > messages[0][Watch.Key.index]);
      assert.strictEqual(messages[0][Watch.Key.elementId], "timer");
      assert.strictEqual(messages[1][Watch.Key.elementId], "timer");
      var savedJob = JSON.parse(storage["pebble-agent.jobs.v1"]).slice(-1)[0];
      harness.handlers.appmessage({payload:{0:"capability_event",2:"job",4:savedJob.id,9:"check"}});
      var replay = harness.sent.filter(function(m){return m[Watch.Key.messageType] === "capability";}).slice(-2);
      assert.strictEqual(replay[0][Watch.Key.index], messages[0][Watch.Key.index]);
      assert.strictEqual(replay[1][Watch.Key.index], messages[1][Watch.Key.index]);
      lastId = messages[1][Watch.Key.index];
    } finally { harness.cleanup(); }
  }
});

test("background weather updates only the tile and caches the forecast", function() {
  var requests = [], storage = {};
  function FakeXHR() { requests.push(this); }
  FakeXHR.prototype.open = function(method, url) { this.url = url; };
  FakeXHR.prototype.send = function() {};
  global.navigator = { geolocation: { getCurrentPosition: function(success) {
    success({ coords: { latitude: 45, longitude: -122 } });
  } } };
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    h.handlers.appmessage({ payload: { 0: "ready" } });
    assert.strictEqual(requests.length, 1);
    requests[0].status = 200;
    requests[0].responseText = JSON.stringify({ current: { temperature_2m: 12, weather_code: 0, is_day: 0 },
      daily: { time: ["2026-09-12"], temperature_2m_max: [18], temperature_2m_min: [8], weather_code: [0] } });
    requests[0].onload();
    assert.ok(h.sent.every(function(m) { return m[0] === "notes" || m[0] === "bridge" || (m[0] === "job" && m[2] === "reset"); }));
    var last = h.sent[h.sent.length - 1];
    assert.strictEqual(last[10], "icon=moon");
    assert.strictEqual(last[7], "L 8 H 18");
    assert.strictEqual(JSON.parse(storage["pebble-agent.weather.v1"]).temperature, "12");
    var sentBefore=h.sent.length;
    h.handlers.appmessage({ payload: { 0: "capability_event", 2: "weather", 9: "refresh" } });
    assert.strictEqual(requests.length, 1,"fresh cache avoids another network request");
    assert.strictEqual(h.sent.length,sentBefore,"unchanged weather avoids another watch message");
    var stale=JSON.parse(storage["pebble-agent.weather.v1"]);stale.updated=Date.now()-16*60*1000;
    storage["pebble-agent.weather.v1"]=JSON.stringify(stale);
    h.handlers.appmessage({ payload: { 0: "capability_event", 2: "weather", 9: "refresh" } });
    assert.strictEqual(requests.length, 2);
    requests[1].ontimeout();
    stale.updated=Date.now();
    storage["pebble-agent.weather.v1"]=JSON.stringify(stale);
    h.handlers.webviewclosed({response:JSON.stringify({units:"imperial"})});
    assert.strictEqual(requests.length,3,"changing units invalidates even a fresh weather cache");
    assert.strictEqual(JSON.parse(storage["pebble-agent.weather.v1"]),null);
    requests[2].ontimeout();
    assert.ok(h.sent.every(function(m) { return m[0] === "notes" || m[0] === "bridge" || (m[0] === "job" && m[2] === "reset"); }));
  } finally { h.cleanup(); }
});

test("dictated form answers bypass local regexes and retain question context", function() {
  var requests = [];
  function XHR() { this.responseText = ""; requests.push(this); }
  XHR.prototype.open = function() {}; XHR.prototype.setRequestHeader = function() {};
  XHR.prototype.send = function(body) { this.body = body; }; XHR.prototype.abort = function() {};
  var storage = {}; storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test" });
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: XHR });
  try {
    h.handlers.appmessage({ payload: { 0:"input", 2:"dictation", 8:"Ask me about timing" } });
    requests[0].responseText = 'pam version=1\nscreen id=when layout=choice\n  choice id=day title="Day" action=choose_day\ndone\n';
    jobReply(h, requests[0], requests[0].responseText);
    h.handlers.appmessage({ payload: { 0:"input", 2:"dictate-answer", 4:"custom", 9:"local.answer", 8:"set a timer for five minutes" } });
    assert.strictEqual(requests.length, 2);
    var nodes = parse(requests[1].body);
    assert.strictEqual(nodes.filter(function(n) {return n.kind === "input";})[0].attrs.kind, "dictate-answer");
    assert.strictEqual(nodes.filter(function(n) {return n.kind === "context";})[0].attrs.screen, "when");
  } finally {h.cleanup();}
});

test("Native dashboard survives bridge startup, configuration, and local notifications", function() {
  var requests = 0;
  function FakeXHR() { requests += 1; }
  var harness = loadPkjsHarness({ XMLHttpRequest: FakeXHR });
  try {
    harness.handlers.appmessage({ payload: { 0: "ready" } });
    assert.strictEqual(harness.sent.length, 6);
    assert.ok(harness.sent.some(function(m) {return m[0] === "job";}));
    assert.ok(harness.sent.some(function(m) {return m[2] === "weather";}));
    assert.ok(harness.sent.some(function(m) {return m[2] === "codex-status" && m[8] === "-1";}));
    ["timer.finished", "reminder.acknowledged", "stopwatch.reset"].forEach(function(action) {
      harness.handlers.appmessage({ payload: { 0: "capability_event", 9: action } });
    });
    assert.strictEqual(requests, 0);
    harness.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ endpoint: "https://agent.test" })) });
    assert.ok(harness.sent.every(function(message) { return message[Watch.Key.messageType] === "notes" || message[Watch.Key.messageType] === "bridge" || message[Watch.Key.messageType] === "job"; }));
  } finally { harness.cleanup(); }
});

require("./local-dictation")(test);
require("./jobs")(test);

test("Local dictation bypasses Codex and gives concurrent timers distinct delivery IDs", function() {
  var requests = 0;
  function FakeXHR() { requests += 1; }
  var storage = {};
  storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test" });
  var harness = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  try {
    ["set a timer for 10 seconds", "set a timer for 60 seconds", "set an alarm in 2 minutes"]
      .forEach(function(text) { harness.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: text } }); });
    assert.strictEqual(requests, 0);
    var messages = harness.sent.filter(function(m) { return m[Watch.Key.messageType] === "capability"; });
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(harness.sent.filter(function(m) { return m[Watch.Key.messageType] === "answer" && m[Watch.Key.operation] === "complete"; }).length, 3);
    assert.strictEqual(messages[0][Watch.Key.meta], "duration=10s");
    assert.strictEqual(messages[1][Watch.Key.meta], "duration=60s");
    assert.strictEqual(messages[2][Watch.Key.meta], "in=120s");
    assert.ok(messages[0][Watch.Key.index] < messages[1][Watch.Key.index]);
    assert.ok(messages[1][Watch.Key.index] < messages[2][Watch.Key.index]);
    assert.ok(harness.sent.every(function(m) { return m[Watch.Key.operation] !== "loading"; }));
  } finally { harness.cleanup(); }
});

test("Local commands leave earlier agent jobs running and unmatched dictation falls back unchanged", function() {
  var requests = [], aborted = 0;
  function FakeXHR() { this.responseText = ""; requests.push(this); }
  FakeXHR.prototype.open = function() {};
  FakeXHR.prototype.setRequestHeader = function() {};
  FakeXHR.prototype.send = function(body) { this.body = body; };
  FakeXHR.prototype.abort = function() { aborted += 1; };
  var storage = {};
  storage[Settings.STORAGE_KEY] = JSON.stringify({ endpoint: "https://agent.test" });
  var harness = loadPkjsHarness({ storageData: storage, XMLHttpRequest: FakeXHR });
  function dictate(text) { harness.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: text } }); }
  try {
    var unmatched = "Set a timer for five minutes and tell me a joke.";
    dictate(unmatched);
    assert.strictEqual(parse(requests[0].body)[2].attrs.text, unmatched);
    dictate("set a timer for 10 seconds");
    assert.strictEqual(aborted, 0);
    var count = harness.sent.length;
    requests[0].responseText = "pam version=1\ncapability type=timer command=start duration=5m\ndone\n";
    jobReply(harness, requests[0], requests[0].responseText, "done", false);
    assert.ok(harness.sent.slice(count).every(function(m) { return m[0] === "job"; }));
    dictate("set an alarm for seven");
    assert.strictEqual(requests.length, 2);
    requests[1].status = 200; requests[1].readyState = 4;
    requests[1].responseText = "pam version=1\nscreen id=clarify layout=list title=Clarify\ndone\n";
    jobReply(harness, requests[1], requests[1].responseText);
  } finally { harness.cleanup(); }
});

test("Local commands work with no configured endpoint", function() {
  var harness = loadPkjsHarness();
  try {
    harness.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: "start a five minute timer" } });
    var commands = harness.sent.filter(function(m) { return m[Watch.Key.messageType] === "capability"; });
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0][Watch.Key.meta], "duration=300s");
    assert.strictEqual(harness.sent[harness.sent.length - 1][Watch.Key.operation], "complete");
  } finally { harness.cleanup(); }
});

test("backend preferences persist and reach Codex separately from dictated text", function() {
  var normalized = Settings.normalize({ codexModel: "test-model", codexEffort: "high", webSearch: "live", fileAccess: "workspace-write", shellAccess: true, networkAccess: true, autoReview: true });
  assert.strictEqual(normalized.autoReview, true);
  assert.strictEqual(Settings.normalize({}).codexModel, "gpt-5.6-luna");
  assert.strictEqual(Settings.normalize({}).codexEffort, "xhigh");
  assert.strictEqual(Settings.normalize({}).fastMode, true);
  assert.strictEqual(Settings.normalize({}).webSearch, "live");
  assert.strictEqual(Settings.normalize({fastMode:false}).fastMode, false);
  assert.strictEqual(Settings.normalize({webSearch:"disabled"}).webSearch, "disabled");
  var invalid = Settings.normalize({ webSearch: "bogus", fileAccess: "full", networkAccess: "true", shellAccess: "false", autoReview: "true", codexModel: "bad model" });
  assert.strictEqual(invalid.webSearch, "disabled"); assert.strictEqual(invalid.fileAccess, "none");
  assert.strictEqual(invalid.autoReview, false); assert.strictEqual(invalid.networkAccess, false); assert.strictEqual(invalid.codexModel, "");
  var xhr;
  function XHR() { xhr = this; this.responseText = ""; }
  XHR.prototype.open = function() {}; XHR.prototype.setRequestHeader = function() {};
  XHR.prototype.send = function(body) { this.body = body; }; XHR.prototype.abort = function() {};
  normalized.endpoint = "https://agent.test";
  var storage = {}; storage[Settings.STORAGE_KEY] = JSON.stringify(normalized);
  var h = loadPkjsHarness({ storageData: storage, XMLHttpRequest: XHR });
  try {
    h.handlers.appmessage({ payload: { 0: "input", 2: "dictation", 8: "explain gravity" } });
    var backend = parse(xhr.body).filter(function(n) { return n.kind === "backend"; })[0];
    assert.deepStrictEqual(Object.assign({}, backend.attrs), { model: "test-model", effort: "high", fast_mode: "true", web_search: "live", file_access: "workspace-write", network_access: "true", shell_access: "true", auto_review: "true" });
    jobReply(h, xhr, "pam version=1\nscreen id=answer layout=card\ndone\n");
  } finally { h.cleanup(); }
});

test("phone configuration fetches model choices before opening HTTPS settings", function() {
  var xhr;
  function XHR() { xhr = this; this.headers = {}; }
  XHR.prototype.open = function(method,url) { this.url=url; };
  XHR.prototype.setRequestHeader = function(k,v) {this.headers[k]=v;};
  XHR.prototype.send = function() {};
  var storage = {}; storage[Settings.STORAGE_KEY] = JSON.stringify({endpoint:"ws://local.test:8787/bar/baz/biz/v1/agent",token:"secret"});
  var h = loadPkjsHarness({storageData:storage,XMLHttpRequest:XHR});
  try {
    h.handlers.showConfiguration();
    assert.strictEqual(xhr.url,"http://local.test:8787/bar/baz/biz/v1/models");
    assert.strictEqual(xhr.headers.Authorization,"Bearer secret");
    xhr.status=200; xhr.responseText=JSON.stringify({models:[{model:"example",supportedReasoningEfforts:[]}],defaultModel:"example",defaultEffort:"low"});xhr.onload();
    var state=JSON.parse(decodeURIComponent(h.opened[0].split("#")[1]));
    assert.strictEqual(state.codexCatalog.models[0].model,"example");
    assert.strictEqual(Settings.normalize(state).codexCatalog,undefined);
    xhr.onerror(); assert.strictEqual(h.opened.length,1);
    h.handlers.showConfiguration();xhr.ontimeout();
    assert.strictEqual(h.opened.length,2);
  } finally {h.cleanup();}
});

require("./endpoints")(test);

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
