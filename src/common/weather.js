"use strict";

var Pam = require("./pam");
var Plugin = require("./plugin-source");

function weatherIcon(code, night) {
  if (code === "sun") return night ? "moon" : "sun";
  if (code === "partly_cloudy") return night ? "night-cloud" : "partly-cloudy";
  if (code === "cloudy") return "cloud";
  if (code === "light_rain" || code === "heavy_rain" || code === "rain_and_snow") return "rain";
  if (code === "light_snow" || code === "heavy_snow") return "snow";
  return "unknown";
}

function numeric(property) {
  var value = Plugin.number(property);
  if (value === null) {
    var match = /^([+-]?\d+(?:\.\d+)?)\s*°?[CF]?$/.exec(Plugin.text(property));
    if (match) value = Number(match[1]);
  }
  return value === null ? "--" : String(Math.round(value));
}
function reading(property) {
  var value = Plugin.number(property);
  return value === null ? Plugin.text(property) || "--" : String(Math.round(value)) + (property.numericValue.unit || "");
}
function seriesAt(property, time) {
  var series = property && property.series;
  if (!series || typeof series.start !== "number" || !(series.stepSec > 0)) return null;
  var index = Math.floor((time - series.start) / series.stepSec), result = {};
  if (index < 0) return null;
  ["numericValue", "shortText", "longText"].forEach(function(shape) {
    var data = series[shape], value = data && data.values && data.values[index];
    if (value == null) return;
    result[shape] = shape === "numericValue" ? {value:value, unit:data.unit || ""} : {text:value};
  });
  return Object.keys(result).length ? result : null;
}
function properties(data) {
  var first = data && data.instances && data.instances[0];
  return first && first.properties || null;
}
function summary(data) {
  var p = properties(data);
  if (!p) return null;
  var now = Date.now() / 1000, rise = Plugin.number(p.sunrise, "timestamp"), set = Plugin.number(p.sunset, "timestamp");
  var unit = p.temperature && p.temperature.numericValue && p.temperature.numericValue.unit || "";
  if (!unit) {
    var match = /°?([CF])$/.exec(Plugin.text(p.temperature));
    if (match) unit = match[1];
  }
  return {temperature:numeric(p.temperature), unit:unit.replace("°", ""),
    high:numeric(p.high || seriesAt(p.daily_high, now)), low:numeric(p.low || seriesAt(p.daily_low, now)),
    icon:weatherIcon(Plugin.text(p.condition_code), rise !== null && set !== null && (now < rise || now >= set))};
}
function line(kind, attrs) { return "  " + kind + " " + Pam.formatAttributes(attrs) + "\n"; }
function render(data, attrs) {
  var p = properties(data), id = attrs.id || "weather", now = Date.now() / 1000;
  var result = "pam version=1\nscreen " + Pam.formatAttributes({id:id, layout:"card", title:Plugin.text(p.name) || "Weather", status:true}) + "\n";
  result += line("metric", {id:id+"-temp", label:"Now", value:reading(p.temperature)});
  result += line("text", {id:id+"-condition", value:Plugin.text(p.condition) || "Conditions unavailable"});
  if (p.feels_like) result += line("metric", {id:id+"-feels", label:"Feels", value:reading(p.feels_like)});
  if (p.wind_speed) result += line("metric", {id:id+"-wind", label:"Wind", value:reading(p.wind_speed)});
  var offset = Plugin.number(p.utc_offset) || 0;
  for (var day = 0; day < 3; day++) {
    var time = now + day * 86400;
    var high = day === 0 && p.high || seriesAt(p.daily_high, time);
    var low = day === 0 && p.low || seriesAt(p.daily_low, time);
    var condition = seriesAt(p.daily_condition, time);
    if (!high && !low && !condition) continue;
    result += line("item", {id:id+"-day-"+day, title:day === 0 ? "Today" : new Date((time+offset*60)*1000).toISOString().slice(5,10),
      subtitle:reading(high)+" / "+reading(low)+(Plugin.text(condition) ? " · "+Plugin.text(condition) : "")});
  }
  return result + "done\n";
}

function createWeatherHandler(dependencies) {
  dependencies = dependencies || {};
  var publish = dependencies.onSummary || function() {};
  var source = new Plugin.Source(dependencies.Pebble, "weather", "location", ["name", "temperature", "feels_like", "condition", "condition_code", "high", "low", "wind_speed", "utc_offset", "sunrise", "sunset", "daily_high", "daily_low", "daily_condition"], function(error, data) {
    publish(error ? null : summary(data));
  });
  function read(done) {
    source.read(function(error, data) {
      if (!error && !properties(data)) error = new Error("No weather locations. Set up Weather in the Pebble app.");
      publish(error ? null : summary(data));
      done(error, data);
    });
  }
  function handler(attrs, context) {
    if (attrs.command && attrs.command !== "current" && attrs.command !== "fetch") { context.error("Unsupported weather command"); return; }
    if (attrs.latitude != null || attrs.longitude != null || attrs.location) { context.error("Choose weather locations in the Pebble app."); return; }
    context.status("Loading weather");
    read(function(error, data) {
      if (error) context.error(error.message);
      else context.renderPam(render(data, attrs));
    });
  }
  handler.refresh = read;
  handler.source = source;
  return handler;
}
module.exports = {createWeatherHandler:createWeatherHandler, weatherIcon:weatherIcon};
