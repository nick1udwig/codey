"use strict";

function CapabilityRegistry(options) {
  this.options = options || {};
  this.handlers = Object.create(null);
}

CapabilityRegistry.prototype.register = function(name, handler) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || typeof handler !== "function") {
    throw new Error("invalid capability registration");
  }
  this.handlers[name] = handler;
  return this;
};

CapabilityRegistry.prototype.has = function(name) {
  return typeof this.handlers[name] === "function";
};

CapabilityRegistry.prototype.handle = function(operation, context) {
  var type = operation.node.attrs.type;
  var handler = this.handlers[type];
  if (!handler) {
    return false;
  }
  handler(operation.node.attrs, context || {});
  return true;
};

function registerWatchCapability(registry, name) {
  registry.register(name, function(attrs, context) {
    context.sendWatchCapability({
      type: "capability",
      node: { kind: "capability", attrs: attrs }
    });
  });
}

function installBuiltins(registry, weatherHandler) {
  registerWatchCapability(registry, "timer");
  registerWatchCapability(registry, "stopwatch");
  registerWatchCapability(registry, "reminder");
  if (weatherHandler) {
    registry.register("weather", weatherHandler);
  }
  return registry;
}

module.exports = {
  CapabilityRegistry: CapabilityRegistry,
  installBuiltins: installBuiltins,
  registerWatchCapability: registerWatchCapability
};

