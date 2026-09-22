"use strict";

var Endpoints = require("./endpoints");

var STORAGE_KEY = "pebble-agent.settings.v1";
var CONFIG_URL = "https://nick1udwig.github.io/codey/config/";

var DEFAULTS = Object.freeze({
  endpoint: "",
  todoSyncProvider: "server",
  noteSyncProvider: "server",
  calendarSyncProvider: "server",
  collectionDevelopmentHTTP: false,
  token: "",
  units: "auto",
  locationLabel: "Current location",
  timeoutSeconds: 45,
  codexModel: "gpt-6-luna",
  codexEffort: "xhigh",
  webSearch: "live",
  fastMode: true,
  fileAccess: "none",
  networkAccess: false,
  shellAccess: false,
  autoReview: false,
  tapAnimation: true,
  doubleTap: true,
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
  settings.calendarSyncProvider = ["server", "caldav"].indexOf(source.calendarSyncProvider)>=0?source.calendarSyncProvider:"server";
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
  ["networkAccess", "shellAccess", "autoReview", "fastMode", "answerVibrate", "tapAnimation", "doubleTap"].forEach(function(key) {
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

// Explicit settings phrases only; never let free-form model output change
// credentials or permissions through this path.
function parseDictation(input) {
  if (typeof input !== "string" || input.length > 256) { return null; }
  var text=input.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/^please /, "").replace(/^settings?\s*:\s*/, "");
  var toggles={"double tap":"doubleTap","double tap requirement":"doubleTap","ripple":"tapAnimation","tap animation":"tapAnimation","answer vibration":"answerVibrate","answer arrived vibration":"answerVibrate","fast mode":"fastMode"};
  var match=/^(?:turn|switch) (on|off) (.+)$/.exec(text) || /^(enable|disable) (.+)$/.exec(text);
  var key,value,label;
  if(match && toggles[match[2]]) { key=toggles[match[2]];value=match[1]==="on"||match[1]==="enable";label=match[2]+": "+(value?"on":"off"); }
  else {
    match=/^(?:set|change) (.+?) (?:to )?([^ ]+)$/.exec(text);
    if(!match) { return null; }
    var choices={"weather units":["units",["auto","automatic","metric","imperial"]],"units":["units",["auto","automatic","metric","imperial"]],"reasoning effort":["codexEffort",["default","low","medium","high","xhigh","max","ultra"]],"web search":["webSearch",["off","disabled","cached","live"]]};
    var choice=choices[match[1]];
    if(choice && choice[1].indexOf(match[2])>=0){key=choice[0];value=match[2];if(value==="automatic")value="auto";if(value==="default")value="";if(value==="off")value="disabled";}
    else if((match[1]==="model"||match[1]==="codex model") && /^(?:default|[a-z0-9][a-z0-9._:/-]{0,127})$/.test(match[2])) { key="codexModel";value=match[2]==="default"?"":match[2]; }
    else { return null; }
    label=match[1]+": "+match[2];
  }
  var patch={};patch[key]=value;
  return {patch:patch,label:label};
}

module.exports = {
  parseDictation: parseDictation,
  STORAGE_KEY: STORAGE_KEY,
  CONFIG_URL: CONFIG_URL,
  DEFAULTS: DEFAULTS,
  normalize: copyDefaults,
  load: load,
  save: save,
  buildConfigUrl: buildConfigUrl,
  parseConfigResponse: parseConfigResponse
};
