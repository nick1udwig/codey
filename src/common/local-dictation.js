"use strict";

// Inspired by Bibble's normalizeReference/parseReference: normalize speech,
// recognize complete phrases, then validate values before executing anything.
// Never extract a command from a larger request (negation, recurrence, etc.).
var SMALL = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
var TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function number(text) {
  if (/^\d+(?:\.\d+)?$/.test(text)) { return Number(text); }
  if (text === "a" || text === "an") { return 1; }
  var small = SMALL.indexOf(text);
  if (small >= 0) { return small; }
  var parts = text.split(" ");
  var tens = TENS.indexOf(parts[0]);
  if (tens >= 0 && parts.length <= 2) {
    var units = parts.length === 1 ? 0 : SMALL.indexOf(parts[1]);
    if (units >= 0 && units <= 9) { return (tens + 2) * 10 + units; }
  }
  var hundred = /^([a-z]+) hundred(?: (?:and )?(.+))?$/.exec(text);
  if (hundred) {
    var head = SMALL.indexOf(hundred[1]);
    var tail = hundred[2] ? number(hundred[2]) : 0;
    if (head > 0 && head < 10 && tail >= 0 && tail < 100) { return head * 100 + tail; }
  }
  return NaN;
}

function duration(text) {
  text = text.replace(/\bhalf an? (hour|minute)\b/g, "0.5 $1")
    .replace(/\b(?:a )?quarter of an? hour\b/g, "0.25 hour")
    .replace(/\b(an?|one) and a half (hours?|minutes?)\b/g, "1.5 $2");
  var part = /(\d+(?:\.\d+)?\s*|[a-z]+(?:\s+[a-z]+)*?\s+)(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?=\s|$)/g;
  var units = { s: 1, m: 60, h: 3600, d: 86400 };
  var match, end = 0, total = 0, previousUnit = Infinity;
  while ((match = part.exec(text))) {
    if (match.index !== end) { return null; }
    var amount = number(match[1].trim());
    var unit = units[match[2].charAt(0)];
    if (!isFinite(amount) || amount < 0 || unit >= previousUnit) { return null; }
    total += amount * unit;
    previousUnit = unit;
    end = part.lastIndex;
    var separator = /^(?:\s+and\s+|\s+)/.exec(text.slice(end));
    if (separator) { end += separator[0].length; part.lastIndex = end; }
  }
  return end === text.length && total >= 1 && total <= 7 * 86400 && Math.floor(total) === total ? total : null;
}

