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
    touch: device.touch ? "true" : "false",
    now: device.now == null ? "" : device.now,
    utc_offset_minutes: device.utc_offset_minutes == null ? "" : device.utc_offset_minutes
  }, 1);
  if (request.backend) {
    output += line("backend", request.backend, 1);
  }
  if (request.settings) {
    output += line("settings", request.settings, 1);
  }
  if (request.token && /^wss?:/i.test(request.endpoint || "")) {
    output += line("auth", { bearer: request.token }, 1);
  }
  output += "done\n";
  return output;
}

module.exports = buildRequest;
