"use strict";

function text(property) {
  var shape = property && (property.longText || property.shortText);
  return shape && typeof shape.text === "string" ? shape.text : "";
}

function number(property, shape) {
  var value = property && property[shape || "numericValue"];
  return value && typeof value.value === "number" && isFinite(value.value) ? value.value : null;
}

function sourceError(category, error) {
  var name = category === "calendar" ? "Calendar" : "Weather";
  if (error && error.code === "PERMISSION_DENIED") return new Error("Allow " + name + " access for codey in the Pebble app.");
  if (error && error.code === "TIMEOUT") return new Error(name + " plugin timed out. Try again.");
  return new Error(name + " plugin unavailable. Enable Plugins / permissions preview in the Pebble app.");
}

function Source(pebble, category, item, properties, changed) {
  this.pebble = pebble;
  this.category = category;
  this.item = item;
  this.properties = properties;
  this.changed = changed || function() {};
  this.pending = [];
  this.subscription = null;
  this.data = null;
  this.expires = 0;
  this.generation = 0;
}
Source.prototype.finish = function(error, data) {
  var pending = this.pending.splice(0);
  pending.forEach(function(waiter) { clearTimeout(waiter.timer); waiter.done(error, data); });
};
Source.prototype.start = function() {
  var self = this;
  if (self.subscription) return;
  var generation = ++self.generation;
  function failed(error) {
    if (generation !== self.generation) return;
    self.data = null;
    self.error = sourceError(self.category, error);
    self.changed(self.error);
    self.finish(self.error);
  }
  if (!self.pebble || typeof self.pebble.subscribeToSource !== "function") { failed(); return; }
  self.subscription = {};
  try {
    self.subscription = self.pebble.subscribeToSource({
      category: self.category, item: self.item, properties: self.properties,
      onData: function(data) {
        if (generation !== self.generation) return;
        if (!data || !Array.isArray(data.instances)) { failed(); return; }
        self.error = null;
        self.data = data;
        self.expires = typeof data.validUntilMs === "number" ? data.validUntilMs : Date.now() + 5 * 60 * 1000;
        if (self.expires <= Date.now()) { failed({code:"TIMEOUT"}); return; }
        self.changed(null, data);
        self.finish(null, data);
      },
      onError: failed
    }) || {};
  } catch (error) { self.subscription = null; failed(error); }
};
Source.prototype.read = function(done) {
  var self = this;
  if (self.data && self.expires > Date.now()) { done(null, self.data); return; }
  if (self.subscription && (self.data || self.error)) self.stop();
  var waiter = {done:done};
  waiter.timer = setTimeout(function() {
    var index = self.pending.indexOf(waiter);
    if (index < 0) return;
    self.pending.splice(index, 1);
    done(sourceError(self.category, {code:"TIMEOUT"}));
  }, 15000);
  self.pending.push(waiter);
  self.start();
};
Source.prototype.stop = function() {
  this.generation += 1;
  if (this.subscription && this.subscription.unsubscribe) this.subscription.unsubscribe();
  this.subscription = null;
  this.data = null;
  this.error = null;
};
module.exports = {Source:Source, text:text, number:number};