function normalize(text) {
  return text.toLowerCase().replace(/[\u2019']/g, "'")
    .replace(/\ba\.?\s*m\.?\b/g, "am").replace(/\bp\.?\s*m\.?\b/g, "pm")
    .replace(/([a-z])-(?=[a-z])/g, "$1 ")
    .replace(/(\d)-(seconds?|minutes?|hours?|days?)\b/g, "$1 $2")
    .replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim()
    .replace(/^(?:please )?(?:(?:can|could|would) you )?(?:please )?/, "")
    .replace(/(?:,? please)$/, "").trim();
}

function alarmTime(text, now) {
  var tomorrow = false, today = false;
  text = text.replace(/^(today|tomorrow) (?:at )?/, function(_, day) {
    tomorrow = day === "tomorrow"; today = !tomorrow; return "";
  });
  text = text.replace(/ (today|tomorrow)$/, function(_, day) {
    if (tomorrow || today) { return _; } // Contradictory/doubled dates fail.
    tomorrow = day === "tomorrow"; today = !tomorrow; return "";
  });
  var hour, minute = 0, match;
  if (text === "noon" || text === "midnight") { hour = text === "noon" ? 12 : 0; }
  else {
    match = /^(.+?)\s*(am|pm)$/.exec(text);
    if (match) {
      var clock = match[1].split(":");
      hour = number(clock[0]);
      minute = clock.length === 2 && /^\d{2}$/.test(clock[1]) ? Number(clock[1]) : 0;
      if (clock.length === 1 && !isFinite(hour)) {
        var spoken = /^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:oh )?(.+)$/.exec(clock[0]);
        if (spoken) { hour = number(spoken[1]); minute = number(spoken[2]); }
      }
      if (clock.length > 2 || (clock.length === 2 && !/^\d{2}$/.test(clock[1])) ||
          !isFinite(hour) || hour < 1 || hour > 12 || Math.floor(hour) !== hour) { return null; }
      hour = hour % 12 + (match[2] === "pm" ? 12 : 0);
    } else {
      // Require explicit 24-hour notation; bare "seven" is ambiguous.
      match = /^(\d{1,2}):(\d{2})$/.exec(text);
      if (!match) { return null; }
      hour = Number(match[1]); minute = Number(match[2]);
    }
  }
  if (hour > 23 || !isFinite(minute) || minute < 0 || minute > 59 || Math.floor(minute) !== minute) { return null; }
  var date = new Date(now.getTime());
  if (tomorrow) { date.setDate(date.getDate() + 1); }
  date.setHours(hour, minute, 0, 0);
  if (date <= now && !today && !tomorrow) { date.setDate(date.getDate() + 1); }
  // Don't silently shift a nonexistent clock time through a DST transition.
  if (date <= now || date.getHours() !== hour || date.getMinutes() !== minute) { return null; }
  var at = Math.floor(date.getTime() / 1000);
  return at > 0 && at <= 2147483647 ? at : null;
}

function operation(type, command, attrs) {
  attrs = attrs || {};
  attrs.type = type;
  attrs.command = command;
  return { type: "capability", node: { kind: "capability", attrs: attrs } };
}

// Calendar shortcuts require an explicit day, clock and duration. Ambiguous
// requests still go to the agent, which can ask for the missing information.
function calendarEvent(raw, now) {
  var prefix = /^(?:please )?(?:calendar\s*:|(?:make|create|add|schedule) (?:me )?(?:(?:a|an|new) )?(?:calendar )?event\s*:?)(?:\s*|$)/i.exec(raw);
  if (!prefix) { return null; }
  var value = raw.slice(prefix[0].length).trim().replace(/[.!?]+$/, "");
  if (!value) { return operation("calendar", "list"); }
  var match = /^(.+?)\s+(?:on )?(today|tomorrow|\d{4}-\d{2}-\d{2})\s+(?:at (.+?) for (.+)|(?:all[ -]day))$/i.exec(value);
  if (!match) { return null; }
  var date = new Date(now.getTime());
  var day = match[2].toLowerCase();
  if (day === "tomorrow") { date.setDate(date.getDate() + 1); }
  else if (day !== "today") {
    var parts = day.split("-").map(Number);
    date = new Date(parts[0], parts[1]-1, parts[2], 12);
    if (date.getFullYear()!==parts[0] || date.getMonth()!==parts[1]-1 || date.getDate()!==parts[2]) { return null; }
  }
  function localDay(d) { return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2); }
  var start, end;
  if (!match[3]) {
    start=localDay(date);date.setDate(date.getDate()+1);end=localDay(date);
  } else {
    var seconds=duration(normalize(match[4]));
    if (seconds===null) { return null; }
    var midnight=new Date(date.getFullYear(),date.getMonth(),date.getDate());
    var at=alarmTime("today at "+normalize(match[3]),midnight);
    if (normalize(match[3])==="midnight" || /^(?:00?:00|12\s*am)$/.test(normalize(match[3]))) { at=midnight.getTime()/1000; }
    if (at===null) { return null; }
    start=new Date(at*1000).toISOString();end=new Date(at*1000+seconds*1000).toISOString();
  }
  return operation("calendar","add",{title:match[1].trim(),start:start,end:end});
}

