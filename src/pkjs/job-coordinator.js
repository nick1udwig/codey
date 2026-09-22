"use strict";

var WatchProtocol = require("../common/watch-protocol");

var JobModule = require("../common/jobs");

var JobActions = require("../common/job-actions");

var Key = WatchProtocol.Key;

// Durable data stays in Jobs; this coordinator owns presentation and action ACKs.
module.exports = function(options) {
  var selectedJob = "";
  function sendJob(job, buzz, operation) {
    var message = {};
    message[Key.messageType] = "job";
    message[Key.operation] = operation || (job.status === "checking" ? "checking" : "upsert");
    message[Key.elementId] = job.id || "";
    message[Key.title] = WatchProtocol.truncateUtf8(job.title || "Agent request", 71);
    message[Key.subtitle] = job.status || "";
    message[Key.value] = WatchProtocol.truncateUtf8(job.error || "", 179);
    message[Key.flags] = buzz && options.settings().answerVibrate ? 1 : 0;
    options.enqueue(message);
  }
  var jobManager = new JobModule.Jobs({
    storage: options.storage,
    XMLHttpRequest: options.XMLHttpRequest,
    token: function() {
      return options.settings().token;
    },
    endpoint: function() {
      return JobModule.endpoint(options.settings().endpoint);
    },
    dispatched: function() {
      var m = {};
      m[Key.messageType] = "bridge";
      m[Key.operation] = "agent-dispatched";
      options.enqueue(m);
    },
    update: function(job, buzz) {
      if (!job.opened && !(actionRunner && actionRunner.process(job))) {
        sendJob(job, buzz);
      }
    }
  });
  var actionReceipts = {};
  var actionRunner = new JobActions.Runner({
    save: function() {
      jobManager.save();
    },
    update: function(job) {
      sendJob(job, false);
    },
    complete: function(job) {
      jobManager.acknowledge(job);
      sendJob(job, false, "remove");
    },
    run: function(job, action, done) {
      if (job.endpoint !== JobModule.endpoint(options.settings().endpoint)) {
        done(new Error("Reconnect the original server to apply this action."));
        return;
      }
      if (action.attrs.type === "settings") {
        try { options.applySetting(action.attrs); }
        catch (error) { done(error); return; }
        done();
        return;
      }
      var attrs = Object.assign({}, action.attrs, {
        show: "false"
      });
      if (/^(todo|note|calendar)$/.test(attrs.type)) {
        options.collectionCommand(attrs, 0, function(ok) {
          done(ok ? null : new Error("Collection action needs attention. Open the job to retry."));
        }, job, action.index, true);
        return;
      }
      try {
        if (!job.commands[action.index]) {
          job.commands[action.index] = options.nextCommandId();
          try {
            jobManager.save();
          } catch (e) {
            delete job.commands[action.index];
            throw e;
          }
        }
        var key = job.id + ":" + action.index;
        actionReceipts[key] = done;
        var messages = WatchProtocol.encodeOperation({
          type: "capability",
          node: {
            kind: "capability",
            attrs: attrs
          },
          invocationId: job.commands[action.index]
        }, 0);
        messages.forEach(function(m) {
          m[Key.messageType] = "job-action";
          m[Key.parentId] = job.id;
          m[Key.eventSequence] = action.index;
          options.enqueue(m);
        });
      } catch (e) {
        done(e);
      }
    }
  });
  function retryJobActions() {
    Object.keys(actionReceipts).forEach(function(key) {
      delete actionRunner.busy[key.split(":")[0]];
    });
    actionReceipts = {};
    jobManager.entries.slice().forEach(function(job) {
      actionRunner.process(job);
    });
  }
  function sendJobPresented(job, requestId) {
    if (options.deliveryFailed(requestId)) {
      return;
    }
    var presented = {};
    presented[Key.messageType] = "job-result";
    presented[Key.requestId] = requestId;
    presented[Key.elementId] = job.id;
    options.enqueue(presented);
  }
  function openJob(id, cancel) {
    var cachedAction = jobManager.find(id), plan = cachedAction && JobActions.inspect(cachedAction.result || "");
    if (!cancel && cachedAction && plan && plan.onlyActions) {
      actionRunner.process(cachedAction);
      return;
    }
    selectedJob = id;
    var requestId = options.beginRequest();
    options.sendAnswerNotification(requestId, "begin");
    var callback = function(error, job) {
      if (selectedJob !== id || !options.isCurrent(requestId)) {
        return;
      }
      if (error) {
        var cached = jobManager.find(id);
        sendJob({
          id: id,
          title: cached ? cached.title : "Agent request",
          status: cached ? cached.status : "Unknown",
          error: error.message
        }, false);
        return;
      }
      if (job.status === "done" && job.result) {
        // Resume the conversation that produced this form, even if the user
        // started another thread while it was running.
        options.resumeSession(job.session);
        var pipeline = options.createPipeline(requestId, job);
        pipeline.parser.push(job.result);
        pipeline.parser.finish();
        pipeline.finishAnswer();
      } else {
        sendJob(job, false);
      }
    };
    if (cancel) {
      jobManager.cancel(id, callback);
    } else {
      jobManager.check(id, callback);
    }
  }
  return {
    send: sendJob,
    presented: sendJobPresented,
    open: openJob,
    save: function() {
      jobManager.save();
    },
    submit: function(input) {
      selectedJob = "";
      return jobManager.submit(input);
    },
    ready: function() {
      jobManager.retryAcknowledgements();
      sendJob({}, false, "reset");
      jobManager.entries.forEach(function(job) {
        if (!job.opened) sendJob(job, false);
      });
      retryJobActions();
    },
    refresh: function() {
      retryJobActions();
      jobManager.refreshAll();
    },
    dismiss: function(id) {
      var job = jobManager.find(id);
      if (job) {
        jobManager.acknowledge(job);
        sendJob(job, false, "remove");
      }
    },
    receipt: function(element, value, action) {
      var key = element + ":" + value, receipt = actionReceipts[key];
      if (receipt) {
        delete actionReceipts[key];
        receipt(action === "executed" ? null : new Error("Watch could not apply action. Open the job to retry."));
      }
    },
    deliveryError: function(message) {
      if (message && message[Key.messageType] === "job-action") {
        var key = message[Key.parentId] + ":" + message[Key.eventSequence], receipt = actionReceipts[key];
        if (receipt) {
          delete actionReceipts[key];
          receipt(new Error("Watch disconnected. Open Notifications to retry."));
        }
      }
    }
  };
};
