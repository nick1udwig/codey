import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
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

function runConfig(hash, bridge) {
  const ids = ["settings", "endpoint", "token", "units", "timeout", "location-label", "status"];
  const elements = {};
  let submit;
  ids.forEach(id => {
    elements[id] = {
      value: "",
      textContent: "",
      addEventListener(name, handler) {
        if (id === "settings" && name === "submit") submit = handler;
      }
    };
  });
  const location = { hash, href: "https://config.test/" + hash };
  const document = {
    location: location.href,
    getElementById(id) { return elements[id]; }
  };
  const window = { location };
  if (bridge) window.PebbleConfigBridge = bridge;
  vm.runInNewContext(configScript, {
    window,
    document,
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
  assert.equal(harness.elements.token.value, initial.token);
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
    token: "secret",
    units: "metric",
    locationLabel: "Current location",
    timeoutSeconds: 90
  });
});

test("configuration page recovers from a bad hash and supports the native bridge", () => {
  let submitted;
  const harness = runConfig("#%not-json", { submit(settings) { submitted = settings; } });
  assert.equal(harness.elements.endpoint.value, "");
  assert.equal(harness.elements.units.value, "auto");
  assert.equal(harness.elements.timeout.value, "45");
  assert.equal(harness.elements["location-label"].value, "Current location");
  harness.elements.endpoint.value = "wss://agent.test/socket";
  harness.elements.units.value = "auto";
  harness.elements.timeout.value = "30";
  harness.submit({ preventDefault() {} });
  assert.equal(submitted.endpoint, "wss://agent.test/socket");
  assert.equal(submitted.timeoutSeconds, 30);
  assert.equal(harness.location.href, "https://config.test/#%not-json");
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
