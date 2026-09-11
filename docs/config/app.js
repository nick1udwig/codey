(function() {
  "use strict";

  var defaults = {
    endpoint: "",
    token: "",
    units: "auto",
    locationLabel: "Current location",
    timeoutSeconds: 45,
    codexModel: "gpt-5.6-luna", codexEffort: "xhigh", fastMode: true, webSearch: "live", fileAccess: "none",
    networkAccess: false, shellAccess: false, autoReview: false
  };
  var form = document.getElementById("settings");
  var endpoint = document.getElementById("endpoint");
  var token = document.getElementById("token");
  var units = document.getElementById("units");
  var timeout = document.getElementById("timeout");
  var locationLabel = document.getElementById("location-label");
  var status = document.getElementById("status");

  var extraFields = {
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
  endpoint.value = current.endpoint || "";
  token.value = current.token || "";
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
    catalog = result; catalogEndpoint = requestedEndpoint;
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
    var url;
    try {
      url = new URL(endpoint.value.trim().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:"));
      if (url.protocol !== "http:" && url.protocol !== "https:") { throw new Error("Unsupported endpoint"); }
      if (url.username || url.password) { throw new Error("Use the bearer token field for authentication"); }
      url.pathname = "/v1/models"; url.search = ""; url.hash = "";
    } catch (_) { modelStatus.textContent = "Enter a valid agent endpoint first."; return; }
    var generation = ++discoveryGeneration;
    var requestedEndpoint = endpoint.value.trim();
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url.toString(), true);
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

  form.addEventListener("submit", function(event) {
    var settings;
    event.preventDefault();
    settings = {
      endpoint: endpoint.value.trim(),
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
    closeWith(settings);
  });
}());

