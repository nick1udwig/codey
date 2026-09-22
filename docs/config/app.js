(function() {
  "use strict";

  var Endpoints = window.CodeyEndpoints;
  var defaults = {
    todoSyncProvider:"server", noteSyncProvider:"server", calendarSyncProvider:"server",
    endpoint: "",
    collectionDevelopmentHTTP:false,
    token: "",
    units: "auto",
    locationLabel: "Current location",
    timeoutSeconds: 45,
    codexModel: "gpt-6-luna", codexEffort: "xhigh", fastMode: true, webSearch: "live", fileAccess: "none",
    networkAccess: false, shellAccess: false, autoReview: false, answerVibrate: true, tapAnimation: true, doubleTap:true
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
    calendarSyncProvider:document.getElementById("calendar-sync-provider"),
    collectionDevelopmentHTTP:document.getElementById("collection-development-http"),
    tapAnimation: document.getElementById("tap-animation"),
    doubleTap: document.getElementById("double-tap"),
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
  if(current.managementError) { status.textContent="Sync setup unavailable: "+current.managementError; }
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

  var setup=current.integrationSetup, setupState=null;
  // The setup credential is short lived and never saved with phone preferences.
  try{if(window.history&&window.history.replaceState)window.history.replaceState(null,"",window.location.href.split("#")[0]);}catch(_){}
  function setupRequest(values,done){
    var expected=Endpoints.api(endpoint.value,"integration-setup-sessions").replace(/\/v1\/integration-setup-sessions$/,"/integrations/setup-api");
    if(!setup||!setup.token){done(new Error(current.managementError||"Save your HTTPS server URL and bearer token, then reopen settings to connect sync services."));return;}
    if(expected!==setup.url||token.value.trim()){done(new Error("Save the changed server settings and reopen settings before connecting a backend."));return;}
    var xhr=new XMLHttpRequest();xhr.open(values?"POST":"GET",setup.url,true);xhr.timeout=30000;
    xhr.setRequestHeader("Authorization","Bearer "+setup.token);
    if(values)xhr.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
    xhr.onload=function(){var data;try{data=JSON.parse(xhr.responseText);}catch(_){done(new Error("Invalid setup response from server"));return;}if(xhr.status<200||xhr.status>=300){done(new Error(data.message||"Setup request failed"));return;}done(null,data);};
    xhr.onerror=xhr.ontimeout=function(){done(new Error("Cannot reach sync setup. Check the connection, then retry."));};
    xhr.send(values?Object.keys(values).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(values[k]);}).join("&"):null);
  }
  var panels={};
  function updateActive(data){setupState=data;Object.keys(panels).forEach(function(k){var p=panels[k];var id=(data.active||{})[p.collection]||"server";if(!p.edited){p.selected.value=id;p.update();}p.active.textContent="Active backend: "+({server:"Server only",todoist:"Todoist",googletasks:"Google Tasks",nextcloudnotes:"Nextcloud Notes",caldav:"CalDAV Calendar"}[id]||id);if(id!=="server"&&p.selected.value===id&&!p.candidate)p.setStep(4);});}
  ["todo","note","calendar"].forEach(function(kind){
    function el(name){return document.getElementById(kind+"-sync-"+name);}
    var select=extraFields[kind+"SyncProvider"];
    var p=panels[kind]={collection:kind==="todo"?"col_task":kind==="note"?"col_note":"col_event",selected:select,setStep:step,active:el("active"),status:el("status"),candidate:null,preview:null,busy:false,sequence:0,edited:false,update:update};
    function step(n){
      p.step=n;var dest=select.value==="todoist"?"project":select.value==="googletasks"?"task list":select.value==="caldav"?"calendar":"category";
      el("progress").textContent=select.value==="server"?"Server only · No account setup needed":"Step "+n+" of 4 · "+["Connect account","Choose "+dest,"Review and activate","Active"][n-1]+" · "+(4-n)+" remaining";
      el("next").textContent=select.value==="server"?"Use the button below to apply this choice. Your saved items stay on the server.":n===1?"Next: choose a "+dest+", review what will sync, then activate.":n===2?"Choose the "+dest+" to sync, then preview the connection. Nothing is activated yet.":n===3?"Review the counts below. Activate to start syncing this destination.":"Setup is complete. Open "+(kind==="todo"?"To Do":kind==="note"?"Notes":"Calendar")+" on the watch; allow the first sync to finish, then tap Refresh. Save and close to keep any other settings changes.";
      el("credentials").hidden=n>1||select.value==="server"||select.value==="googletasks";el("connect").hidden=n===2||n===3;if(n===4)el("connect").textContent="Change account or destination";el("back").hidden=n!==3;el("destination").hidden=n!==2;el("activate").hidden=n!==3;
      el("destination-title").textContent=dest.charAt(0).toUpperCase()+dest.slice(1);
    }
    function reset(){p.sequence++;p.candidate=null;p.preview=null;el("destination").hidden=true;el("activate").hidden=true;el("secret").value="";el("export").checked=false;el("stop").checked=false;step(1);}
    function update(){reset();var provider=select.value;el("credentials").hidden=provider==="server"||provider==="googletasks";el("endpoint-label").hidden=el("username-label").hidden=provider!=="nextcloudnotes"&&provider!=="caldav";
      el("connect").textContent=provider==="server"?"Use Server only":provider==="googletasks"?"Continue to Google authorization":"Connect";
      document.getElementById(kind+"-sync-help").textContent=provider==="server"?"No external account is needed. Use Server only below to disconnect an existing backend; records are preserved.":provider==="nextcloudnotes"?"Enter the Nextcloud base URL, username, and app password. We will find your categories and guide you through choosing one.":provider==="caldav"?"Use your private CalDAV address, username, and app password. Public sharing links are read-only. In Nextcloud, find the primary CalDAV address in Calendar settings.":provider==="todoist"?"Enter your Todoist API token. Connect to discover projects, then preview and activate.":"Google requires OAuth client credentials in ~/.codey/integrations.json (see README). Continue in this webview to authorize Google; this does not close Pebble settings.";
      el("secret-title").textContent=provider==="todoist"?"Todoist API token":"App password";
      p.status.textContent="";
    }
    function send(values,done){if(p.busy)return;p.busy=true;select.disabled=true;var seq=p.sequence;p.status.textContent=values.action==="connect"?"Connecting and finding destinations…":values.action==="bind"?"Checking what will sync…":values.action==="apply"?"Activating sync…":"Updating connection…";["connect","preview","activate"].forEach(function(k){el(k).disabled=true;});
      setupRequest(values,function(e,data){p.busy=false;select.disabled=false;["connect","preview","activate"].forEach(function(k){el(k).disabled=false;});
        if(seq!==p.sequence)return;
        if(e){p.status.textContent=e.message;return;}if(values.action==="connect")el("secret").value="";updateActive(data);if(seq!==p.sequence){p.status.textContent="Previous setup request completed. Review the active backend before continuing.";return;}p.status.textContent=data.message||"";done(data);
      });
    }
    function generation(){var cols=setupState&&setupState.collections||[];for(var i=0;i<cols.length;i++)if(cols[i].id===p.collection)return cols[i].binding_generation;return "";}
    select.addEventListener("change",function(){p.edited=true;update();});update();
    el("credentials").addEventListener("keydown",function(e){if(e.key==="Enter"||e.keyCode===13){e.preventDefault();el("connect").click();}});
    el("back").addEventListener("click",function(){p.preview=null;step(2);});
    el("connect").addEventListener("click",function(){
      p.edited=true;if(p.step===4){update();return;}
      if(!generation()){p.status.textContent="Setup is not ready. Reopen settings if the server could not be reached.";return;}
      var provider=select.value,values={action:provider==="server"?"disconnect":provider==="googletasks"?"authorize":"connect",collection:p.collection,generation:generation(),provider:provider,stop:el("stop").checked?"yes":""};
      if(values.action==="connect"){values.token=el("secret").value.trim();values.username=el("username").value.trim();values.endpoint=el("endpoint").value.trim();if(!values.token||((provider==="nextcloudnotes"||provider==="caldav")&&(!values.username||!values.endpoint))){p.status.textContent="Fill in the required connection fields.";return;}}
      p.sequence++;p.candidate=null;p.preview=null;send(values,function(data){
        if(values.action==="disconnect"){p.status.textContent="Server only is active. Open your collection on the watch.";return;}
        if(data.url){var base=setup.url.replace(/\/integrations\/setup-api$/,"");if(data.url.indexOf(base+"/integrations?ticket=")!==0){p.status.textContent="Invalid authorization destination";return;}window.location.href=data.url;return;}
        if(data.candidate_id){p.candidate=data.candidate_id;var dest=el("container");dest.textContent="";(data.containers||[]).forEach(function(c){var o=document.createElement("option");o.value=c.id;o.textContent=c.name;dest.appendChild(o);});if(data.containers&&data.containers.length){dest.value=data.containers[0].id;step(2);if(data.containers.length===1)preview();}else p.status.textContent="No destinations found for this account.";}
      });
    });
    ["container","export","stop"].forEach(function(k){el(k).addEventListener("change",function(){p.sequence++;p.preview=null;if(p.candidate)step(2);});});
    function preview(){if(!p.candidate)return;var values={action:"bind",candidate:p.candidate,container:el("container").value,export:el("export").checked?"yes":"",stop:el("stop").checked?"yes":""};send(values,function(data){p.preview=values;p.status.textContent=data.preview||"Review connection";step(3);});}
    el("preview").addEventListener("click",preview);
    el("activate").addEventListener("click",function(){if(!p.preview)return;var values=Object.assign({},p.preview,{action:"apply"});send(values,function(){reset();step(4);p.status.textContent="Sync connection activated. Future items sync automatically.";});});
  });
  setupRequest(null,function(e,data){if(e){Object.keys(panels).forEach(function(k){panels[k].status.textContent=e.message;});return;}updateActive(data);});
  form.addEventListener("submit", function(event) {
    var settings;
    event.preventDefault();
    var unfinished=Object.keys(panels).filter(function(k){return panels[k].busy||panels[k].candidate;});
    if(unfinished.length){status.textContent="Finish connecting "+unfinished.join(", ")+" before saving, or choose the active service to cancel setup.";return;}
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
    closeWith(settings);
  });
}());
