"use strict";

var Pam = require("./pam");

var WEATHER_CODES = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Heavy freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Storm with hail",
  99: "Heavy hail storm"
};

function weatherIcon(code, isDay) {
  if (code === 0 || code === 1) { return isDay === 0 ? "moon" : "sun"; }
  if (code === 2) { return isDay === 0 ? "night-cloud" : "partly-cloudy"; }
  if (code === 3 || code === 45 || code === 48) { return "cloud"; }
  if (code === 95 || code === 96 || code === 99) { return "storm"; }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) { return "snow"; }
  if (code >= 51 && code <= 82) { return "rain"; }
  return "unknown";
}

function bool(value) {
  return value === "true" || value === "1" || value === "yes";
}

function quotedLine(kind, attrs, depth) {
  var suffix = Pam.formatAttributes(attrs);
  return new Array((depth || 0) * 2 + 1).join(" ") + kind + (suffix ? " " + suffix : "") + "\n";
}

function rounded(value) {
  var number = Number(value);
  return isFinite(number) ? String(Math.round(number)) : "--";
}

function renderInline(attrs, context) {
  var id = attrs.id || "weather";
  var location = attrs.location || attrs.title || context.settings.locationLabel || "Weather";
  var unit = attrs.unit || "°";
  var pam = "pam version=1\n";
  pam += quotedLine("screen", { id: id, layout: "card", title: location, status: "true" });
  pam += quotedLine("metric", { id: id + "-temp", label: "Now", value: String(attrs.temperature || "--") + unit }, 1);
  pam += quotedLine("text", { id: id + "-condition", value: attrs.condition || "Weather" }, 1);
  if (attrs.feels) {
    pam += quotedLine("metric", { id: id + "-feels", label: "Feels", value: attrs.feels + unit }, 1);
  }
  if (attrs.high || attrs.low) {
    pam += quotedLine("item", { id: id + "-range", title: "Today", subtitle: (attrs.high || "--") + " / " + (attrs.low || "--") + unit }, 1);
  }
  if (attrs.wind) {
    pam += quotedLine("metric", { id: id + "-wind", label: "Wind", value: attrs.wind }, 1);
  }
  pam += "done\n";
  context.renderPam(pam);
}

function createWeatherHandler(dependencies) {
  dependencies = dependencies || {};
  var XHR = dependencies.XMLHttpRequest || (typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null);
  var geolocation = dependencies.geolocation || (typeof navigator !== "undefined" ? navigator.geolocation : null);

  return function weatherCapability(attrs, context) {
    var units = attrs.units || context.settings.units || "auto";
    var language = typeof navigator !== "undefined" ? navigator.language || "" : "";
    var country = language.toUpperCase().split(/[-_]/)[1] || "";
    var imperial = units === "imperial" || (units === "auto" && /^(US|LR|MM)$/.test(country));
    var latitude = Number(attrs.latitude);
    var longitude = Number(attrs.longitude);

    if (attrs.command && attrs.command !== "current" && attrs.command !== "fetch" &&
        attrs.command !== "show") {
      context.error("Unsupported weather command");
      return;
    }
    if (attrs.temperature != null) {
      renderInline(attrs, context);
      return;
    }
    if (!XHR) {
      context.error("Weather networking is unavailable");
      return;
    }

    function fetchForecast(lat, lon) {
      var request = new XHR();
      var params = [
        "latitude=" + encodeURIComponent(String(lat)),
        "longitude=" + encodeURIComponent(String(lon)),
        "current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
        "daily=weather_code,temperature_2m_max,temperature_2m_min",
        "timezone=auto",
        "forecast_days=3"
      ];
      if (imperial) {
        params.push("temperature_unit=fahrenheit", "wind_speed_unit=mph");
      }
      context.status("Loading weather");
      request.open("GET", "https://api.open-meteo.com/v1/forecast?" + params.join("&"), true);
      request.onload = function() {
        var data;
        var current;
        var daily;
        var unit;
        var pam;
        var id;
        var index;
        try {
          if (request.status < 200 || request.status >= 300) {
            throw new Error("Weather HTTP " + request.status);
          }
          data = JSON.parse(request.responseText);
          current = data.current;
          daily = data.daily;
          if (!current || !daily) {
            throw new Error("Weather response was incomplete");
          }
          id = attrs.id || "weather";
          unit = data.current_units && data.current_units.temperature_2m || (imperial ? "°F" : "°C");
          pam = "pam version=1\n";
          pam += quotedLine("screen", {
            id: id,
            layout: "card",
            title: attrs.location || context.settings.locationLabel || "Weather",
            status: "true"
          });
          pam += quotedLine("metric", { id: id + "-temp", label: "Now", value: rounded(current.temperature_2m) + unit }, 1);
          pam += quotedLine("text", { id: id + "-condition", value: WEATHER_CODES[current.weather_code] || "Weather" }, 1);
          pam += quotedLine("metric", { id: id + "-feels", label: "Feels", value: rounded(current.apparent_temperature) + unit }, 1);
          pam += quotedLine("metric", {
            id: id + "-wind",
            label: "Wind",
            value: rounded(current.wind_speed_10m) + " " + (data.current_units && data.current_units.wind_speed_10m || "")
          }, 1);
          for (index = 0; index < Math.min(3, daily.time.length); index += 1) {
            pam += quotedLine("item", {
              id: id + "-day-" + index,
              title: index === 0 ? "Today" : daily.time[index].slice(5),
              subtitle: rounded(daily.temperature_2m_max[index]) + " / " + rounded(daily.temperature_2m_min[index]) + unit +
                " · " + (WEATHER_CODES[daily.weather_code[index]] || "Weather")
            }, 1);
          }
          pam += "done\n";
          if (context.summary && typeof current.temperature_2m === "number" && isFinite(current.temperature_2m) &&
              typeof daily.temperature_2m_max[0] === "number" && typeof daily.temperature_2m_min[0] === "number") {
            context.summary({ temperature: rounded(current.temperature_2m), high: rounded(daily.temperature_2m_max[0]),
              low: rounded(daily.temperature_2m_min[0]), unit: imperial ? "F" : "C",
              icon: weatherIcon(current.weather_code, current.is_day), updated: Date.now() });
          }
          context.renderPam(pam);
        } catch (error) {
          context.error(error.message || "Weather failed");
        }
      };
      request.timeout = 15000;
      request.ontimeout = function() { context.error("Weather request timed out"); };
      request.onerror = function() {
        context.error("Could not load weather");
      };
      request.send();
    }

    if (isFinite(latitude) && isFinite(longitude)) {
      fetchForecast(latitude, longitude);
      return;
    }
    if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
      context.error("Current location is unavailable");
      return;
    }
    context.status("Finding location");
    geolocation.getCurrentPosition(function(position) {
      fetchForecast(position.coords.latitude, position.coords.longitude);
    }, function() {
      context.error("Location permission is required for weather");
    }, {
      enableHighAccuracy: false,
      maximumAge: 15 * 60 * 1000,
      timeout: 15000
    });
  };
}

module.exports = {
  WEATHER_CODES: WEATHER_CODES,
  weatherIcon: weatherIcon,
  createWeatherHandler: createWeatherHandler,
  renderInline: renderInline
};
