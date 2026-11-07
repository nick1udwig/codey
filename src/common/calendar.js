"use strict";

var Plugin = require("./plugin-source");

function records(data) {
  return data.instances.map(function(instance) {
    var p = instance.properties || {}, start = Plugin.number(p.starts_at, "timestamp"), end = Plugin.number(p.ends_at, "timestamp");
    if (start === null || end === null || end <= start || end * 1000 <= Date.now()) return null;
    var first = new Date(start * 1000), last = new Date(end * 1000);
    if (!isFinite(first.getTime()) || !isFinite(last.getTime())) return null;
    var allDay = p.all_day && p.all_day.boolean && p.all_day.boolean.value === true;
    return {
      id: String(instance.instanceId), kind: "event", title: Plugin.text(p.name) || "Untitled",
      start: first.toISOString().slice(0, allDay ? 10 : 24), end: last.toISOString().slice(0, allDay ? 10 : 24),
      location: Plugin.text(p.location), body: Plugin.text(p.calendar), capabilities: [], body_complete: true
    };
  }).filter(function(record) { return record; }).sort(function(a, b) { return a.start.localeCompare(b.start); });
}

function Calendar(pebble) {
  this.source = new Plugin.Source(pebble, "calendar", "event", ["name", "starts_at", "ends_at", "all_day", "location", "calendar"]);
  this.snapshot = null;
  this.sequence = 0;
}
Calendar.prototype.list = function(kind, state, snapshot, cursor, done) {
  var self = this;
  function page() {
    var offset = Number(cursor || 0), saved = self.snapshot;
    if (!saved || (snapshot && snapshot !== saved.id) || !isFinite(offset) || offset < 0 || offset % 8) {
      done(new Error("Calendar changed. Reopen Calendar.")); return;
    }
    done(null, {records:saved.records.slice(offset, offset + 8), total:saved.records.length,
      snapshot_id:saved.id, next_cursor:offset + 8 < saved.records.length ? String(offset + 8) : "", source:"Phone calendar"});
  }
  if (snapshot) { page(); return; }
  self.source.read(function(error, data) {
    if (error) { done(error); return; }
    self.snapshot = {id:String(++self.sequence), records:records(data)};
    page();
  });
};
Calendar.prototype.body = function(record, cursor, done) {
  done(null, {body:record.body || "", next_cursor:""});
};
module.exports = Calendar;
