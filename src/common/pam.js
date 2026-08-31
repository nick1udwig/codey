"use strict";

// Pebble Agent Markup (PAM) is deliberately smaller than YAML or TOML. One
// complete line is one complete tree node, which means consumers can render a
// response as soon as its first newline arrives.

var KIND_RE = /^[a-z][a-z0-9_-]*$/;
var KEY_RE = /^[a-z][a-z0-9_-]*$/;

function utf8ByteLength(value) {
  var source = String(value == null ? "" : value);
  var bytes = 0;
  var index;
  var code;
  var next;
  for (index = 0; index < source.length; index += 1) {
    code = source.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      next = source.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        // UTF-8 encoders replace an unpaired surrogate with U+FFFD.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function PamError(message, line, column) {
  this.name = "PamError";
  this.message = message;
  this.line = line || 0;
  this.column = column || 0;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, PamError);
  }
}

PamError.prototype = Object.create(Error.prototype);
PamError.prototype.constructor = PamError;

function decodeEscape(source, index, lineNumber) {
  var marker = source.charAt(index);
  var hex;

  if (marker === "n") { return { value: "\n", next: index + 1 }; }
  if (marker === "r") { return { value: "\r", next: index + 1 }; }
  if (marker === "t") { return { value: "\t", next: index + 1 }; }
  if (marker === "\\") { return { value: "\\", next: index + 1 }; }
  if (marker === "\"") { return { value: "\"", next: index + 1 }; }
  if (marker === "'") { return { value: "'", next: index + 1 }; }
  if (marker === "u") {
    hex = source.slice(index + 1, index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new PamError("invalid unicode escape", lineNumber, index + 1);
    }
    return { value: String.fromCharCode(parseInt(hex, 16)), next: index + 5 };
  }
  throw new PamError("unsupported escape \\" + marker, lineNumber, index + 1);
}

function readQuoted(source, index, lineNumber) {
  var quote = source.charAt(index);
  var value = "";
  var escaped;

  index += 1;
  while (index < source.length) {
    if (source.charAt(index) === quote) {
      return { value: value, next: index + 1 };
    }
    if (source.charAt(index) === "\\") {
      index += 1;
      if (index >= source.length) {
        throw new PamError("unfinished escape", lineNumber, index + 1);
      }
      escaped = decodeEscape(source, index, lineNumber);
      value += escaped.value;
      index = escaped.next;
    } else {
      value += source.charAt(index);
      index += 1;
    }
  }
  throw new PamError("unterminated quoted value", lineNumber, source.length);
}

function parseLine(source, lineNumber, options) {
  var spaces = 0;
  var depth;
  var index;
  var start;
  var kind;
  var key;
  var parsed;
  var value;
  var attrs = Object.create(null);
  var maxDepth = options.maxDepth == null ? 8 : options.maxDepth;

  if (utf8ByteLength(source) > (options.maxLineLength || 2048)) {
    throw new PamError("line is too long", lineNumber, 1);
  }
  if (!source.trim() || /^\s*#/.test(source)) {
    return null;
  }
  while (source.charAt(spaces) === " ") {
    spaces += 1;
  }
  if (source.charAt(spaces) === "\t") {
    throw new PamError("tabs are not valid indentation", lineNumber, spaces + 1);
  }
  if (spaces % 2 !== 0) {
    throw new PamError("indentation must use pairs of spaces", lineNumber, spaces + 1);
  }
  depth = spaces / 2;
  if (depth > maxDepth) {
    throw new PamError("maximum nesting depth exceeded", lineNumber, spaces + 1);
  }

  index = spaces;
  start = index;
  while (index < source.length && !/\s/.test(source.charAt(index))) {
    index += 1;
  }
  kind = source.slice(start, index);
  if (!KIND_RE.test(kind)) {
    throw new PamError("invalid node kind", lineNumber, start + 1);
  }

  while (index < source.length) {
    while (index < source.length && /\s/.test(source.charAt(index))) {
      index += 1;
    }
    if (index >= source.length || source.charAt(index) === "#") {
      break;
    }

    start = index;
    while (index < source.length && /[a-z0-9_-]/.test(source.charAt(index))) {
      index += 1;
    }
    key = source.slice(start, index);
    if (!KEY_RE.test(key) || source.charAt(index) !== "=") {
      throw new PamError("expected name=value attribute", lineNumber, start + 1);
    }
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      throw new PamError("duplicate attribute " + key, lineNumber, start + 1);
    }
    index += 1;
    if (index >= source.length) {
      value = "";
    } else if (source.charAt(index) === "\"" || source.charAt(index) === "'") {
      parsed = readQuoted(source, index, lineNumber);
      value = parsed.value;
      index = parsed.next;
      if (index < source.length && !/\s/.test(source.charAt(index))) {
        throw new PamError("quoted value must end at whitespace", lineNumber, index + 1);
      }
    } else {
      start = index;
      while (index < source.length && !/\s/.test(source.charAt(index))) {
        index += 1;
      }
      value = source.slice(start, index);
    }
    attrs[key] = value;
  }

  return {
    kind: kind,
    attrs: attrs,
    depth: depth,
    line: lineNumber,
    source: source
  };
}

