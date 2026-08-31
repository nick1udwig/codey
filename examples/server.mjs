import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { Parser } = require("../src/common/pam");
const { Writer } = require("../src/common/writer");

const host = process.env.AGENT_DEMO_HOST || "127.0.0.1";
const port = Number(process.env.AGENT_DEMO_PORT || 8787);

export function readInput(source) {
  let input = { kind: "event", text: "", action: "" };
  const parser = new Parser({
    onNode(node) {
      if (node.kind === "input") input = { ...input, ...node.attrs };
    }
  });
  parser.push(source);
  parser.finish();
  return input;
}

export function durationFrom(text) {
  const match = text.match(/(\d+)\s*(second|minute|hour)s?/i);
  if (!match) return "5m";
  return match[1] + ({ second: "s", minute: "m", hour: "h" })[match[2].toLowerCase()];
}

export function responseFor(input) {
  const writer = new Writer();
  const prompt = input.text || input.action || "Hello";

  if (/timer/i.test(prompt)) {
    writer.capability("timer", "start", {
      id: "timer",
      title: "Timer",
      duration: durationFrom(prompt)
    });
  } else if (/stopwatch/i.test(prompt)) {
    writer.capability("stopwatch", "start", { id: "stopwatch", title: "Stopwatch" });
  } else if (/weather/i.test(prompt)) {
    writer.capability("weather", "current", {
      id: "weather",
      location: "Current location"
    });
  } else if (/remind/i.test(prompt)) {
    writer.capability("reminder", "schedule", {
      id: "demo-reminder",
      title: "Demo reminder",
      subtitle: prompt,
      in: durationFrom(prompt)
    });
  } else {
    writer.beginScreen("answer", "card", { title: "Agent", status: true })
      .text({ id: "answer-text", value: `You said: ${prompt}` })
      .section({ id: "ideas", title: "Try asking" })
      .item({ id: "timer-idea", title: "A five minute timer", action: "suggest.timer" })
      .item({ id: "weather-idea", title: "The weather", action: "suggest.weather" })
      .item({ id: "stopwatch-idea", title: "Start a stopwatch", action: "suggest.stopwatch" })
      .endScreen();
  }
  return writer.lines;
}

export function createDemoServer(options = {}) {
  const lineDelay = options.lineDelay == null ? 90 : options.lineDelay;
  return http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("POST PAM requests only\n");
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      let lines;
      try {
        lines = responseFor(readInput(body));
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(`pam version=1\nerror message=${JSON.stringify(error.message)}\n`);
        return;
      }

      response.writeHead(200, {
        "content-type": "text/x-pebble-agent-markup; version=1; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      let index = 0;
      const interval = setInterval(() => {
        if (index >= lines.length) {
          clearInterval(interval);
          response.end();
          return;
        }
        response.write(lines[index++]);
      }, lineDelay);
      response.on("close", () => clearInterval(interval));
    });
  });
}

export function startDemoServer(options = {}) {
  const server = createDemoServer(options);
  const listenHost = options.host || host;
  const listenPort = options.port == null ? port : options.port;
  server.listen(listenPort, listenHost, () => {
    const address = server.address();
    console.log(`PAM demo agent listening on http://${listenHost}:${address.port}`);
  });
  return server;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  startDemoServer();
}
