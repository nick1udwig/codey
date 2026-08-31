"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var path = require("path");

var root = path.resolve(__dirname, "../..");
var outputDirectory = path.join(root, "build", "tests");
var output = path.join(outputDirectory, "native-test");

fs.mkdirSync(outputDirectory, { recursive: true });

var compile = childProcess.spawnSync("cc", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fsanitize=address,undefined",
  "-fno-omit-frame-pointer",
  "-ffunction-sections",
  "-fdata-sections",
  "-I" + path.join(root, "tests", "native", "include"),
  "-I" + path.join(root, "src", "c"),
  path.join(root, "tests", "native", "native_test.c"),
  path.join(root, "src", "c", "agent_protocol.c"),
  path.join(root, "src", "c", "agent_capabilities.c"),
  "-Wl,--gc-sections",
  "-o",
  output
], { cwd: root, encoding: "utf8" });

if (compile.stdout) { process.stdout.write(compile.stdout); }
if (compile.stderr) { process.stderr.write(compile.stderr); }
if (compile.status !== 0) { process.exit(compile.status || 1); }

var run = childProcess.spawnSync(output, [], {
  cwd: root,
  encoding: "utf8",
  env: Object.assign({}, process.env, { ASAN_OPTIONS: "detect_leaks=0" })
});
if (run.stdout) { process.stdout.write(run.stdout); }
if (run.stderr) { process.stderr.write(run.stderr); }
process.exit(run.status || 0);
