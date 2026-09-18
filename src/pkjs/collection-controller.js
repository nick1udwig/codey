"use strict";

var Endpoints = require("../common/endpoints");

var WatchProtocol = require("../common/watch-protocol");

var Poll = require("../common/poll");

var CollectionClient = require("../common/collections/client").Client;

var CollectionViews = require("../common/collection-views");

var Key = WatchProtocol.Key;

// Owns collection state; request ownership and transport remain with the bridge.
module.exports = function(options) {
  var collections = null, collectionViews = null, collectionError = "", collectionCounts = {};
  function collectionBase() {
    return (Endpoints.normalize(options.settings().endpoint) || "").replace(/\/v1\/agent$/, "").replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  }
  try {
    collections = new (options.Client || CollectionClient)({
      storage: options.storage,
      XMLHttpRequest: options.XMLHttpRequest,
      base: collectionBase,
      token: function() {
        return options.settings().token;
      },
      allowHTTP: function() {
        return options.settings().collectionDevelopmentHTTP;
      }
    });
    collectionViews = new CollectionViews(collections);
    collections.journal.bridge(Date.now().toString(36) + "-" + Math.floor(Math.random() * 16777215).toString(36));
  } catch (e) {
    collectionError = e.message;
  }
  function collectionHandshake() {
    collectionCounts = {};
    if (!collections) return;
    var m = {};
    m[Key.messageType] = "bridge";
    m[Key.operation] = "collections";
    m[Key.collectionProtocol] = 1;
    m[Key.bridgeSession] = collections.journal.data.bridge;
    options.enqueue(m);
  }
  var collectionPoll = new Poll(function(done) {
    if (!collections || !collectionBase() || !options.settings().token) {
      done(false);
      return;
    }
    collections.connect(function(e) {
      if (e) {
        done(false);
        return;
      }
      var counts = {
        task: 0,
        note: 0,
        event: 0
      }, changed = false;
      collections.collections.forEach(function(c) {
        counts[c.kind] = c.count || 0;
      });
      Object.keys(counts).forEach(function(kind) {
        if (counts[kind] !== collectionCounts[kind]) changed = true;
      });
      if (changed) {
        var m = {};
        m[Key.messageType] = "bridge";
        m[Key.operation] = "collection-counts";
        m[Key.index] = counts.task;
        m[Key.flags] = counts.note;
        m[Key.eventSequence] = counts.event;
        collectionCounts = counts;
        options.enqueue(m);
      }
      collections.drain();
      done(changed || collections.journal.data.entries.some(function(e) {
        return !e.receipt;
      }));
    });
  });
  function syncCollections() {
    if (!collections || !collectionBase() || !options.settings().token) {
      collectionPoll.stop();
      return;
    }
    collectionPoll.refresh();
  }
  function collectionAck(payload, state, text) {
    var m = {};
    m[Key.messageType] = "collection-ack";
    m[Key.bridgeSession] = String(options.read(payload, Key.bridgeSession, "BridgeSession") || "");
    m[Key.eventSequence] = Number(options.read(payload, Key.eventSequence, "EventSequence") || 0);
    m[Key.deliveryState] = state;
    m[Key.value] = text;
    if (state === "rejected") m[Key.errorCode] = /stale|session|view/i.test(text) ? "stale_view" : /reused/i.test(text) ? "idempotency_mismatch" : "invalid_input";
    options.enqueue(m);
  }
  function renderCollection(requestId, error, view) {
    if (!options.isCurrent(requestId)) return;
    if (error) {
      options.sendStatus(error.message, "error", requestId);
      return;
    }
    var m = {};
    m[Key.requestId] = requestId;
    m[Key.viewToken] = view.token;
    if (view.list) {
      var list = view.list;
      m[Key.messageType] = "collection-list";
      m[Key.operation] = list.kind;
      m[Key.value] = list.titles.join("\n");
      m[Key.meta] = list.states;
      m[Key.index] = list.total;
      if (list.kind === "event") m[Key.title] = list.timeline.join("\n");
      m[Key.flags] = (list.state === "completed" ? 1 : 0) | (list.next ? 2 : 0) | (list.stale ? 4 : 0) | (list.partial ? 8 : 0) | (list.first ? 16 : 0);
      if (list.kind === "event") m[Key.flags] |= (list.previous ? 32 : 0) | Math.max(0, Math.min(7, list.focus || 0)) << 8;
      m[Key.subtitle] = list.stale ? "Cached · Server unavailable" : list.pending ? list.pending + " pending server" : list.partial ? "First 8 · More after sync" : "Saved on server";
      // A list may change the watch count optimistically, or be superseded before delivery.
      if (list.state !== "completed" && collectionCounts[list.kind] !== list.total) delete collectionCounts[list.kind];
      options.enqueue(m);
    } else {
      m[Key.messageType] = "collection-view";
      options.enqueue(m);
      options.capabilityContext(requestId).renderPam(view.source);
    }
    options.sendAnswerNotification(requestId, "complete", true);
  }
  function handleCollectionRequest(kind, action, id, value, token, payload) {
    var requestId = options.beginRequest();
    options.sendAnswerNotification(requestId, "begin", true, token);
    if (!collections) {
      options.sendStatus(collectionError || "Collections unavailable", "error", requestId);
      return;
    }
    var started = Date.now(), viewToken = String(options.read(payload, Key.viewToken, "ViewToken") || ""), done = function(e, v) {
      options.log("collection read " + kind + " " + action + " ms=" + (Date.now() - started));
      renderCollection(requestId, e, v);
    };
    try {
      if (action === "list" || action === "archive") {
        if ((value === "return" || value === "previous") && kind === "event") {
          var previous = collectionViews.resolve(viewToken, value === "return" ? "back" : "previous");
          collectionViews.list(kind, previous.state, previous.snapshot, previous.cursor, function(e, v) {
            if (v) v.list.focus = value === "previous" ? Math.max(0, v.list.titles.length - 1) : previous.focus;
            done(e, v);
          });
        } else if (value === "next") {
          var page = collectionViews.resolve(viewToken, "next");
          collectionViews.list(kind, page.state, page.snapshot, page.cursor, done);
        } else collectionViews.list(kind, action === "archive" ? "completed" : "active", "", "", done);
        collections.drain();
        return;
      }
      var session = String(options.read(payload, Key.bridgeSession, "BridgeSession") || ""), seq = Number(options.read(payload, Key.eventSequence, "EventSequence") || 0), ingress = "watch:" + session + ":" + seq;
      var receipt = collections.journal.data.receipts[ingress];
      if (receipt) {
        if (receipt.alias !== id || receipt.view !== viewToken || receipt.operation.type !== {
          edit: "note.replace",
          append: "note.append",
          complete: "task.complete",
          restore: "task.restore"
        }[action] || JSON.stringify(receipt.operation.payload) !== JSON.stringify(action === "edit" ? {
          body: value,
          whole_note: true
        } : action === "append" ? {
          text: value
        } : {})) throw new Error("Event identity reused with different input.");
        collectionAck(payload, "accepted_phone", "Saved on phone · Pending server");
        collections.drain();
        return;
      }
      var target = collectionViews.resolve(viewToken, id);
      if (action === "read") {
        collectionViews.body(target.record, target.cursor || "", done);
        return;
      }
      if (session !== collections.journal.data.bridge || seq <= 0) throw new Error("Stale collection session.");
      var type = {
        edit: "note.replace",
        append: "note.append",
        complete: "task.complete",
        restore: "task.restore"
      }[action];
      if (!type || (target.record.capabilities || []).indexOf(type) < 0) throw new Error("Action unavailable for this record.");
      var col = collections.collection(kind);
      var accepted = collections.accept({
        alias: id,
        view: viewToken,
        ingress: ingress,
        collection_id: col.id,
        generation: col.binding_generation,
        record_id: target.record.id,
        revision: target.record.revision,
        type: type,
        payload: action === "edit" ? {
          body: value,
          whole_note: true
        } : action === "append" ? {
          text: value
        } : {}
      });
      collectionAck(payload, "accepted_phone", "Saved on phone · Pending server");
      collections.drain(function(e, data) {
        if (!e && data && data.results.some(function(r) {
          return r.operation_id === accepted.id && r.durably_recorded && r.outcome === "applied";
        })) collectionAck(payload, "accepted_server", "Saved on server"); else if (!e && data && data.results.some(function(r) {
          return r.operation_id === accepted.id && r.durably_recorded;
        })) collectionAck(payload, "needs_attention", "Needs attention in server settings");
      });
      collectionViews.list(kind, target.state || "active", target.snapshot || "", target.cursor || "", function(e, v) {
        if (e) {
          options.sendStatus("Saved on phone · Pending server. List unavailable.", "show", requestId);
          options.sendAnswerNotification(requestId, "complete", true);
        } else done(null, v);
      }, true);
    } catch (e) {
      collectionAck(payload, "rejected", e.message);
      options.sendStatus(e.message, "error", requestId);
    }
  }
  function phoneCollection(attrs, requestId, complete, job, commandIndex, background) {
    if (!collections) {
      options.sendStatus(collectionError || "Collections unavailable", "error", requestId);
      if (complete) complete(false);
      return;
    }
    collections.ensure(function(e) {
      if (e) {
        options.sendStatus(e.message, "error", requestId);
        if (complete) complete(false);
        return;
      }
      phoneCollectionReady(attrs, requestId, complete, job, commandIndex, background);
    });
  }
  function phoneCollectionReady(attrs, requestId, complete, job, commandIndex, background) {
    var kind = attrs.type === "calendar" ? "event" : attrs.type === "todo" ? "task" : "note";
    function finish(e, op) {
      if (background) {
        if (e) {
          if (complete) complete(false);
          return;
        }
        collections.drain(function() {});
        if (complete) complete(true);
        return;
      }
      if (e) {
        options.sendStatus(e.message, "error", requestId);
        if (complete) complete(false);
        return;
      }
      var delivery = "Saved on phone · Pending server";
      collections.drain(function(error, data) {
        if (error || !op || !data) return;
        data.results.forEach(function(r) {
          if (r.operation_id === op.id && r.durably_recorded) {
            delivery = r.outcome === "applied" ? "Saved on server" : "Needs attention in server settings";
            if (options.isCurrent(requestId)) options.sendStatus(delivery, "show", requestId);
          }
        });
      });
      collectionViews.list(kind, "active", "", "", function(e, v) {
        if (e && op) {
          options.sendStatus(delivery + " · List unavailable", "show", requestId);
          options.sendAnswerNotification(requestId, "complete", true);
          if (complete) complete(true);
          return;
        }
        renderCollection(requestId, e, v);
        if (op) options.sendStatus(delivery, "show", requestId);
        if (complete) complete(!e);
      });
    }
    try {
      if (!collections) throw new Error(collectionError);
      if (attrs.command === "list" || attrs.command === "archive") {
        collectionViews.list(kind, attrs.command === "archive" ? "completed" : "active", "", "", function(e, v) {
          renderCollection(requestId, e, v);
          if (complete) complete(!e);
        });
        return;
      }
      if (attrs.command !== "add") throw new Error("Open the collection and choose a record to edit.");
      var col = collections.collection(kind), scope = collections.journal.data.scope;
      var input = {
        ingress: job ? "agent:" + scope.server_instance_id + ":" + job.id + ":" + commandIndex : "direct:" + scope.client_id + ":" + options.nextCommandId(),
        collection_id: col.id,
        generation: col.binding_generation,
        type: kind + ".create",
        payload: kind === "event" ? {
          title: String(attrs.title || attrs.value || ""),
          start: String(attrs.start || ""),
          end: String(attrs.end || ""),
          location: String(attrs.location || ""),
          description: String(attrs.description || "")
        } : kind === "note" ? {
          title: WatchProtocol.truncateUtf8(String(attrs.title || attrs.value).replace(/\s+/g, " "), 71),
          body: String(attrs.value || ""),
          body_format: "plain"
        } : {
          title: String(attrs.value || attrs.title || "")
        }
      };
      if (job) collections.agent(input, finish); else finish(null, collections.accept(input));
    } catch (e) {
      finish(e);
    }
  }
  return {
    handshake: collectionHandshake,
    resetCounts: function() {
      collectionCounts = {};
    },
    ready: function() {
      if (collections) collections.journal.bridge(Date.now().toString(36) + "-" + Math.floor(Math.random() * 16777215).toString(36));
      collectionHandshake();
      syncCollections();
    },
    sync: syncCollections,
    handle: handleCollectionRequest,
    command: phoneCollection,
    recover: function() {
      if (collections) collections.recover(function(e) {
        options.sendStatus(e ? e.message : "Pending input archived for recovery. Reopen collections.", e ? "error" : "show");
        if (!e) syncCollections();
      }); else syncCollections();
    },
    setup: function(done) {
      if (!collections || !collectionBase() || !options.settings().token) {
        done(null, null);
        return;
      }
      collections.request("POST", "/v1/integration-setup-sessions", {
        public_url: collectionBase()
      }, function(e, setup) {
        var base = collectionBase();
        if (!e && (!setup || setup.url !== base + "/integrations/setup-api" || !setup.token)) e = new Error("Invalid sync setup destination");
        done(e, setup);
      });
    }
  };
};