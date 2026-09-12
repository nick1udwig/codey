"use strict";

var LAYOUTS = {
  text: true,
  list: true,
  menu: true,
  grid: true,
  card: true,
  progress: true,
  form: true,
  choice: true,
  modal: true
};

var NODE_KINDS = {
  section: true,
  item: true,
  text: true,
  metric: true,
  progress: true,
  field: true,
  choice: true,
  action: true,
  bind: true,
  image: true,
  spacer: true,
  hotspot: true
};

function ModelError(message, node) {
  this.name = "ModelError";
  this.message = message;
  this.line = node ? node.line : 0;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, ModelError);
  }
}

ModelError.prototype = Object.create(Error.prototype);
ModelError.prototype.constructor = ModelError;

function cloneAttrs(attrs) {
  var clone = {};
  Object.keys(attrs || {}).forEach(function(key) {
    clone[key] = attrs[key];
  });
  return clone;
}

function ScreenModel(options) {
  this.options = options || {};
  this.onOperation = this.options.onOperation || function() {};
  this.onError = this.options.onError || null;
  this.activeScreen = null;
  this.elements = Object.create(null);
  this.generatedId = 0;
  this.failed = false;
}

ScreenModel.prototype._fail = function(message, node) {
  var error = new ModelError(message, node);
  if (this.onError) {
    this.failed = true;
    this.onError(error);
    return false;
  }
  throw error;
};

ScreenModel.prototype._emit = function(type, node, extra) {
  var operation = extra || {};
  operation.type = type;
  operation.node = node;
  operation.screen = this.activeScreen;
  this.onOperation(operation);
};

ScreenModel.prototype._idFor = function(node) {
  var id = node.attrs.id;
  if (!id) {
    this.generatedId += 1;
    id = "_" + node.kind + String(this.generatedId);
    node.attrs.id = id;
  }
  return id;
};

ScreenModel.prototype.accept = function(node) {
  var id;
  var target;
  var parent;
  var attrs;

  if (this.failed) {
    return;
  }
  if (node.kind === "pam") {
    this._emit("header", node);
    return;
  }
  if (node.kind === "screen") {
    if (node.depth !== 0) {
      this._fail("screen must be a root node", node);
      return;
    }
    if (!node.attrs.id) {
      this._fail("screen requires id", node);
      return;
    }
    if (!LAYOUTS[node.attrs.layout]) {
      this._fail("unsupported screen layout " + (node.attrs.layout || ""), node);
      return;
    }
    this.activeScreen = {
      id: node.attrs.id,
      layout: node.attrs.layout,
      attrs: cloneAttrs(node.attrs)
    };
    this.needsAnswer = node.attrs.layout === "choice" || node.attrs.layout === "form";
    this.elements = Object.create(null);
    this.elements[node.attrs.id] = node;
    this._emit("begin", node);
    return;
  }
  if (node.kind === "capability") {
    if (node.depth !== 0) {
      this._fail("capability must be a root node", node);
      return;
    }
    if (!node.attrs.type || !node.attrs.command) {
      this._fail("capability requires type and command", node);
      return;
    }
    this._emit("capability", node);
    this.activeScreen = null;
    this.elements = Object.create(null);
    return;
  }
  if (node.kind === "patch") {
    target = node.attrs.target;
    if (!target || !this.elements[target]) {
      this._fail("patch target does not exist", node);
      return;
    }
    var existing = this.elements[target];
    var interactive = existing.attrs.action === "local.run" || existing.attrs.type === "slider" || existing.attrs.type === "dial";
    if (interactive || node.attrs.action === "local.run" || node.attrs.type === "slider" || node.attrs.type === "dial") {
      if (!Object.keys(node.attrs).every(function(key) { return ["target", "value", "title"].indexOf(key) >= 0; })) {
        this._fail("Interactive definitions require a new screen", node); return;
      }
      if (node.attrs.value != null && (!/^\d+$/.test(node.attrs.value) || +node.attrs.value < +(existing.attrs.min || 1) || +node.attrs.value > +(existing.attrs.max || 604800))) {
        this._fail("Invalid control value", node); return;
      }
    }
    attrs = cloneAttrs(node.attrs);
    delete attrs.target;
    Object.keys(attrs).forEach(function(key) {
      this.elements[target].attrs[key] = attrs[key];
    }, this);
    this._emit("patch", node, {
      target: target,
      attrs: cloneAttrs(this.elements[target].attrs)
    });
    return;
  }
  if (node.kind === "remove") {
    target = node.attrs.target;
    if (!target || !this.elements[target]) {
      this._fail("remove target does not exist", node);
      return;
    }
    delete this.elements[target];
    this._emit("remove", node, { target: target });
    return;
  }
  if (node.kind === "done") {
    if (this.activeScreen) {
      var ids = Object.keys(this.elements);
      var hasAnswer = ids.some(function(key) { return this.elements[key].attrs.action === "local.answer"; }, this);
      if (this.needsAnswer && !hasAnswer) {
        if (ids.length >= 49) { this._fail("Form must leave room for Dictate answer", node); return; }
        var answerId = "_dictate_answer";
        while (this.elements[answerId]) { answerId += "_"; }
        this.accept({ kind: "action", depth: 1, attrs: { id: answerId, title: "Dictate answer", action: "local.answer" },
          parent: this.elements[this.activeScreen.id] });
      }
      this._emit("end", node);
    }
    return;
  }
  if (node.kind === "error") {
    this._emit("agent_error", node);
    return;
  }
  if (!NODE_KINDS[node.kind]) {
    this._fail("unsupported node kind " + node.kind, node);
    return;
  }
  if (!this.activeScreen) {
    this._fail(node.kind + " appears before a screen", node);
    return;
  }
  if (node.kind === "field" || node.kind === "choice") { this.needsAnswer = true; }
  if (node.kind === "field" && (node.attrs.type === "slider" || node.attrs.type === "dial")) {
    var a = node.attrs;
    if (![a.min, a.max, a.step, a.value].every(function(v) { return /^-?\d+$/.test(String(v)); }) ||
        +a.min < 0 || +a.max > 604800 || +a.min >= +a.max || +a.step < 1 || +a.step > +a.max - +a.min ||
        +a.value < +a.min || +a.value > +a.max) { this._fail("Invalid control range", node); return; }
  }
  if (node.attrs.action === "local.run") {
    var local = node.attrs;
    if (["timer", "reminder", "alarm"].indexOf(local.capability) < 0 || !local.task ||
        !(local.seconds === "$value" && node.kind === "field") && !(/^[0-9]+$/.test(local.seconds) && +local.seconds >= 1 && +local.seconds <= 604800)) {
      this._fail("Invalid local action", node); return;
    }
  }
  if (node.attrs.action === "local.submit") {
    var control = this.elements[node.attrs.control];
    if (!control || control.kind !== "field" || ["slider", "dial"].indexOf(control.attrs.type) < 0) {
      this._fail("Submit requires an existing slider or dial", node); return;
    }
  }
  id = this._idFor(node);
  if (this.elements[id]) {
    this._fail("duplicate element id " + id, node);
    return;
  }
  parent = node.parent;
  while (parent && parent.kind === "pam") {
    parent = parent.parent;
  }
  node.parentId = parent && parent.attrs && parent.attrs.id ? parent.attrs.id : this.activeScreen.id;
  this.elements[id] = node;
  this._emit("node", node);
};

module.exports = {
  Error: ModelError,
  ScreenModel: ScreenModel,
  LAYOUTS: LAYOUTS,
  NODE_KINDS: NODE_KINDS
};
