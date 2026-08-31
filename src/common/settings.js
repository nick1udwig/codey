"use strict";

var STORAGE_KEY = "pebble-agent.settings.v1";
var CONFIG_URL = "https://nick1udwig.github.io/pebble-agent/config/";

var DEFAULTS = Object.freeze({
  endpoint: "",
  token: "",
  units: "auto",
  locationLabel: "Current location",
  timeoutSeconds: 45
});

function copyDefaults(value) {
  var settings = {};
  var source = value || {};
  Object.keys(DEFAULTS).forEach(function(key) {
    settings[key] = source[key] == null ? DEFAULTS[key] : source[key];
  });
  settings.endpoint = String(settings.endpoint || "").trim();
  settings.token = String(settings.token || "").trim();
  settings.units = settings.units === "imperial" || settings.units === "metric" ? settings.units : "auto";
  settings.locationLabel = String(settings.locationLabel || DEFAULTS.locationLabel).slice(0, 64);
  settings.timeoutSeconds = Math.max(10, Math.min(120, parseInt(settings.timeoutSeconds, 10) || 45));
  return settings;
}

function load(storage) {
  var raw;
  storage = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!storage) {
    return copyDefaults();
  }
  try {
    raw = storage.getItem(STORAGE_KEY);
    return copyDefaults(raw ? JSON.parse(raw) : null);
  } catch (error) {
    return copyDefaults();
  }
}

function save(settings, storage) {
  var normalized = copyDefaults(settings);
  storage = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (storage) {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function buildConfigUrl(settings, nonce) {
  var normalized = copyDefaults(settings);
  var state = encodeURIComponent(JSON.stringify(normalized));
  return CONFIG_URL + "?v=" + encodeURIComponent(String(nonce || Date.now())) + "#" + state;
}

function parseConfigResponse(response) {
  var decoded;
  if (!response || response === "CANCELLED") {
    return null;
  }
  try {
    decoded = decodeURIComponent(response);
    return copyDefaults(JSON.parse(decoded));
  } catch (error) {
    return null;
  }
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  CONFIG_URL: CONFIG_URL,
  DEFAULTS: DEFAULTS,
  normalize: copyDefaults,
  load: load,
  save: save,
  buildConfigUrl: buildConfigUrl,
  parseConfigResponse: parseConfigResponse
};

