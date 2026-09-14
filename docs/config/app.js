(function() {
  "use strict";

  var Endpoints = window.CodeyEndpoints;
  var defaults = {
    todoSyncProvider:"server", noteSyncProvider:"server",
    endpoint: "",
    collectionDevelopmentHTTP:false,
    token: "",
    units: "auto",
    locationLabel: "Current location",
    timeoutSeconds: 45,
    codexModel: "gpt-5.6-luna", codexEffort: "xhigh", fastMode: true, webSearch: "live", fileAccess: "none",
    networkAccess: false, shellAccess: false, autoReview: false, answerVibrate: true, tapAnimation: true
  };
  var form = document.getElementById("settings");
  var endpoint = document.getElementById("endpoint");
  var token = document.getElementById("token");
  var units = document.getElementById("units");
  var timeout = document.getElementById("timeout");
  var locationLabel = document.getElementById("location-label");
  var status = document.getElementById("status");

  var extraFields = {
    todoSyncProvider:document.getElementById("todo-sync-provider"),
    noteSyncProvider:document.getElementById("note-sync-provider"),
    collectionDevelopmentHTTP:document.getElementById("collection-development-http"),
    tapAnimation: document.getElementById("tap-animation"),
    answerVibrate: document.getElementById("answer-vibrate"),
    codexModel: document.getElementById("codex-model"),
    codexEffort: document.getElementById("codex-effort"),
    fastMode: document.getElementById("fast-mode"),
    webSearch: document.getElementById("web-search"),
    fileAccess: document.getElementById("file-access"),
    networkAccess: document.getElementById("network-access"),
    shellAccess: document.getElementById("shell-access"),
    autoReview: document.getElementById("auto-review")
  };
  var modelStatus = document.getElementById("model-status");
  var catalog = null;
  var catalogEndpoint = "";
  var discoveryGeneration = 0;

  function stateFromHash() {
    if (!window.location.hash || window.location.hash.length < 2) {
      return defaults;
    }
    try {
      return Object.assign({}, defaults, JSON.parse(decodeURIComponent(window.location.hash.slice(1))));
    } catch (_) {
      return defaults;
    }
  }

  function closeWith(settings) {
    var closeUrl = "pebblejs://close#" + encodeURIComponent(JSON.stringify(settings));
    if (window.PebbleConfigBridge && typeof window.PebbleConfigBridge.submit === "function") {
      window.PebbleConfigBridge.submit(settings);
      return;
    }
    try { window.location.href = closeUrl; } catch (_) {}
    try { document.location = closeUrl; } catch (_) {}
  }

  var current = stateFromHash();
  if(current.managementError) { status.textContent="Settings saved. Could not open sync services: "+current.managementError; }
  // A one-time action: never restore it from saved settings or URL state.
  var newSession = document.getElementById("new-session");
  newSession.checked = false;
  endpoint.value = current.endpoint || "";
  token.value = "";
  token.placeholder=current.tokenConfigured?"Token saved — leave blank to keep":"Bearer token";
  document.getElementById("token-status").textContent=current.tokenConfigured?"A bearer token is saved on your phone. Leave this field blank to keep it.":"Enter your server bearer token. After saving, this field is blank so the token is not exposed in the settings URL.";
  units.value = current.units || "auto";
  timeout.value = String(current.timeoutSeconds || 45);
  locationLabel.value = current.locationLabel || defaults.locationLabel;

  Object.keys(extraFields).forEach(function(key) {
    if (typeof defaults[key] === "boolean") { extraFields[key].checked = current[key] === true; }
    else { extraFields[key].value = current[key] == null ? defaults[key] : current[key]; }
  });

  function selectedModel() {
    var model = extraFields.codexModel.value.trim() || (catalog && catalog.defaultModel);
    return catalog && catalog.models.filter(function(entry) { return entry.model === model; })[0];
  }

  function updateEfforts() {
    var model = selectedModel();
    if (!model) { return; }
    var select = extraFields.codexEffort;
    var previous = select.value;
    select.textContent = "";
    var entries = [{ reasoningEffort: "", description: "Default" }].concat(model.supportedReasoningEfforts);
    entries.forEach(function(entry) {
      var option = document.createElement("option");
      option.value = entry.reasoningEffort;
      option.textContent = entry.reasoningEffort ? entry.reasoningEffort + " — " + entry.description : "Default";
      select.appendChild(option);
    });
    select.value = entries.some(function(entry) { return entry.reasoningEffort === previous; }) ? previous : "";
  }
  function applyCatalog(result, requestedEndpoint) {
    catalog = result; catalogEndpoint = Endpoints.normalize(requestedEndpoint);
    var list = document.getElementById("codex-models"); list.textContent = "";
    catalog.models.forEach(function(model) {
      var option = document.createElement("option"); option.value = model.model;
      option.textContent = model.displayName || model.model; list.appendChild(option);
    });
    updateEfforts();
    modelStatus.textContent = "Server default: " + catalog.defaultModel + " / " + catalog.defaultEffort + ". Select a model or leave blank.";
  }
  if (current.codexCatalog && Array.isArray(current.codexCatalog.models) &&
      current.codexCatalog.models.every(function(m) { return typeof m.model === "string" && Array.isArray(m.supportedReasoningEfforts); })) {
    applyCatalog(current.codexCatalog, current.endpoint);
  }
  extraFields.codexModel.addEventListener("change", updateEfforts);
  function invalidateCatalog() {
    discoveryGeneration += 1;
    catalog = null;
    document.getElementById("codex-models").textContent = "";
    modelStatus.textContent = "Load models for this endpoint before choosing a model.";
  }
  endpoint.addEventListener("input", invalidateCatalog);
  token.addEventListener("input", invalidateCatalog);
  document.getElementById("load-models").addEventListener("click", function() {
    var url = Endpoints.api(endpoint.value, "models");
    if (!url) { modelStatus.textContent = "Enter a valid server URL first."; return; }
    var generation = ++discoveryGeneration;
    var requestedEndpoint = Endpoints.normalize(endpoint.value);
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 15000;
    if (token.value.trim()) { xhr.setRequestHeader("Authorization", "Bearer " + token.value.trim()); }
    modelStatus.textContent = "Loading available models…";
    xhr.onload = function() {
      if (generation !== discoveryGeneration) { return; }
      if (xhr.status !== 200) { modelStatus.textContent = "Could not load models. Check the connection, token, and server version."; return; }
      try {
        var result = JSON.parse(xhr.responseText);
        if (!Array.isArray(result.models) || !result.models.every(function(m) {
          return typeof m.model === "string" && Array.isArray(m.supportedReasoningEfforts);
        })) { throw new Error("Invalid catalog"); }
        applyCatalog(result, requestedEndpoint);
      } catch (_) { catalog = null; modelStatus.textContent = "The server returned an invalid model list."; }
    };
    xhr.onerror = xhr.ontimeout = function() {
      if (generation === discoveryGeneration) { modelStatus.textContent = "Could not reach the model list. Check the endpoint and connection."; }
    };
    xhr.send();
  });

  var manageCollection="";
  var syncHelp={server:"Stored on your codey server only. No external account is needed. To disconnect an existing backend, open setup and choose Use Server only; saving this preference alone does not disconnect it.",todoist:"Open To-do setup, enter your Todoist API token, and connect. Choose a project, preview it, then activate. Existing server tasks are exported only if you select that option.",googletasks:"First configure a Google OAuth client in ~/.codey/integrations.json; see the README link below for the exact fields and callback. Restart codey, open To-do setup, sign in to Google, choose a task list, preview, and activate.",nextcloudnotes:"Open Notes setup and enter your Nextcloud HTTPS base URL, username, and app password. Choose a category, preview it, then activate. Private Nextcloud hosts must also be allowed in ~/.codey/integrations.json; see the README."};
  function updateSyncHelp(){
    document.getElementById("todo-sync-help").textContent=syncHelp[extraFields.todoSyncProvider.value]||syncHelp.server;
    document.getElementById("note-sync-help").textContent=syncHelp[extraFields.noteSyncProvider.value]||syncHelp.server;
  }
  extraFields.todoSyncProvider.addEventListener("change",updateSyncHelp);
  extraFields.noteSyncProvider.addEventListener("change",updateSyncHelp);
  updateSyncHelp();
  document.getElementById("manage-todos").addEventListener("click",function(){manageCollection="task";form.requestSubmit();});
  document.getElementById("manage-notes").addEventListener("click",function(){manageCollection="note";form.requestSubmit();});
  form.addEventListener("submit", function(event) {
    var settings;
    event.preventDefault();
    var normalizedEndpoint = Endpoints.normalize(endpoint.value);
    if (normalizedEndpoint === null) {
      status.textContent = "Enter a server URL without credentials, a query, or a fragment.";
      return;
    }
    settings = {
      endpoint: normalizedEndpoint,
      token: token.value.trim(),
      units: units.value,
      locationLabel: locationLabel.value.trim() || defaults.locationLabel,
      timeoutSeconds: parseInt(timeout.value, 10) || 45
    };
    Object.keys(extraFields).forEach(function(key) {
      settings[key] = typeof defaults[key] === "boolean" ? extraFields[key].checked : extraFields[key].value.trim();
    });
    if (catalog && catalogEndpoint === settings.endpoint && settings.codexModel && !selectedModel()) {
      status.textContent = "Choose a model available from this server."; return;
    }
    status.textContent = "Saved. Returning to Pebble…";
    if (newSession.checked) { settings.newSession = true; }
    if(document.getElementById("recover-collections").checked)settings.recoverCollections=true;
    if(manageCollection)settings.manageCollection=manageCollection;
    manageCollection="";
    closeWith(settings);
  });
}());
