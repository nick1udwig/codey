"use strict";

var Pam = require("./pam");

var Key = Object.freeze({
  messageType: 0,
  requestId: 1,
  operation: 2,
  kind: 3,
  elementId: 4,
  parentId: 5,
  title: 6,
  subtitle: 7,
  value: 8,
  action: 9,
  meta: 10,
  flags: 11,
  index: 12
});

var CORE_ATTRS = {
  id: true,
  layout: true,
  title: true,
  label: true,
  subtitle: true,
  value: true,
  text: true,
  body: true,
  action: true,
  event: true,
  target: true,
  index: true,
  disabled: true,
  checked: true,
  destructive: true,
  primary: true,
  status: true,
  replace: true,
  selected: true
};

var MAX_VALUE_BYTES = 180;
var MAX_META_BYTES = 220;

function utf8ChunkEnd(source, start, maxBytes) {
  var index = start;
  var bytes = 0;
  var count;
  var width;
  var code;
  var next;

  while (index < source.length) {
    code = source.charCodeAt(index);
    width = 1;
    if (code < 0x80) {
      count = 1;
    } else if (code < 0x800) {
      count = 2;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      next = source.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        count = 4;
        width = 2;
      } else {
        count = 3;
      }
    } else {
      count = 3;
    }
    if (bytes && bytes + count > maxBytes) {
      break;
    }
    bytes += count;
    index += width;
  }
  return index;
}

function splitUtf8(value, maxBytes) {
  var source = String(value == null ? "" : value);
  var chunks = [];
  var start = 0;
  var end;
  do {
    end = utf8ChunkEnd(source, start, maxBytes);
    chunks.push(source.slice(start, end));
    start = end;
  } while (start < source.length);
  return chunks;
}

function truncateUtf8(value, maxBytes) {
  var source = String(value == null ? "" : value);
  return source.slice(0, utf8ChunkEnd(source, 0, maxBytes));
}

function flagsFor(attrs) {
  var flags = 0;
  function yes(name) {
    return attrs[name] === "true" || attrs[name] === "1" || attrs[name] === "yes";
  }
  if (yes("disabled")) { flags |= 1; }
  if (yes("checked")) { flags |= 2; }
  if (yes("destructive")) { flags |= 4; }
  if (yes("primary")) { flags |= 8; }
  if (yes("status")) { flags |= 16; }
  if (yes("replace")) { flags |= 32; }
  if (yes("selected")) { flags |= 64; }
  return flags;
}

function commonMessage(type, requestId, operation) {
  var message = {};
  message[Key.messageType] = type;
  message[Key.requestId] = requestId || 0;
  message[Key.operation] = operation || "";
  return message;
}

function addIf(message, key, value, maxBytes) {
  if (value == null || value === "") {
    return;
  }
  message[key] = maxBytes ? truncateUtf8(value, maxBytes) : value;
}

function addPresent(message, key, value, maxBytes, includeEmpty) {
  if (value == null || (!includeEmpty && value === "")) {
    return;
  }
  message[key] = maxBytes ? truncateUtf8(value, maxBytes) : value;
}

function attrsMeta(attrs) {
  if (attrs.action === "local.run" && truncateUtf8(attrs.task || "", 71) !== attrs.task) { throw new Error("Local task exceeds 71 bytes"); }
  var meta = Pam.formatAttributes(attrs, CORE_ATTRS);
  if ((attrs.action === "local.run" || attrs.type === "slider" || attrs.type === "dial") && splitUtf8(meta, MAX_META_BYTES).length > 1) {
    throw new Error("Interactive control metadata exceeds 220 bytes");
  }
  return truncateUtf8(meta, MAX_META_BYTES);
}

function elementMessages(operation, requestId, opName, target) {
  var node = operation.node;
  var attrs = operation.attrs || node.attrs;
  var value = attrs.value;
  var message = commonMessage("render", requestId, opName);
  var messages = [];
  var chunks;
  var index;
  var isPatch = opName === "patch";
  var title = attrs.title == null ? attrs.label : attrs.title;
  var action = attrs.action == null ? attrs.event : attrs.action;

  if (value == null) { value = attrs.text; }
  if (value == null) { value = attrs.body; }
  if (opName === "add") {
    message[Key.kind] = node.kind;
  }
  addIf(message, Key.elementId, target || attrs.id, 32);
  addIf(message, Key.parentId, node.parentId, 32);
  addPresent(message, Key.title, title, 72, isPatch);
  addPresent(message, Key.subtitle, attrs.subtitle, 100, isPatch);
  addPresent(message, Key.action, action, 48, isPatch);
  addPresent(message, Key.meta, attrsMeta(attrs), null, isPatch);
  message[Key.flags] = flagsFor(attrs);
  if (attrs.index != null && /^-?\d+$/.test(attrs.index)) {
    message[Key.index] = parseInt(attrs.index, 10);
  }

  chunks = splitUtf8(value == null ? "" : value, MAX_VALUE_BYTES);
  if (chunks[0] || (isPatch && value != null)) {
    message[Key.value] = chunks[0];
  }
  messages.push(message);
  for (index = 1; index < chunks.length; index += 1) {
    message = commonMessage("render", requestId, "append");
    message[Key.elementId] = target || attrs.id;
    message[Key.value] = chunks[index];
    messages.push(message);
  }
  return messages;
}

