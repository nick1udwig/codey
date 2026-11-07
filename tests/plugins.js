"use strict";

var assert = require("assert");
var Calendar = require("../src/common/calendar");
var Source = require("../src/common/plugin-source").Source;

module.exports = function(test) {
  test("calendar plugin preserves all-day dates and ignores malformed or ended events", function() {
    var request, calendar = new Calendar({subscribeToSource:function(options) { request = options; return {}; }});
    var start = Date.UTC(2099, 0, 2) / 1000;
    function event(id, from, until, allDay) { return {instanceId:id, properties:{name:{shortText:{text:id}}, starts_at:{timestamp:{value:from}}, ends_at:{timestamp:{value:until}}, all_day:{boolean:{value:allDay}}}}; }
    calendar.list("event", "active", "", "", function(error, page) {
      assert.ifError(error);
      assert.equal(page.total, 2);
      assert.equal(page.records[0].start, "2099-01-02");
      assert.equal(page.records[0].end, "2099-01-03");
      assert.equal(page.records[1].start, "2099-01-02T01:00:00.000Z");
    });
    request.onData({instances:[event("timed", start+3600, start+7200, false), event("all", start, start+86400, true), event("ended", 1, 2), event("invalid", null, start), event("reverse", start+1, start)]});
    calendar.source.stop();
  });

  test("plugin errors clear cached data, retry and recover without leaking subscriptions", function() {
    var request, calls=0, stopped=0;
    var source = new Source({subscribeToSource:function(options) {request=options;calls++;return {unsubscribe:function(){stopped++;}};}}, "calendar", "event", []);
    source.read(function(error) {assert.match(error.message, /Allow Calendar access/);});
    request.onError({code:"PERMISSION_DENIED"});
    var old=request;
    source.read(function(error,data) {assert.ifError(error);assert.equal(data.instances.length,0);});
    assert.equal(calls,2);assert.equal(stopped,1);
    old.onData({instances:[{}]});assert.equal(source.data,null);
    request.onData({instances:[]});assert.equal(source.data.instances.length,0);
    request.onError({code:"PLUGIN_UNAVAILABLE"});assert.equal(source.data,null);
    request.onData({instances:[]});assert.equal(source.error,null);
    source.stop();assert.equal(stopped,2);
  });

  test("missing plugins and expired envelopes fail without fabricated empty calendars", function() {
    var called=0;
    new Calendar({}).list("event", "active", "", "", function(error) {called++;assert.match(error.message,/Enable Plugins/);});
    var source = new Source({subscribeToSource:function(options) {options.onData({instances:[],validUntilMs:Date.now()-1});return {}; }}, "calendar", "event", []);
    source.read(function(error) {called++;assert.match(error.message,/timed out/);});
    assert.equal(called,2);
    source.stop();
  });
  test("plugin reads time out once and can receive a later update", function() {
    var originalSet=global.setTimeout, originalClear=global.clearTimeout, fire, request, calls=0;
    global.setTimeout=function(callback){fire=callback;return 1;};
    global.clearTimeout=function(){};
    var source=new Source({subscribeToSource:function(options){request=options;return {}; }},"weather","location",[]);
    try {
      source.read(function(error){calls++;assert.match(error.message,/timed out/);});
      fire();fire();assert.equal(calls,1);
      source.read(function(error,data){calls++;assert.ifError(error);assert.equal(data.instances.length,0);});
      request.onData({instances:[]});fire();assert.equal(calls,2);
    } finally {source.stop();global.setTimeout=originalSet;global.clearTimeout=originalClear;}
  });

};
