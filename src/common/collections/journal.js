"use strict";

// Two independently verifiable slots: no pointer write is needed to commit.
var PREFIX = "codey.collections.journal.v1.";

function safe(n) {
  return typeof n === "number" && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function(k) {
    return JSON.stringify(k) + ":" + stable(v[k]);
  }).join(",") + "}";
  return JSON.stringify(v);
}

function checksum(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

// Keep exact input comparison without storing the payload a second time.
function inputMetadata(input) {
  var metadata = {};
  Object.keys(input).forEach(function(key) {
    metadata[key] = key === "payload" ? null : input[key];
  });
  return metadata;
}

function sameInput(receipt, input) {
  return JSON.stringify(receipt.input) === JSON.stringify(inputMetadata(input)) && JSON.stringify(receipt.operation.payload) === JSON.stringify(input.payload);
}

function pack(data) {
  var packed = Object.assign({}, data);
  packed.entries = data.entries.map(function(entry) {
    var result = {
      ingress: entry.operation.ingress_id
    };
    if (entry.receipt) result.receipt = entry.receipt;
    return result;
  });
  return JSON.stringify(packed);
}

function unpack(data, schema) {
  if (schema === 1) {
    Object.keys(data.receipts).forEach(function(key) {
      var receipt = data.receipts[key], input = JSON.parse(receipt.hash);
      if (JSON.stringify(input.payload) !== JSON.stringify(receipt.operation.payload)) throw new Error("Invalid legacy input");
      receipt.input = inputMetadata(input);
      delete receipt.hash;
    });
  }
  data.entries = data.entries.map(function(entry) {
    var ingress = schema === 1 ? entry.operation.ingress_id : entry.ingress;
    var receipt = data.receipts[ingress];
    if (!receipt || !receipt.operation || receipt.operation.ingress_id !== ingress) throw new Error("Invalid operation reference");
    if (schema === 1 && JSON.stringify(entry.operation) !== JSON.stringify(receipt.operation)) throw new Error("Invalid legacy operation");
    var result = {
      operation: receipt.operation
    };
    if (entry.receipt) result.receipt = entry.receipt;
    return result;
  });
  return data;
}

function valid(raw) {
  try {
    var v = JSON.parse(raw);
    if (v.schema !== 1 && v.schema !== 2 || !safe(v.generation) || v.generation < 1 || typeof v.payload !== "string" || checksum(v.payload) !== v.checksum) return null;
    var d = JSON.parse(v.payload);
    if (!d || !Array.isArray(d.entries) || !d.receipts || !safe(d.sequence) || d.sequence < 0) return null;
    v.data = unpack(d, v.schema);
    return v;
  } catch (_) {
    return null;
  }
}

function Journal(storage, options) {
  this.storage = storage;
  this.options = options || {};
  this.slot = -1;
  this.generation = 0;
  var found = false;
  for (var i = 0; i < 2; i++) {
    var raw = storage.getItem(PREFIX + i);
    found = found || !!raw;
    var v = valid(raw);
    if (v && v.generation > this.generation) {
      this.slot = i;
      this.generation = v.generation;
      this.data = v.data;
    }
  }
  if (!this.data) {
    if (found) throw new Error("Collection journal is unreadable. Export storage for recovery.");
    this.data = {
      sequence: 0,
      scope: null,
      entries: [],
      receipts: {},
      bridge: ""
    };
  }
}

Journal.prototype.commit = function(next) {
  var payload = pack(next);
  if (payload.length * 2 > (this.options.maxBytes || 512 * 1024)) throw new Error("Phone queue is full. Pending input is preserved.");
  var slot = this.slot === 0 ? 1 : 0, envelope = JSON.stringify({
    schema: 2,
    generation: this.generation + 1,
    payload: payload,
    checksum: checksum(payload)
  });
  var self = this;
  function write() {
    self.storage.setItem(PREFIX + slot, envelope);
    if (self.storage.getItem(PREFIX + slot) !== envelope || !valid(envelope)) throw new Error("Phone storage verification failed.");
  }
  try {
    write();
  } catch (e) {
    if (this.options.evictCache) {
      this.options.evictCache();
      write();
    } else throw e;
  }
  this.data = next;
  this.slot = slot;
  this.generation++;
};

Journal.prototype.update = function(fn) {
  var next = unpack(JSON.parse(pack(this.data)), 2);
  var result = fn(next);
  this.commit(next);
  return result;
};

Journal.prototype.enroll = function(scope) {
  this.update(function(d) {
    if (d.scope && JSON.stringify(d.scope) !== JSON.stringify(scope)) throw new Error("Server changed. Export/recover the original queue before enrolling.");
    d.scope = scope;
  });
};

Journal.prototype.bridge = function(id) {
  this.update(function(d) {
    d.bridge = id;
    Object.keys(d.receipts).forEach(function(k) {
      if (d.receipts[k].durable) delete d.receipts[k];
    });
    d.entries = d.entries.filter(function(e) {
      return !e.receipt || !e.receipt.durably_recorded;
    });
  });
};

Journal.prototype.accept = function(input) {
  var old = this.data.receipts[input.ingress];
  if (old) {
    if (!sameInput(old, input)) throw new Error("Event identity reused with different input.");
    return old.operation;
  }
  var self = this;
  return this.update(function(d) {
    if (!d.scope) throw new Error("Configure and connect the collection server first.");
    if (input.ingress.indexOf("watch:") === 0 && input.ingress.indexOf("watch:" + d.bridge + ":") !== 0) throw new Error("Stale bridge session. Reopen the collection.");
    if (d.entries.length >= (self.options.maxOperations || 256)) throw new Error("Phone queue is full. Pending input is preserved.");
    if (d.sequence >= 9007199254740990) throw new Error("Client identity exhausted. Recovery required.");
    var seq = String(++d.sequence), id = "op:" + d.scope.client_id + ":" + seq;
    var op = {
      id: id,
      ingress_id: input.ingress,
      sequence: seq,
      collection_id: input.collection_id,
      binding_generation: input.generation,
      record_id: input.record_id || "rec:" + d.scope.client_id + ":" + seq,
      type: input.type,
      base_revision: input.revision || "",
      depends_on: [],
      payload: input.payload
    };
    var previous = d.entries.filter(function(e) {
      return e.operation.record_id === op.record_id;
    }).pop();
    if (previous) {
      op.base_operation_id = previous.operation.id;
      op.base_revision = "";
      op.depends_on = [ previous.operation.id ];
    }
    d.entries.push({
      operation: op
    });
    d.receipts[input.ingress] = {
      input: inputMetadata(input),
      operation: op,
      durable: false,
      alias: input.alias,
      view: input.view
    };
    return op;
  });
};

// A server response is one durable transaction, including mixed outcomes.
Journal.prototype.receipts = function(results) {
  var incoming = Object.create(null), changed = false;
  results.forEach(function(r) {
    if (r && r.durably_recorded === true) incoming[r.operation_id] = r;
  });
  this.data.entries.forEach(function(e) {
    var r = incoming[e.operation.id];
    if (r && stable(e.receipt) !== stable(r)) changed = true;
  });
  if (!changed) return;
  this.update(function(d) {
    d.entries.forEach(function(e) {
      var r = incoming[e.operation.id];
      if (!r) return;
      e.receipt = clone(r);
      d.receipts[e.operation.ingress_id].durable = true;
    });
  });
};

Journal.prototype.compact = function(records) {
  var data = this.data, retained = Object.create(null);
  var entries = data.entries.filter(function(e) {
    var keep = true;
    if (e.receipt && e.receipt.durably_recorded) {
      var r = records[e.operation.record_id];
      keep = e.receipt.outcome === "applied" && (!r || compare(r.revision, e.receipt.revision) < 0);
    }
    if (keep) retained[e.operation.ingress_id] = true;
    return keep;
  });
  var expired = Object.keys(data.receipts).filter(function(k) {
    return k.indexOf("watch:") !== 0 && data.receipts[k].durable && !retained[k];
  });
  if (entries.length === data.entries.length && !expired.length) return;
  // Commit the changed journal through the same verified two-slot write path.
  var next = unpack(JSON.parse(pack(Object.assign({}, data, {
    entries: entries
  }))), 2);
  expired.forEach(function(k) {
    delete next.receipts[k];
  });
  this.commit(next);
};

function compare(a, b) {
  a = String(a || "0");
  b = String(b || "0");
  return a.length === b.length ? a === b ? 0 : a > b ? 1 : -1 : a.length > b.length ? 1 : -1;
}

module.exports = {
  Journal: Journal,
  PREFIX: PREFIX,
  checksum: checksum,
  compare: compare,
  clone: clone,
  stable: stable
};