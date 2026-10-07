"use strict";

var J = require("./journal");

var Cache = require("./cache");

var CACHE = Cache.KEY;
function checkName(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function checkCanonical(entries, id) {
  var create = entries.filter(function(e) { return e.operation.type === "check.create" && e.operation.record_id === id && e.receipt && e.receipt.record; })[0];
  return create ? create.receipt.record.id : id;
}
function checkDisplayedID(entries, id, map) {
  var canonical = checkCanonical(entries, id);
  if (map[canonical]) return canonical;
  var create = entries.filter(function(e) { return e.operation.type === "check.create" && e.operation.record_id === id; })[0];
  if (!create) return canonical;
  var key = checkName(create.operation.payload.title);
  return Object.keys(map).filter(function(candidate) { return map[candidate].kind === "check" && checkName(map[candidate].title) === key; })[0] || canonical;
}
function checkBase(entries, op) {
  if (op.base_revision) return op.base_revision;
  if (!op.base_operation_id) return "";
  var parent = entries.filter(function(e) { return e.operation.id === op.base_operation_id; })[0];
  if (!parent) return "";
  return parent.receipt && parent.receipt.outcome === "applied" ? parent.receipt.revision : checkBase(entries, parent.operation);
}
function mayProjectCheck(record, entries, op) {
  var base = checkBase(entries, op), revision = String(record.revision || "");
  return revision === base || base === "" && revision === "1" && !record.count;
}

function Client(options) {
  this.options = options;
  this.storage = options.storage;
  var self = this;
  this.journal = new J.Journal(this.storage, {
    evictCache: function() {
      self.cacheStore.clear();
    }
  });
  this.cacheStore = new Cache.Cache(this.storage, JSON.stringify(this.journal.data.scope), options.cacheBudget);
  this.cache = this.cacheStore.data;
  this.busy = false;
  this.quarantined = false;
  this.quarantineReason = "";
  this.collections = [];
}

Client.prototype.saveCache = function() {
  this.cacheStore.save(JSON.stringify(this.journal.data.scope));
};

Client.prototype.request = function(method, path, body, done, recovery) {
  var options = this.options, scope = this.journal.data.scope, base = options.base(), token = options.token();
  if (!recovery && scope && (scope.base !== base || scope.credential !== J.checksum(token))) {
    if (!this.quarantined) this.quarantineReason = "settings";
    this.quarantined = true;
    done(new Error("Server settings changed. Original pending work is quarantined."));
    return;
  }
  if (!base) {
    done(new Error("Configure the collection server URL."));
    return;
  }
  if (!/^https:\/\//.test(base) && !(options.allowHTTP && options.allowHTTP())) {
    done(new Error("Collection HTTP requires explicit development permission."));
    return;
  }
  var xhr, ended = false;
  function finish(e, v) {
    if (ended) return;
    ended = true;
    if (base !== options.base() || token !== options.token()) {
      done(new Error("Server settings changed during request."));
      return;
    }
    done(e, v);
  }
  try {
    xhr = new options.XMLHttpRequest();
    xhr.open(method, base.replace(/\/$/, "") + path, true);
    xhr.timeout = 15e3;
    if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function() {
      var v;
      if (xhr.status === 404 && path === "/v1/sync/info") {
        var unsupported = new Error("Collections require a newer codey-server. Upgrade the server to use Notes, To Do, and Calendar.");
        unsupported.code = "unsupported_server";
        unsupported.status = 404;
        finish(unsupported);
        return;
      }
      if (xhr.status === 404 && path === "/v1/integration-setup-sessions") {
        finish(new Error("Sync setup requires a newer codey-server."));
        return;
      }
      try {
        v = JSON.parse(xhr.responseText);
      } catch (_) {
        finish(new Error("Invalid collection server response."));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        var e = new Error(v.message || "Collection request failed.");
        e.code = v.code;
        e.status = xhr.status;
        finish(e);
        return;
      }
      finish(null, v);
    };
    xhr.onerror = xhr.ontimeout = function() {
      finish(new Error("Collection server unavailable."));
    };
    xhr.send(body == null ? null : JSON.stringify(body));
  } catch (e) {
    finish(e);
  }
};

Client.prototype.connect = function(done) {
  var self = this;
  if (this.connectWaiters) {
    this.connectWaiters.push(done);
    return;
  }
  this.connectWaiters = [ done ];
  this.connectOnce(function(e) {
    var waiters = self.connectWaiters;
    self.connectWaiters = null;
    waiters.forEach(function(callback) {
      callback(e);
    });
  });
};

Client.prototype.ensure = function(done, kind) {
  var known = this.collections.length ? this.collections : this.cache.collections || [], scope = this.journal.data.scope;
  if (scope && !this.quarantined && scope.base === this.options.base() && scope.credential === J.checksum(this.options.token()) && known.length && (!kind || known.some(function(c) { return c.kind === kind; }))) {
    done();
    return;
  }
  this.connect(done);
};

Client.prototype.connectOnce = function(done) {
  var self = this;
  var scope = this.journal.data.scope, originalScope = J.stable(scope);
  var base = this.options.base(), credential = J.checksum(this.options.token());
  // A changed token may only bypass the settings guard for this identity read
  // at the original URL. Mutations stay blocked until verification is durable.
  var rotateCredential = scope && scope.base === base && scope.credential !== credential;
  this.request("GET", "/v1/sync/info", null, function(e, info) {
    if (e) return done(e);
    if (info.protocol_version !== 1 || !info.server_instance_id || !info.store_epoch) return done(new Error("Unsupported collection server."));
    if (originalScope !== J.stable(self.journal.data.scope)) return done(new Error("Collection scope changed during connection. Reconnect collections."));
    if (scope && (scope.server_instance_id !== info.server_instance_id || scope.store_epoch !== info.store_epoch || scope.principal !== info.principal)) {
      self.quarantined = true;
      self.quarantineReason = "identity";
      return done(new Error("Server/store identity changed. Queue recovery required."));
    }
    if (self.quarantined && self.quarantineReason !== "settings") return done(new Error("Queue is quarantined. Recover original server first."));
    if (rotateCredential) {
      try {
        self.journal.update(function(d) {
          d.scope.credential = credential;
        });
      } catch (error) {
        return done(error);
      }
      self.saveCache();
    }
    self.quarantined = false;
    self.quarantineReason = "";
    function ready() {
      self.request("GET", "/v1/collections?utc_offset_minutes=" + -new Date().getTimezoneOffset(), null, function(e, cols) {
        if (!e) {
          self.collections = cols;
          if (JSON.stringify(self.cache.collections) !== JSON.stringify(cols)) {
            self.cache.collections = cols;
            self.saveCache();
          }
        }
        done(e);
      });
    }
    if (scope) return ready();
    self.request("POST", "/v1/sync/clients", {}, function(e, enrollment) {
      if (e) return done(e);
      if (enrollment.server_instance_id !== info.server_instance_id || enrollment.store_epoch !== info.store_epoch) return done(new Error("Server identity changed during enrollment."));
      enrollment.base = self.options.base();
      enrollment.credential = J.checksum(self.options.token());
      try {
        self.journal.enroll(enrollment);
      } catch (e) {
        return done(e);
      }
      ready();
    });
  }, rotateCredential);
};

Client.prototype.collection = function(kind) {
  var list = this.collections.length ? this.collections : this.cache.collections || [];
  var c = list.filter(function(c) {
    return c.kind === kind;
  })[0];
  if (!c) throw new Error(kind === "event" ? "Calendar requires a newer codey-server." : "This collection is unavailable on this server.");
  return c;
};

Client.prototype.resolveCheck = function(name, done) {
  var key = checkName(name), self = this;
  if (!key) return done(new Error("Say a check name, for example 'check baby'."));
  var creates = this.journal.data.entries.filter(function(e) {
    return e.operation.type === "check.create" && (!e.receipt || e.receipt.outcome === "applied") && checkName(e.operation.payload.title) === key;
  });
  if (creates.length) {
    var latest = creates[creates.length - 1], create = latest.operation;
    return done(null, latest.receipt && latest.receipt.record || {id:create.record_id, title:create.payload.title, kind:"check", revision:"", count:0, capabilities:["check.add"]});
  }
  var cached = Object.keys(this.cache.records).map(function(id) { return self.cache.records[id]; }).filter(function(r) { return r.kind === "check" && !r.deleted && checkName(r.title) === key; })[0];
  if (cached) return done(null, cached);
  this.request("GET", "/v1/checks/lookup?name=" + encodeURIComponent(name), null, function(e, r) {
    if (!e) { self.merge([r]); self.saveCache(); return done(null, r); }
    if (e.status === 404) { var missing = new Error("Check '" + name + "' does not exist. Say 'check new " + name + "' first."); missing.code="not_found"; return done(missing); }
    done(e);
  });
};

Client.prototype.checkHistory = function(record, cursor, done) {
  var self = this, key = "check-history:" + record.id + ":" + (cursor || "");
  this.cacheStore.focus(key);
  this.request("GET", "/v1/checks/" + encodeURIComponent(record.id) + "/history?limit=8&cursor=" + encodeURIComponent(cursor || ""), null, function(e, page) {
    if (e) {
      page = self.cacheStore.page(key, false);
      if (!page) {
        var local = self.journal.data.entries.some(function(entry) { return entry.operation.record_id === record.id && (!entry.receipt || entry.receipt.outcome === "applied"); });
        if (!local) return done(new Error("Check history unavailable offline. Reconnect the phone to load it."));
        page = {record:record,occurrences:[],next_cursor:"",complete:false,offline_only:true};
      } else page = J.clone(page);
      page.stale = true;
    } else {
      self.merge([page.record]);
      self.cacheStore.putPage(key, page, !cursor, false);
      self.saveCache();
    }
    var seen = {}, rows = page.occurrences.slice(), localRows = [];
    rows.forEach(function(o) { seen[o.id] = true; });
    if (!cursor) self.journal.data.entries.forEach(function(entry) {
      var op = entry.operation;
      if (op.type !== "check.add" || entry.receipt || seen[op.id] || !mayProjectCheck(page.record, self.journal.data.entries, op)) return;
      if (checkCanonical(self.journal.data.entries, op.record_id) !== record.id) {
        var create = self.journal.data.entries.filter(function(e) { return e.operation.type === "check.create" && e.operation.record_id === op.record_id && checkName(e.operation.payload.title) === checkName(record.title); })[0];
        if (!create) return;
      }
      localRows.push({id:op.id, occurred_at:op.payload.occurred_at, pending:true});
    });
    localRows.sort(function(a,b) { return new Date(b.occurred_at) - new Date(a.occurred_at) || (a.id < b.id ? 1 : -1); });
    rows = rows.concat(localRows.slice(0, 8));
    rows.sort(function(a,b) { return new Date(b.occurred_at) - new Date(a.occurred_at) || (a.id < b.id ? 1 : -1); });
    page = J.clone(page);
    page.hidden_local = Math.max(0, localRows.length - 8);
    page.occurrences = rows;
    page.record = self.cache.records[record.id] || page.record;
    done(null, page);
  });
};

Client.prototype.accept = function(input) {
  if (this.quarantined) throw new Error("Queue is quarantined. Recover original server first.");
  var scope = this.journal.data.scope;
  if (!scope || scope.base !== this.options.base() || scope.credential !== J.checksum(this.options.token())) throw new Error("Connect original collection server before saving.");
  return this.journal.accept(input);
};

Client.prototype.drain = function(done) {
  var self = this;
  if (this.busy) return done && done();
  var entries = this.journal.data.entries.filter(function(e) {
    return !e.receipt;
  });
  if (!entries.length) return done && done();
  this.busy = true;
  var scope = this.journal.data.scope, batch = {
    protocol_version: 1,
    server_instance_id: scope.server_instance_id,
    store_epoch: scope.store_epoch,
    client_id: scope.client_id,
    operations: entries.slice(0, 20).map(function(e) {
      return e.operation;
    })
  };
  this.request("POST", "/v1/sync/mutations", batch, function(e, data) {
    self.busy = false;
    if (!e) {
      try {
        self.journal.receipts(data.results);
      } catch (error) {
        e = error;
      }
    }
    if (e && [ "store_epoch_changed", "server_mismatch", "binding_changed" ].indexOf(e.code) >= 0) {
      self.quarantined = true;
      self.quarantineReason = e.code;
    }
    if (done) done(e, data);
  });
};

Client.prototype.merge = function(records) {
  this.cacheStore.merge(records);
};

Client.prototype.list = function(kind, state, snapshot, cursor, done, preferCache) {
  var self = this;
  this.ensure(function(e) {
    if (e) return done(e);
    self.listReady(kind, state, snapshot, cursor, done, preferCache);
  }, kind);
};

Client.prototype.listReady = function(kind, state, snapshot, cursor, done, preferCache) {
  var self = this, col;
  try {
    col = this.collection(kind);
  } catch (e) {
    done(e);
    return;
  }
  var key = kind + ":" + state + ":" + (snapshot || "") + ":" + (cursor || "");
  this.cacheStore.focus(key);
  if (preferCache && this.cacheStore.page(key)) {
    done(null, this.project(this.cacheStore.page(key), kind, state, !snapshot && !cursor));
    return;
  }
  function receive(e, p) {
    if (e) {
      var cached = self.cacheStore.page(key, false);
      if (cached) {
        cached = J.clone(cached);
        cached.stale = true;
        done(null, self.project(cached, kind, state, !snapshot && !cursor));
      } else done(e);
      return;
    }
    self.merge(p.records);
    self.cacheStore.putPage(key, p, !snapshot && !cursor, false);
    self.saveCache();
    try {
      self.journal.compact(self.cache.records);
    } catch (_) {}
    done(null, self.project(p, kind, state, !snapshot && !cursor));
  }
  if (snapshot) {
    this.request("GET", "/v1/sync/snapshots/" + encodeURIComponent(snapshot) + "?limit=8&page_token=" + encodeURIComponent(cursor || ""), null, receive);
  } else {
    this.request("POST", "/v1/sync/snapshots", {
      collection_id: col.id,
      state: state,
      utc_offset_minutes: -new Date().getTimezoneOffset(),
      limit: 8
    }, receive);
  }
};

Client.prototype.project = function(page, kind, state, first) {
  if (first === undefined) first = true;
  var p = J.clone(page), map = {}, self = this;
  var entries = this.journal.data.entries;
  p.records.forEach(function(r) {
    var newer = self.cache.records[r.id];
    map[r.id] = newer && J.compare(newer.revision, r.revision) > 0 ? J.clone(newer) : r;
  });
  this.journal.data.entries.forEach(function(e) {
    var op = e.operation;
    if (op.collection_id !== "col_" + kind) return;
    if (e.receipt && e.receipt.outcome !== "applied") return;
    var targetID = kind === "check" ? checkDisplayedID(entries, op.record_id, map) : op.record_id;
    var r = map[targetID];
    if (!r && op.type.indexOf(".create") > 0 && (kind !== "check" || first)) {
      r = {
        id: targetID,
        collection_id: op.collection_id,
        kind: kind,
        revision: "",
        title: op.payload.title,
        completed: false,
        start: op.payload.start,
        end: op.payload.end,
        location: op.payload.location,
        body_complete: true,
        count: kind === "check" ? 0 : undefined,
        capabilities: kind === "event" ? [] : kind === "note" ? [ "note.replace", "note.append" ] : kind === "check" ? [ "check.add" ] : [ "task.complete", "task.restore" ]
      };
      map[r.id] = r;
    }
    if (!r) return;
    r.pending = true;
    if (op.payload.title) r.title = op.payload.title;
    if (op.type === "task.complete") r.completed = true;
    if (op.type === "task.restore") r.completed = false;
    if (op.type === "record.delete") r.deleted = true;
    if (e.receipt && e.receipt.record && J.compare(e.receipt.record.revision, r.revision) >= 0) Object.assign(r, e.receipt.record);
  });
  if (kind === "check") Object.keys(map).forEach(function(id) {
    var r = map[id], pending = entries.filter(function(e) { return checkDisplayedID(entries, e.operation.record_id, map) === id && e.operation.type === "check.add" && !e.receipt; });
    // A newer server revision may already include a mutation whose response was
    // lost. Suppress optimistic arithmetic until replay supplies its receipt.
    if (pending.length && pending.every(function(e) { return mayProjectCheck(r, entries, e.operation); })) r.count = (r.count || 0) + pending.length;
  });
  p.records = Object.keys(map).map(function(k) {
    return map[k];
  }).filter(function(r) {
    return !r.deleted && (kind === "event" ? new Date(r.end.length === 10 ? r.end + "T00:00:00" : r.end).getTime() > Date.now() : kind === "note" || kind === "check" || r.completed === (state === "completed"));
  });
  if (kind === "event") p.records.sort(function(a, b) {
    return new Date(a.start.length === 10 ? a.start + "T00:00:00" : a.start) - new Date(b.start.length === 10 ? b.start + "T00:00:00" : b.start);
  });
  p.total = Math.max(0, (typeof page.total === "number" ? page.total : page.records.length) + p.records.length - page.records.length);
  p.pending_count = this.journal.data.entries.filter(function(e) {
    return !e.receipt;
  }).length;
  if (p.records.length > 8) {
    p.records = p.records.slice(0, 8);
    p.partial = true;
  }
  return p;
};

Client.prototype.body = function(record, cursor, done) {
  var self = this, key = record.id + ":" + record.revision + ":" + (cursor || "");
  this.cacheStore.focus(key);
  this.request("GET", "/v1/records/" + encodeURIComponent(record.id) + "/body?revision=" + encodeURIComponent(record.revision) + "&max_bytes=704&cursor=" + encodeURIComponent(cursor || ""), null, function(e, v) {
    if (e) {
      v = self.cacheStore.page(key, false);
      if (v) {
        v = J.clone(v);
        v.stale = true;
        done(null, v);
      } else done(e);
      return;
    }
    self.cacheStore.putPage(key, v, !cursor, false);
    self.saveCache();
    done(null, v);
  });
};

Client.prototype.recover = function(done) {
  var self = this, scope = this.journal.data.scope;
  if (!scope) return this.connect(done);
  this.request("GET", "/v1/sync/info", null, function(e, info) {
    if (e) return done(e);
    if (info.server_instance_id !== scope.server_instance_id) return done(new Error("Recovery requires the original server identity."));
    var batch = {
      protocol_version: 1,
      server_instance_id: scope.server_instance_id,
      store_epoch: scope.store_epoch,
      client_id: scope.client_id,
      operations: self.journal.data.entries.filter(function(e) {
        return !e.receipt;
      }).map(function(e) {
        return e.operation;
      })
    };
    self.request("POST", "/v1/sync/recovery", batch, function(e, data) {
      if (e) return done(e);
      try {
        self.journal.receipts(data.results);
      } catch (e) {
        return done(e);
      }
      self.request("POST", "/v1/sync/clients", {}, function(e, next) {
        if (e) return done(e);
        if (next.server_instance_id !== info.server_instance_id || next.store_epoch !== info.store_epoch) return done(new Error("Store changed during recovery."));
        next.base = self.options.base();
        next.credential = J.checksum(self.options.token());
        try {
          self.journal.update(function(d) {
            if (d.entries.some(function(e) {
              return !e.receipt || !e.receipt.durably_recorded;
            })) throw new Error("Pending input has not been handed off.");
            d.entries = [];
            d.receipts = {};
            d.sequence = 0;
            d.scope = next;
          });
          self.cacheStore.clear();
          self.cache.collections = [];
          self.saveCache();
          self.quarantined = false;
          self.quarantineReason = "";
          done();
        } catch (e) {
          done(e);
        }
      }, true);
    }, true);
  }, true);
};

Client.prototype.exportJournal = function() {
  return JSON.stringify(this.journal.data);
};

Client.prototype.agent = function(input, done) {
  var self = this, old = this.journal.data.receipts[input.ingress];
  if (old) {
    try {
      done(null, this.accept(input));
    } catch (e) {
      done(e);
    }
    return;
  }
  this.request("GET", "/v1/sync/ingress/" + encodeURIComponent(input.ingress), null, function(e, r) {
    if (!e) {
      if (r.request.type !== input.type || J.stable(r.request.payload) !== J.stable(input.payload)) {
        done(new Error("Agent ingress identity reused with different input."));
        return;
      }
      done(null, r.request);
      return;
    }
    if (e.status !== 404) {
      done(e);
      return;
    }
    try {
      done(null, self.accept(input));
    } catch (e) {
      done(e);
    }
  });
};

module.exports = {
  Client: Client,
  CACHE: CACHE
};
