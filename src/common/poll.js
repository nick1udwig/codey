"use strict";

// Explicit refreshes run immediately; unchanged/error responses back off.
function Poll(run, options) {
  options = options || {};
  this.run = run;
  this.minimum = options.minimum || 60000;
  this.maximum = options.maximum || 300000;
  this.delay = this.minimum;
  this.setTimer = options.setTimeout || setTimeout;
  this.clearTimer = options.clearTimeout || clearTimeout;
  this.timer = null;
  this.busy = false;
  this.stopped = true;
}
Poll.prototype.stop = function() {
  this.stopped = true;
  this.again = false;
  if (this.timer) this.clearTimer(this.timer);
  this.timer = null;
};
Poll.prototype.refresh = function() {
  this.stopped = false;
  this.delay = this.minimum;
  if (this.busy) { this.again = true; return; }
  this.tick();
};
Poll.prototype.tick = function() {
  var self = this, finished = false;
  if (this.timer) this.clearTimer(this.timer);
  this.timer = null;
  this.busy = true;
  function done(changed) {
    if (finished) return;
    finished = true;
    self.busy = false;
    if (self.stopped) return;
    if (self.again) { self.again = false; self.tick(); return; }
    self.delay = changed ? self.minimum : Math.min(self.maximum, self.delay * 2);
    self.timer = self.setTimer(function() { self.tick(); }, self.delay);
    if (self.timer && self.timer.unref) self.timer.unref();
  }
  try { this.run(done); } catch (_) { done(false); }
};
module.exports = Poll;
