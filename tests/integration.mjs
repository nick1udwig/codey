import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  createDemoServer,
  durationFrom,
  readInput,
  responseFor
} from "../examples/server.mjs";

const require = createRequire(import.meta.url);
const { Parser } = require("../src/common/pam");
const configScript = fs.readFileSync(new URL("../docs/config/app.js", import.meta.url), "utf8");
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function parsePam(source) {
  const nodes = [];
  const parser = new Parser({ onNode: node => nodes.push(node) });
  parser.push(source);
  parser.finish();
  return nodes;
}

function request(port, { method = "POST", body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    const chunkTimes = [];
    const client = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: "/respond",
      headers: body ? {
        "content-type": "text/x-pebble-agent-markup; version=1; charset=utf-8",
        "content-length": Buffer.byteLength(body)
      } : undefined
    }, response => {
      response.setEncoding("utf8");
      response.on("data", chunk => {
        chunks.push(chunk);
        chunkTimes.push(Date.now() - started);
      });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        chunks,
        chunkTimes,
        body: chunks.join(""),
        elapsed: Date.now() - started
      }));
    });
    client.on("error", reject);
    client.end(body);
  });
}

function runConfig(hash, bridge, XHR) {
  const ids = ["settings", "endpoint", "token", "units", "timeout", "location-label", "status", "codex-model", "codex-effort", "fast-mode", "codex-models", "load-models", "model-status", "web-search", "file-access", "network-access", "shell-access", "auto-review", "answer-vibrate", "tap-animation"];
  const elements = {};
  ids.push("token-status","new-session","collection-development-http","manage-integrations","recover-collections");
  let submit;
  ids.forEach(id => {
    elements[id] = {
      value: "",
      checked: false,
      children: [],
      handlers: {},
      appendChild(child) { this.children.push(child); },
      textContent: "",
      addEventListener(name, handler) {
        this.handlers[name] = handler;
        if (id === "settings" && name === "submit") submit = handler;
      }
    };
  });
  const location = { hash, href: "https://config.test/" + hash };
  const document = {
    location: location.href,
    getElementById(id) { return elements[id]; },
    createElement() { return { value: "", textContent: "" }; }
  };
  const window = { location };
  if (bridge) window.PebbleConfigBridge = bridge;
  vm.runInNewContext(fs.readFileSync(new URL("../src/common/endpoints.js", import.meta.url), "utf8"), window);
  vm.runInNewContext(configScript, {
    window,
    document,
    URL,
    XMLHttpRequest: XHR,
    JSON,
    Object,
    String,
    parseInt,
    encodeURIComponent,
    decodeURIComponent
  }, { filename: "docs/config/app.js" });
  return { document, elements, location, submit };
}

test("demo fixture parses input and covers every built-in route", () => {
  const input = readInput([
    "pam version=1\n",
    "request id=8 protocol=pam/1 session=test\n",
    "  input kind=dictation text=\"set a 12 second timer\" action= value=\n",
    "done\n"
  ].join(""));
  assert.equal(input.kind, "dictation");
  assert.equal(input.text, "set a 12 second timer");
  assert.equal(durationFrom(input.text), "12s");
  assert.equal(durationFrom("nothing specific"), "5m");

  const routes = [
    ["set a 12 second timer", "timer", "start", "duration", "12s"],
    ["start a stopwatch", "stopwatch", "start"],
    ["show the weather", "weather", "current"],
    ["remind me in 3 hours", "reminder", "schedule", "in", "3h"]
  ];
  routes.forEach(([text, type, command, key, value]) => {
    const nodes = parsePam(responseFor({ text }).join(""));
    const capability = nodes.find(node => node.kind === "capability");
    assert.ok(capability, text);
    assert.equal(capability.attrs.type, type);
    assert.equal(capability.attrs.command, command);
    if (key) assert.equal(capability.attrs[key], value);
  });

  const card = parsePam(responseFor({ text: "hello watch" }).join(""));
  assert.equal(card[1].kind, "screen");
  assert.equal(card[1].attrs.layout, "card");
  assert.ok(card.some(node => node.kind === "item" && node.attrs.action === "suggest.timer"));
  assert.equal(card.at(-1).kind, "done");
});