function parse(input, now) {
  if (typeof input !== "string" || input.length > 512) { return null; }
  var raw = input.trim();
  now = now || new Date();
  var calendar = calendarEvent(raw, now);
  if (calendar) { return calendar; }
  if (/^(?:show|open|list)(?: me)? (?:my |the )?(?:calendar|agenda|events)[.!?]?$/i.test(raw)) { return operation("calendar", "list"); }
  var noteEdit = /^(?:please )?edit (?:a |the )?note\s+(.+?)\s+to\s+(.+)$/i.exec(raw);
  if (noteEdit) { return operation("note", "edit", { match: noteEdit[1].trim(), value: noteEdit[2].trim() }); }
  if (/^(?:please )?(?:edit (?:a |the )?note|(?:show|open|list)(?: me)? (?:my |the )?notes)[.!]?$/i.test(raw)) { return operation("note", "list"); }
  var note = /^(?:please )?(?:make|create|add) (?:me )?(?:a |new |another )?note(?:\s+that|\s+saying)?\s*[:,]?\s+(.+)$/i.exec(raw) || /^note\s*:\s*(.+)$/i.exec(raw);
  if (note && note[1].trim()) { return operation("note", "add", { value: note[1].trim() }); }
  var todo = /^(?:please )?(?:add|create|make|set|put down) (?:me )?(?:(?:a|new|another) )?(?:todo|to-do|to do|2\s*d|two (?:two|do)|to o|task)(?: (?:to|for))? (.+)$/i.exec(input.trim());
  if (!todo) {
    // Match the longest command prefix before inspecting its payload. Do not
    // backtrack from an empty "to do" command into "to" with a task named "do".
    var prefix = /^(?:please )?(?:to-do|todo|to do|2\s*d|two(?: two| do)?|to o|to)(?=[:\s]|$)/i.exec(raw);
    if (prefix) {
      var payload = raw.slice(prefix[0].length).replace(/^\s*:?\s*/, "");
      if (payload) { todo = [raw, payload]; }
    }
  }
  if (todo && todo[1].trim()) { return operation("todo", "add", { value: todo[1].trim() }); }
  var text = normalize(input), match, seconds, at;
  if (/^(?:show|open|list)(?: me)? (?:my |the )?(?:todos|to-dos|to dos|tasks)$/.test(text)) { return operation("todo", "list"); }
  now = now || new Date();
  match = /^timer\s*:?\s+(?:for )?(.+)$/.exec(text) ||
    /^(?:set|start|create) (?:me )?(?:a |another |new )?timer (?:for )?(.+)$/.exec(text) ||
    /^(?:(?:set|start|create) (?:me )?(?:a |another |new )?)?(.+?) timer$/.exec(text);
  if (match && (seconds = duration(match[1])) !== null) {
    return operation("timer", "start", { duration: seconds + "s" });
  }
  match = /^(?:set|create|schedule) (?:me )?(?:an? |another |new )?(alarm|reminder) in (.+)$/.exec(text);
  if (match && (seconds = duration(match[2])) !== null) {
    return operation(match[1], "set", { "in": seconds + "s" });
  }
  match = /^remind me in (.+?) to (.+)$/.exec(text) || /^remind me to (.+) in (.+)$/.exec(text);
  if (match) {
    var firstDuration = /^remind me in /.test(text);
    seconds = duration(match[firstDuration ? 1 : 2]);
    var title = match[firstDuration ? 2 : 1];
    // Additional actions/conditions need the agent's interpretation.
    if (seconds !== null && title.length <= 60 && !/\b(and|then|every|if|unless)\b/.test(title)) {
      return operation("reminder", "set", { "in": seconds + "s", title: title });
    }
  }
  match = /^(?:(?:set|create|schedule) (?:me )?(?:an? |another |new )?alarm (?:for |at )?|wake me (?:up )?(?:at )?)(.+)$/.exec(text);
  if (match && (at = alarmTime(match[1], now)) !== null) { return operation("alarm", "set", { at: String(at) }); }
  match = /^(start|pause|stop|resume|reset|show|open) (?:a |the |my )?stopwatch$/.exec(text);
  if (match) { return operation("stopwatch", match[1] === "open" ? "show" : match[1]); }
  match = /^(?:show|list|open)(?: me)? (?:all |my |the )?(timers|alarms|reminders)$/.exec(text);
  if (match) { return operation(match[1].slice(0, -1), "list"); }
  match = /^(?:cancel|delete|clear|stop) all (?:my |the )?(timers|alarms|reminders)$/.exec(text);
  if (match) { return operation(match[1].slice(0, -1), "cancel_all"); }
  if (/^(?:(?:show|tell)(?: me)? (?:the )?|what(?:'s| is) (?:the )?)?weather(?: (?:here|now|today))?$/.test(text)) {
    return operation("weather", "current");
  }
  return null;
}

module.exports = { parse: parse };
