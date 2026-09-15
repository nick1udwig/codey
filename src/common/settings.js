"use strict";

var Endpoints = require("./endpoints");

var STORAGE_KEY = "pebble-agent.settings.v1";
var CONFIG_URL = "https://nick1udwig.github.io/pebble-agent/config/";

var DEFAULTS = Object.freeze({
  endpoint: "",
  todoSyncProvider: "server",
  noteSyncProvider: "server",
  collectionDevelopmentHTTP: false,
  token: "",
  units: "auto",
  locationLabel: "Current location",
  timeoutSeconds: 45,
  codexModel: "gpt-5.6-luna",
  codexEffort: "xhigh",
  webSearch: "live",
  fastMode: true,
  fileAccess: "none",
  networkAccess: false,
  shellAccess: false,
  autoReview: false,
  tapAnimation: true,
  answerVibrate: true
});

function copyDefaults(value) {
  var settings = {};
  var source = value || {};
  Object.keys(DEFAULTS).forEach(function(key) {
    settings[key] = source[key] == null ? DEFAULTS[key] : source[key];
  });
  settings.endpoint = Endpoints.normalize(settings.endpoint) || "";
  settings.collectionDevelopmentHTTP = source.collectionDevelopmentHTTP === true;
  settings.todoSyncProvider = ["server", "todoist", "googletasks"].indexOf(source.todoSyncProvider)>=0?source.todoSyncProvider:"server";
  settings.noteSyncProvider = ["server", "nextcloudnotes"].indexOf(source.noteSyncProvider)>=0?source.noteSyncProvider:"server";
  settings.token = String(settings.token || "").trim();
  settings.units = settings.units === "imperial" || settings.units === "metric" ? settings.units : "auto";
  settings.locationLabel = String(settings.locationLabel || DEFAULTS.locationLabel).slice(0, 64);
  settings.timeoutSeconds = Math.max(10, Math.min(120, parseInt(settings.timeoutSeconds, 10) || 45));
  ["codexModel", "codexEffort"].forEach(function(key) {
    var value = String(settings[key] || "").trim();
    settings[key] = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : "";
  });
  settings.webSearch = ["cached", "live"].indexOf(settings.webSearch) >= 0 ? settings.webSearch : "disabled";
  settings.fileAccess = ["read-only", "workspace-write"].indexOf(settings.fileAccess) >= 0 ? settings.fileAccess : "none";
  ["networkAccess", "shellAccess", "autoReview", "fastMode", "answerVibrate", "tapAnimation"].forEach(function(key) {
    settings[key] = settings[key] === true;
  });
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

function buildConfigUrl(settings, nonce, catalog, error, setup) {
  var normalized = copyDefaults(settings);
  if (catalog) { normalized.codexCatalog = catalog; }
  if (error) { normalized.managementError = String(error).slice(0, 500); }
  if(setup) { normalized.integrationSetup=setup; }
  normalized.tokenConfigured = !!normalized.token;
  normalized.token = "";
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
    var source = JSON.parse(decoded);
    var normalized = copyDefaults(source);
    // Preserve the action only while handling this submission. save() and
    // buildConfigUrl() strip it because it is not a persistent preference.
    if (source && source.recoverCollections === true) normalized.recoverCollections=true;
    if (source && source.newSession === true) { normalized.newSession = true; }
    return normalized;
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