test("demo HTTP endpoint streams valid PAM before the response ends", async () => {
  const lineDelay = 20;
  const server = createDemoServer({ lineDelay });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const result = await request(port, {
      body: [
        "pam version=1\n",
        "request id=9 protocol=pam/1 session=integration\n",
        "  input kind=dictation text=\"hello integration\" action= value=\n",
        "done\n"
      ].join("")
    });
    assert.equal(result.status, 200);
    assert.match(result.headers["content-type"], /^text\/x-pebble-agent-markup; version=1/);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.ok(result.chunks.length >= 3, `expected streamed chunks, got ${result.chunks.length}`);
    assert.ok(result.elapsed - result.chunkTimes[0] >= lineDelay * 2,
      "the first rendered bytes should arrive before the complete response");
    const nodes = parsePam(result.body);
    assert.equal(nodes[1].kind, "screen");
    assert.equal(nodes.at(-1).kind, "done");

    const wrongMethod = await request(port, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.body, /POST PAM requests only/);

    const malformed = await request(port, { body: "pam version=1\n   bad value=yes\n" });
    assert.equal(malformed.status, 400);
    const errorNodes = parsePam(malformed.body);
    assert.equal(errorNodes[1].kind, "error");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("configuration page hydrates state and closes with normalized form values", () => {
  const initial = {
    endpoint: "https://old.test/respond",
    token: "old-token",
    units: "imperial",
    locationLabel: "Seattle",
    timeoutSeconds: 60
  };
  const harness = runConfig("#" + encodeURIComponent(JSON.stringify(initial)));
  assert.equal(harness.elements.endpoint.value, initial.endpoint);
  assert.equal(harness.elements.token.value, "");
  assert.equal(harness.elements.units.value, "imperial");
  assert.equal(harness.elements.timeout.value, "60");
  assert.equal(harness.elements["location-label"].value, "Seattle");

  harness.elements.endpoint.value = "  https://new.test/agent  ";
  harness.elements.token.value = "  secret  ";
  harness.elements.units.value = "metric";
  harness.elements.timeout.value = "90";
  harness.elements["location-label"].value = "   ";
  let prevented = false;
  harness.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(harness.elements.status.textContent, /^Saved/);
  assert.match(harness.location.href, /^pebblejs:\/\/close#/);
  const saved = JSON.parse(decodeURIComponent(harness.location.href.split("#")[1]));
  assert.deepEqual(saved, {
    endpoint: "https://new.test/agent",
    collectionDevelopmentHTTP:false,
    token: "secret",
    units: "metric",
    locationLabel: "Current location",
    timeoutSeconds: 90,
    codexModel: "gpt-5.6-luna", codexEffort: "xhigh", fastMode: true, webSearch: "live", fileAccess: "none",
    networkAccess: false, shellAccess: false, autoReview: false, answerVibrate: true, tapAnimation: true
  });
});

test("configuration page recovers from a bad hash and supports the native bridge", () => {
  let submitted;
  const harness = runConfig("#%not-json", { submit(settings) { submitted = settings; } });
  assert.equal(harness.elements.endpoint.value, "");
  assert.equal(harness.elements.units.value, "auto");
  assert.equal(harness.elements.timeout.value, "45");
  assert.equal(harness.elements["codex-model"].value, "gpt-5.6-luna");
  assert.equal(harness.elements["codex-effort"].value, "xhigh");
  assert.equal(harness.elements["fast-mode"].checked, true);
  assert.equal(harness.elements["answer-vibrate"].checked, true);
  assert.equal(harness.elements["tap-animation"].checked, true);
  harness.elements["tap-animation"].checked = false;
  harness.elements["answer-vibrate"].checked = false;
  assert.equal(harness.elements["web-search"].value, "live");
  assert.equal(harness.elements["location-label"].value, "Current location");
  harness.elements.endpoint.value = "wss://agent.test/socket";
  harness.elements.units.value = "auto";
  harness.elements.timeout.value = "30";
  harness.submit({ preventDefault() {} });
  assert.equal(submitted.endpoint, "wss://agent.test/socket");
  assert.equal(submitted.timeoutSeconds, 30);
  assert.equal(submitted.answerVibrate, false);
  assert.equal(submitted.tapAnimation, false);
  assert.equal(harness.location.href, "https://config.test/#%not-json");
});

test("new conversation is an explicit one-time settings action", () => {
  let saved;
  const h = runConfig("#" + encodeURIComponent(JSON.stringify({ newSession: true })), { submit(s) { saved = s; } });
  assert.equal(h.elements["new-session"].checked, false);
  h.submit({ preventDefault() {} });
  assert.equal(saved.newSession, undefined);
  h.elements["new-session"].checked = true;
  h.submit({ preventDefault() {} });
  assert.equal(saved.newSession, true);
});

test("configuration round-trips Codex permissions and model choices", () => {
  const initial = { codexModel: "example", codexEffort: "high", fastMode: false, webSearch: "cached", fileAccess: "read-only", networkAccess: true, shellAccess: true, autoReview: true };
  let saved;
  const h = runConfig("#" + encodeURIComponent(JSON.stringify(initial)), { submit(s) { saved = s; } });
  assert.equal(h.elements["codex-model"].value, "example");
  assert.equal(h.elements["auto-review"].checked, true);
  h.elements["web-search"].value = "live";
  h.elements["network-access"].checked = false;
  h.submit({ preventDefault() {} });
  assert.equal(saved.codexModel, "example"); assert.equal(saved.codexEffort, "high"); assert.equal(saved.fastMode, false);
  assert.equal(saved.webSearch, "live"); assert.equal(saved.fileAccess, "read-only");
  assert.equal(saved.networkAccess, false); assert.equal(saved.shellAccess, true); assert.equal(saved.autoReview, true);
});

test("model discovery uses bearer auth and ignores stale endpoint responses", () => {
  const requests = [];
  function XHR() { this.headers = {}; requests.push(this); }
  XHR.prototype.open = function(method, url) { this.method = method; this.url = url; };
  XHR.prototype.setRequestHeader = function(k, v) { this.headers[k] = v; };
  XHR.prototype.send = function() {};
  const h = runConfig("#" + encodeURIComponent(JSON.stringify({ endpoint: "wss://agent.test/v1/agent", token: "secret", codexModel: "example", codexEffort: "ultra" })), null, XHR);
  h.elements.token.value="secret"; // A newly entered token, never restored from the URL.
  const load = () => h.elements["load-models"].handlers.click();
  const body = JSON.stringify({ defaultModel: "example", defaultEffort: "high", models: [{ model: "example", displayName: "Example", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Thorough" }] }] });
  load();
  assert.equal(requests[0].url, "https://agent.test/v1/models");
  assert.equal(requests[0].headers.Authorization, "Bearer secret");
  requests[0].status = 200; requests[0].responseText = body; requests[0].onload();
  assert.equal(h.elements["codex-effort"].value, "");
  assert.deepEqual(h.elements["codex-effort"].children.map(o => o.value), ["", "low", "high"]);
  load();
  h.elements.endpoint.value = "https://other.test"; h.elements.endpoint.handlers.input();
  requests[1].status = 200; requests[1].responseText = body; requests[1].onload();
  assert.match(h.elements["model-status"].textContent, /this endpoint/);
});

test("settings browser resolves nested bases and blocks invalid URLs before sending tokens", () => {
  const requests = [];
  function XHR() { this.headers = {}; requests.push(this); }
  XHR.prototype.open = function(method, url) { this.url = url; };
  XHR.prototype.setRequestHeader = function(k, v) { this.headers[k] = v; };
  XHR.prototype.send = function() {};
  for (const input of ["foo.com/bar/baz/biz", "https://foo.com/bar/baz/biz/", "wss://foo.com/bar/baz/biz/v1/agent/"]) {
    let saved;
    const h = runConfig("", { submit(value) { saved = value; } }, XHR);
    h.elements.endpoint.value = input;
    h.elements.token.value = "secret";
    h.elements["load-models"].handlers.click();
    assert.equal(requests.at(-1).url, "https://foo.com/bar/baz/biz/v1/models");
    assert.equal(requests.at(-1).headers.Authorization, "Bearer secret");
    h.submit({ preventDefault() {} });
    assert.equal(saved.endpoint, input === "foo.com/bar/baz/biz" ? "https://" + input : input.replace(/\/+$/, ""));
  }
  for (const input of ["ftp://foo.com", "https://user:pass@foo.com", "https://foo.com/codey?x=y", "https://foo.com/codey#x"]) {
    let saved;
    const h = runConfig("", { submit(value) { saved = value; } }, XHR);
    h.elements.endpoint.value = input;
    const count = requests.length;
    h.elements["load-models"].handlers.click();
    h.submit({ preventDefault() {} });
    assert.equal(requests.length, count);
    assert.equal(saved, undefined);
  }
});

test("built settings page includes and loads its shared endpoint helper", () => {
  execFileSync(process.execPath, ["scripts/build-settings-site.mjs"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const page = new URL("../build/settings-site/config/index.html", import.meta.url);
  const scripts = [...fs.readFileSync(page, "utf8").matchAll(/<script src="([^"]+)"/g)].map(match => new URL(match[1], page));
  assert.equal(scripts.length, 2);
  const browser = {};
  vm.runInNewContext(fs.readFileSync(scripts[0], "utf8"), browser);
  assert.equal(browser.CodeyEndpoints.api("foo.com/bar/baz/biz", "models"), "https://foo.com/bar/baz/biz/v1/models");
  assert.equal(fs.readFileSync(scripts[1], "utf8"), configScript);
});

let passed = 0;
for (const entry of tests) {
  try {
    await entry.run();
    passed += 1;
    process.stdout.write(`\u2713 ${entry.name}\n`);
  } catch (error) {
    process.stderr.write(`\u2717 ${entry.name}\n${error.stack || error}\n`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  process.stdout.write(`\n${passed} integration tests passed\n`);
}
