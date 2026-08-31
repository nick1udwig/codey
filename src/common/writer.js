"use strict";

var Pam = require("./pam");
var Model = require("./model");

var INPUTS = Object.freeze([
  "up", "select", "down", "back", "tap",
  "swipe-left", "swipe-right", "swipe-up", "swipe-down"
]);

function copy(source) {
  var result = {};
  Object.keys(source || {}).forEach(function(key) { result[key] = source[key]; });
  return result;
}

function Writer(options) {
  options = options || {};
  this.onLine = options.onLine || function() {};
  this.lines = [];
  this.depth = 0;
  this.screenOpen = false;
  this._write("pam", { version: 1 }, 0);
}

Writer.prototype._write = function(kind, attrs, depth) {
  var suffix = Pam.formatAttributes(attrs || {});
  var line = new Array(depth * 2 + 1).join(" ") + kind + (suffix ? " " + suffix : "") + "\n";
  this.lines.push(line);
  this.onLine(line);
  return this;
};

Writer.prototype.beginScreen = function(id, layout, attrs) {
  var values;
  if (this.screenOpen) {
    throw new Error("a screen is already open");
  }
  if (!id || !Model.LAYOUTS[layout]) {
    throw new Error("invalid screen id or layout");
  }
  values = copy(attrs);
  values.id = id;
  values.layout = layout;
  this._write("screen", values, 0);
  this.depth = 1;
  this.screenOpen = true;
  return this;
};

Writer.prototype.element = function(kind, attrs) {
  if (!this.screenOpen || !Model.NODE_KINDS[kind]) {
    throw new Error("invalid element or no open screen");
  }
  return this._write(kind, attrs, this.depth);
};

Writer.prototype.open = function(kind, attrs) {
  this.element(kind, attrs);
  this.depth += 1;
  return this;
};

Writer.prototype.close = function() {
  if (!this.screenOpen || this.depth <= 1) {
    throw new Error("no nested element is open");
  }
  this.depth -= 1;
  return this;
};

Writer.prototype.endScreen = function() {
  if (!this.screenOpen) {
    throw new Error("no screen is open");
  }
  this.depth = 0;
  this.screenOpen = false;
  return this._write("done", {}, 0);
};

Writer.prototype.patch = function(target, attrs) {
  var values = copy(attrs);
  values.target = target;
  return this._write("patch", values, 0);
};

Writer.prototype.remove = function(target) {
  return this._write("remove", { target: target }, 0);
};

Writer.prototype.capability = function(type, command, attrs) {
  var values = copy(attrs);
  values.type = type;
  values.command = command;
  return this._write("capability", values, 0);
};

Writer.prototype.error = function(message) {
  return this._write("error", { message: message }, 0);
};

Writer.prototype.toString = function() {
  return this.lines.join("");
};

Object.keys(Model.NODE_KINDS).forEach(function(kind) {
  Writer.prototype[kind] = function(attrs) {
    return this.element(kind, attrs);
  };
});

module.exports = {
  Writer: Writer,
  Layouts: Object.freeze(Object.keys(Model.LAYOUTS)),
  Elements: Object.freeze(Object.keys(Model.NODE_KINDS)),
  Inputs: INPUTS
};