function encodeOperation(operation, requestId) {
  var node = operation.node;
  var attrs = node ? node.attrs : {};
  var message;
  var metaAttrs;

  if (operation.type === "header") {
    return [];
  }
  if (operation.type === "begin") {
    message = commonMessage("render", requestId, "begin");
    message[Key.kind] = attrs.layout;
    message[Key.elementId] = attrs.id;
    addIf(message, Key.title, attrs.title, 72);
    addIf(message, Key.subtitle, attrs.subtitle, 100);
    addIf(message, Key.value, attrs.status_text, MAX_VALUE_BYTES);
    addIf(message, Key.meta, attrsMeta(attrs));
    message[Key.flags] = flagsFor(attrs);
    return [message];
  }
  if (operation.type === "node") {
    return elementMessages(operation, requestId, "add");
  }
  if (operation.type === "patch") {
    return elementMessages(operation, requestId, "patch", operation.target);
  }
  if (operation.type === "remove") {
    message = commonMessage("render", requestId, "remove");
    message[Key.elementId] = operation.target;
    return [message];
  }
  if (operation.type === "end") {
    return [commonMessage("render", requestId, "end")];
  }
  if (operation.type === "agent_error") {
    message = commonMessage("status", requestId, "error");
    message[Key.value] = truncateUtf8(attrs.message || attrs.value || "Agent error", MAX_VALUE_BYTES);
    return [message];
  }
  if (operation.type === "capability") {
    message = commonMessage("capability", requestId, attrs.command);
    if (operation.invocationId) { message[Key.index] = operation.invocationId; }
    message[Key.kind] = attrs.type;
    addIf(message, Key.elementId, attrs.id, 32);
    addIf(message, Key.title, attrs.title == null ? attrs.label : attrs.title, 72);
    addIf(message, Key.subtitle, attrs.subtitle, 100);
    addIf(message, Key.value, attrs.value, MAX_VALUE_BYTES);
    metaAttrs = {};
    Object.keys(attrs).forEach(function(key) {
      if (key !== "type" && key !== "command" && key !== "id" && key !== "title" &&
          key !== "label" && key !== "subtitle" && key !== "value") {
        metaAttrs[key] = attrs[key];
      }
    });
    addIf(message, Key.meta, truncateUtf8(Pam.formatAttributes(metaAttrs), MAX_META_BYTES));
    message[Key.flags] = flagsFor(attrs);
    return [message];
  }
  return [];
}

function MessageQueue(sendFunction, options) {
  this.sendFunction = sendFunction;
  this.options = options || {};
  this.queue = [];
  this.sending = false;
  this.retryTimer = null;
  this.maxQueue = this.options.maxQueue || 96;
  this.maxRetries = this.options.maxRetries == null ? 3 : this.options.maxRetries;
  this.retryDelay = this.options.retryDelay || 150;
  this.onError = this.options.onError || function() {};
}

MessageQueue.prototype.enqueue = function(message) {
  if (this.queue.length >= this.maxQueue) {
    this.onError(new Error("watch message queue is full"), message);
    return false;
  }
  this.queue.push({ message: message, retries: 0 });
  this._flush();
  return true;
};

MessageQueue.prototype.enqueueOperation = function(operation, requestId) {
  var messages = encodeOperation(operation, requestId);
  var accepted = true;
  messages.forEach(function(message) {
    accepted = this.enqueue(message) && accepted;
  }, this);
  return accepted;
};

MessageQueue.prototype.clearRequest = function(requestId) {
  this.queue = this.queue.filter(function(entry, index) {
    return index === 0 && this.sending || entry.message[Key.requestId] !== requestId;
  }, this);
};

MessageQueue.prototype._flush = function() {
  var self = this;
  var entry;

  if (this.sending || !this.queue.length) {
    return;
  }
  entry = this.queue[0];
  this.sending = true;
  this.sendFunction(entry.message, function() {
    self.queue.shift();
    self.sending = false;
    self._flush();
  }, function(error) {
    self.sending = false;
    entry.retries += 1;
    if (entry.retries > self.maxRetries) {
      self.queue.shift();
      self.onError(error || new Error("watch message failed"), entry.message);
      self._flush();
      return;
    }
    self.retryTimer = setTimeout(function() {
      self.retryTimer = null;
      self._flush();
    }, self.retryDelay * entry.retries);
  });
};

module.exports = {
  Key: Key,
  MessageQueue: MessageQueue,
  encodeOperation: encodeOperation,
  splitUtf8: splitUtf8,
  truncateUtf8: truncateUtf8
};
