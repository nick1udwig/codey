(function(root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.CodeyEndpoints = factory(); }
}(this, function() {
  "use strict";

  // Shared by PebbleKit JS and the settings page; no browser URL dependency.
  function normalize(value) {
    var url = String(value || "").trim();
    if (!url) { return ""; }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { url = "https://" + url; }
    var match = /^(https?|wss?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(url);
    if (!match || /[\s\\@]/.test(url)) { return null; }
    var authority = match[2];
    var host = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(authority);
    if (!host || (host[2] && (Number(host[2]) < 1 || Number(host[2]) > 65535))) { return null; }
    var path = (match[3] || "").replace(/\/+$/, "");
    // Dot segments would be rewritten by HTTP clients, changing the base path.
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(path.replace(/%2e/ig, ".")) || /%(?![0-9a-f]{2})/i.test(path)) { return null; }
    return match[1].toLowerCase() + "://" + authority.toLowerCase() + path;
  }

  function api(value, resource) {
    var url = normalize(value);
    if (!url) { return ""; }
    // Accept the original complete agent URL as well as a base URL.
    url = url.replace(/\/v1\/agent$/, "");
    if (resource !== "agent") { url = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"); }
    return url + "/v1/" + resource;
  }

  return { normalize: normalize, api: api };
}));