function PamParser(options) {
  this.options = options || {};
  this.buffer = "";
  this.lineNumber = 0;
  this.stack = [];
  this.headerSeen = false;
  this.finished = false;
  this.failed = false;
  this.onNode = this.options.onNode || function() {};
  this.onError = this.options.onError || null;
}

PamParser.prototype._acceptLine = function(source) {
  var node;
  var parent;

  this.lineNumber += 1;
  if (this.failed) {
    return;
  }
  try {
    node = parseLine(source.replace(/\r$/, ""), this.lineNumber, this.options);
    if (!node) {
      return;
    }
    if (node.depth > this.stack.length) {
      throw new PamError("node skips a parent indentation level", node.line, 1);
    }
    if (node.kind === "pam") {
      if (node.depth !== 0 || this.headerSeen) {
        throw new PamError("pam header must be the first root node", node.line, 1);
      }
      if (node.attrs.version !== "1") {
        throw new PamError("unsupported PAM version", node.line, 1);
      }
      this.headerSeen = true;
      this.stack = [];
      this.onNode(node);
      return;
    }
    if (!this.headerSeen && this.options.requireHeader !== false) {
      throw new PamError("response must start with pam version=1", node.line, 1);
    }

    this.stack.length = node.depth;
    parent = node.depth ? this.stack[node.depth - 1] : null;
    node.parent = parent;
    node.path = parent ? parent.path + "/" + (node.attrs.id || node.kind) : (node.attrs.id || node.kind);
    this.stack[node.depth] = node;
    this.onNode(node);
  } catch (error) {
    if (!(error instanceof PamError)) {
      error = new PamError(error.message || String(error), this.lineNumber, 1);
    }
    if (this.onError) {
      this.failed = true;
      this.onError(error);
      return;
    }
    throw error;
  }
};

PamParser.prototype.push = function(chunk) {
  var newline;
  var error;
  var maxLineLength = this.options.maxLineLength || 2048;

  if (this.finished) {
    throw new PamError("cannot push after finish", this.lineNumber, 1);
  }
  if (this.failed) {
    return;
  }
  this.buffer += String(chunk == null ? "" : chunk);
  while ((newline = this.buffer.indexOf("\n")) !== -1) {
    this._acceptLine(this.buffer.slice(0, newline));
    this.buffer = this.buffer.slice(newline + 1);
  }
  if (!this.failed && utf8ByteLength(this.buffer) > maxLineLength) {
    error = new PamError("line is too long", this.lineNumber + 1, 1);
    if (this.onError) {
      this.failed = true;
      this.buffer = "";
      this.onError(error);
      return;
    }
    throw error;
  }
};

PamParser.prototype.finish = function() {
  if (this.finished) {
    return;
  }
  if (this.buffer.length) {
    this._acceptLine(this.buffer);
  }
  this.buffer = "";
  this.finished = true;
};

function escapeValue(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function formatAttributes(attrs, omitted) {
  var keys = Object.keys(attrs || {}).sort();
  var output = [];
  var index;
  var key;
  var value;

  omitted = omitted || {};
  for (index = 0; index < keys.length; index += 1) {
    key = keys[index];
    if (omitted[key] || attrs[key] == null) {
      continue;
    }
    value = String(attrs[key]);
    if (/^[A-Za-z0-9._:+\/-]*$/.test(value)) {
      output.push(key + "=" + value);
    } else {
      output.push(key + "=\"" + escapeValue(value) + "\"");
    }
  }
  return output.join(" ");
}

module.exports = {
  Error: PamError,
  Parser: PamParser,
  parseLine: parseLine,
  formatAttributes: formatAttributes,
  escapeValue: escapeValue,
  utf8ByteLength: utf8ByteLength
};
