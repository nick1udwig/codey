"use strict";
var Journal = require("./journal");
var KEY = "codey.collections.cache.v1";

// Disposable cache only. Journal persistence never passes through this budget.
function Cache(storage, scope, options) {
  this.storage = storage;
  this.options = options || {};
  this.data = {pages:{}, records:{}, scope:scope};
  this.entries = {pages:{}, records:{}};
  this.clock = 0;
  this.bytes = 0;
  this.dirty = false;
  this.stats = {serializedBytes:0, writtenBytes:0, evictions:0};
  try {
    var saved = JSON.parse(storage.getItem(KEY));
    if (saved && saved.scope === scope && saved.pages && saved.records) this.data = saved;
  } catch (_) {}
  var self = this;
  ["pages", "records"].forEach(function(group) {
    Object.keys(self.data[group]).forEach(function(key) {
      self.remember(group, key, self.data[group][key]);
    });
  });
  this.metadata = JSON.stringify(this.data.collections || []);
  this.dirty = false;
  this.prune();
}
Cache.prototype.remember = function(group, key, value) {
  var raw = JSON.stringify(value), old = this.entries[group][key];
  this.stats.serializedBytes += raw.length * 2;
  if (old && old.raw === raw) { old.used = ++this.clock; return false; }
  if (old) this.bytes -= old.bytes;
  var bytes = (JSON.stringify(key).length + raw.length + 2) * 2;
  this.entries[group][key] = {raw:raw, bytes:bytes, used:++this.clock};
  this.bytes += bytes;
  this.data[group][key] = value;
  this.dirty = true;
  return true;
};
Cache.prototype.page = function(key) {
  var entry = this.entries.pages[key];
  if (entry) entry.used = ++this.clock;
  return this.data.pages[key];
};
Cache.prototype.putPage = function(key, page, first) {
  this.remember("pages", key, page);
  this.entries.pages[key].first = first;
  this.current = key;
};
Cache.prototype.merge = function(records) {
  var self = this;
  records.forEach(function(record) {
    var old = self.data.records[record.id];
    if (!old || Journal.compare(record.revision, old.revision) >= 0) {
      self.remember("records", record.id, record);
    }
  });
};
Cache.prototype.prune = function() {
  var self = this, current = this.data.pages[this.current], protectedRecords = {};
  if (current && current.records) current.records.forEach(function(r) { protectedRecords[r.id] = true; });
  var candidates = [];
  ["pages", "records"].forEach(function(group) {
    Object.keys(self.entries[group]).forEach(function(key) {
      var entry = self.entries[group][key];
      var priority = group === "pages" ? key === self.current ? 3 : entry.first || /::?$/.test(key) ? 2 : 0 : protectedRecords[key] ? 1 : 0;
      candidates.push({group:group, key:key, entry:entry, priority:priority});
    });
  });
  candidates.sort(function(a,b) { return a.priority - b.priority || a.entry.used - b.entry.used; });
  var counts = {pages:Object.keys(this.entries.pages).length, records:Object.keys(this.entries.records).length};
  var limits = {pages:this.options.maxPages || 48, records:this.options.maxRecords || 128};
  var metadataBytes = (this.metadata || "").length * 2 + (this.data.scope || "").length * 2 + 256;
  candidates.forEach(function(candidate) {
    if (self.bytes + metadataBytes <= (self.options.maxBytes || 256 * 1024) && counts[candidate.group] <= limits[candidate.group]) return;
    delete self.entries[candidate.group][candidate.key];
    delete self.data[candidate.group][candidate.key];
    self.bytes -= candidate.entry.bytes;
    counts[candidate.group]--;
    self.stats.evictions++;
    self.dirty = true;
  });
};
Cache.prototype.save = function(scope) {
  var metadata = JSON.stringify(this.data.collections || []);
  if (scope !== this.data.scope || metadata !== this.metadata) this.dirty = true;
  this.data.scope = scope;
  this.metadata = metadata;
  this.prune();
  if (!this.dirty) return;
  var self = this;
  function object(group) {
    return "{" + Object.keys(self.entries[group]).map(function(key) {
      return JSON.stringify(key) + ":" + self.entries[group][key].raw;
    }).join(",") + "}";
  }
  var raw = '{"pages":' + object("pages") + ',"records":' + object("records") + ',"collections":' + metadata + ',"scope":' + JSON.stringify(scope) + '}';
  try {
    this.storage.setItem(KEY, raw);
    this.stats.writtenBytes += raw.length * 2;
    this.dirty = false;
  } catch (_) {
    // Cache failure cannot fail a server read or a durable journal operation.
    try { this.storage.removeItem(KEY); } catch (_) {}
  }
};
Cache.prototype.clear = function() {
  try { this.storage.removeItem(KEY); } catch (_) {}
  this.data.pages = {}; this.data.records = {};
  this.entries = {pages:{}, records:{}}; this.bytes = 0; this.dirty = true;
};
module.exports = {Cache:Cache, KEY:KEY};
