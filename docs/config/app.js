(function() {
  "use strict";

  var defaults = {
    endpoint: "",
    token: "",
    units: "auto",
    locationLabel: "Current location",
    timeoutSeconds: 45
  };
  var form = document.getElementById("settings");
  var endpoint = document.getElementById("endpoint");
  var token = document.getElementById("token");
  var units = document.getElementById("units");
  var timeout = document.getElementById("timeout");
  var locationLabel = document.getElementById("location-label");
  var status = document.getElementById("status");

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
    status.textContent = "Saved. Returning to Pebble…";
    closeWith(settings);
  });
}());

