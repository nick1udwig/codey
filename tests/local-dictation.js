"use strict";
var assert = require("assert");
var parse = require("../src/common/local-dictation").parse;

module.exports = function(test) {
  test("calendar shortcuts preserve titles and require unambiguous event times", function() {
    var now=new Date(2026,8,17,12);
    ["Calendar: Café with Jo tomorrow at 3 pm for an hour", "make an event: Café with Jo tomorrow at 3 pm for an hour", "Add a calendar event Café with Jo tomorrow at 3 pm for an hour"].forEach(function(text){
      assert.deepStrictEqual(parse(text,now).node.attrs,{type:"calendar",command:"add",title:"Café with Jo",start:new Date(2026,8,18,15).toISOString(),end:new Date(2026,8,18,16).toISOString()});
    });
    assert.deepStrictEqual(parse("Calendar: Holiday on 2026-09-20 all day",now).node.attrs,{type:"calendar",command:"add",title:"Holiday",start:"2026-09-20",end:"2026-09-21"});
    assert.equal(parse("open my calendar",now).node.attrs.command,"list");
    ["Calendar: Lunch tomorrow", "make an event: Lunch tomorrow at 3 pm", "Calendar: Lunch tomorrow at seven for an hour", "Calendar: Lunch on 2026-02-30 all day", "don't make an event: Lunch tomorrow at 3 pm for an hour"].forEach(function(text){assert.equal(parse(text,now),null,text);});
  });
  test("local dictation recognizes complete timer phrases and spoken durations", function() {
    [
      ["timer 5 minutes", 300], ["Timer: thirty seconds.", 30], ["timer for 1h 2m", 3720],
      ["Set a timer for 5 seconds.", 5], ["start another timer for 60 seconds", 60],
      ["Could you please start a five-minute timer?", 300], ["twenty-five minute timer", 1500],
      ["Set me a timer for one hour and thirty minutes, please.", 5400],
      ["set a timer for one hundred and twenty seconds", 120],
      ["set a timer for 1h 2m 3s", 3723], ["start a timer for half an hour", 1800],
      ["set a timer for one and a half hours", 5400], ["set a timer for a quarter of an hour", 900],
      ["set a timer for 1.5 minutes", 90], ["set a timer for seven days", 604800]
    ].forEach(function(entry) {
      assert.deepStrictEqual(parse(entry[0]).node.attrs,
        { type: "timer", command: "start", duration: entry[1] + "s" }, entry[0]);
    });
  });
  test("local dictation handles reminder, stopwatch, schedule and weather commands", function() {
    [
      ["set an alarm in ten minutes", { type: "alarm", command: "set", "in": "600s" }],
      ["create a reminder in 30 seconds", { type: "reminder", command: "set", "in": "30s" }],
      ["remind me to drink water in twenty minutes", { type: "reminder", command: "set", "in": "1200s", title: "drink water" }],
      ["remind me in an hour to check the oven", { type: "reminder", command: "set", "in": "3600s", title: "check the oven" }],
      ["start a stopwatch", { type: "stopwatch", command: "start" }],
      ["pause the stopwatch", { type: "stopwatch", command: "pause" }],
      ["resume my stopwatch", { type: "stopwatch", command: "resume" }],
      ["reset the stopwatch", { type: "stopwatch", command: "reset" }],
      ["show my timers", { type: "timer", command: "list" }],
      ["list alarms", { type: "alarm", command: "list" }],
      ["cancel all timers", { type: "timer", command: "cancel_all" }],
      ["delete all my alarms", { type: "alarm", command: "cancel_all" }],
      ["what’s the weather today?", { type: "weather", command: "current" }]
    ].forEach(function(entry) { assert.deepStrictEqual(parse(entry[0]).node.attrs, entry[1], entry[0]); });
  });
  test("local alarms use the next explicit local clock time and calendar day", function() {
    var now = new Date(2026, 8, 11, 12, 0, 0);
    [
      ["set an alarm for 7:30 p.m.", 11, 19, 30],
      ["set an alarm at 07:30", 12, 7, 30],
      ["wake me up tomorrow at seven thirty am", 12, 7, 30],
      ["set an alarm for seven oh five am tomorrow", 12, 7, 5],
      ["set an alarm for noon", 12, 12, 0],
      ["set an alarm at midnight", 12, 0, 0],
      ["set an alarm for 12 am", 12, 0, 0],
      ["set an alarm for 12 pm tomorrow", 12, 12, 0],
      ["set an alarm for today at 13:00", 11, 13, 0]
    ].forEach(function(entry) {
      assert.deepStrictEqual(parse(entry[0], now).node.attrs, { type: "alarm", command: "set",
        at: String(new Date(2026, 8, entry[1], entry[2], entry[3], 0).getTime() / 1000) }, entry[0]);
    });
  });
  test("ambiguous, partial, unsupported and invalid dictation falls back without side effects", function() {
    ["timer", "timer 5", "timer 0 seconds", "timer 5 minutes and show weather", "timer -5 seconds", "timer 8 days", "", "don't set a timer for 5 minutes", "how do I set a timer for 5 minutes",
      "set a timer for 5 minutes and show weather", "set two timers for 5 and 10 minutes",
      "set a timer for -5 minutes", "set a timer for 0 seconds", "set a timer for 8 days",
      "set a timer for 9999999999999999999999 hours", "set a timer for 0.1 seconds",
      "set a timer for five six minutes", "set a timer for five minutes five minutes",
      "set a timer for five minutes tomorrow", "set a timer for five minutes if I ask",
      "set an alarm for seven", "set an alarm at 24:00", "set an alarm at 7:99 pm",
      "set an alarm for 0 pm", "set an alarm for 7.5 pm", "set an alarm for 7:3 pm",
      "set an alarm for seven thirty bananas pm", "set an alarm at 7 am every day",
      "set an alarm at 7 am today", "set an alarm for tomorrow at seven am today",
      "set an alarm at 7 am UTC", "cancel the timer", "pause my timer", "cancel all timers except tea",
      "remind me in five minutes to stretch and set a timer", "weather tomorrow",
      "weather in Paris", "show the stopwatch and weather", "a".repeat(513)
    ].forEach(function(text) { assert.strictEqual(parse(text, new Date(2026, 8, 11, 12)), null, text); });
  });
  test("local alarm calendar arithmetic handles DST and rejects nonexistent times", function() {
    var previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      var now = new Date(2026, 2, 7, 12);
      assert.strictEqual(parse("set an alarm for tomorrow at 2:30 am", now), null);
      assert.strictEqual(Number(parse("set an alarm for tomorrow at 7 am", now).node.attrs.at),
        new Date(2026, 2, 8, 7).getTime() / 1000);
    } finally {
      if (previous === undefined) { delete process.env.TZ; } else { process.env.TZ = previous; }
    }
  });
};
