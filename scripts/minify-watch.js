"use strict";
// Use the SDK's pinned minifier API; its old CLI writes a SourceMap object to
// fs.writeFileSync, which current Node versions correctly reject.
var fs = require("fs");
var Uglify = require(process.argv[2]);
var inputMap = JSON.parse(fs.readFileSync("pebble-js-app.js.map", "utf8"));
var result = Uglify.minify(["pebble-js-app.js"], {
  compress: true,
  mangle: true,
  output: { comments: /@license|@preserve|Copyright|Licensed/ },
  inSourceMap: inputMap,
  outSourceMap: "pebble-js-app.js.map",
  outFileName: "pebble-js-app.js"
});
var map = JSON.parse(result.map);
map.sourcesContent = map.sources.map(function(source) {
  var index = inputMap.sources.map(function(name) { return name.replace(/^\.\//, ""); }).indexOf(source.replace(/^\.\//, ""));
  if (index < 0 || !inputMap.sourcesContent || inputMap.sourcesContent[index] == null) {
    throw new Error("Missing debug source: " + source);
  }
  return inputMap.sourcesContent[index];
});
fs.writeFileSync("release.js", result.code);
fs.writeFileSync("release.js.map", JSON.stringify(map));
