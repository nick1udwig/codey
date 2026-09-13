import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(repositoryRoot, "docs", "config");
const outputDirectory = path.join(repositoryRoot, "build", "settings-site");
const requiredFiles = ["index.html", "app.js", "style.css"];

await Promise.all(requiredFiles.map((file) => access(path.join(sourceDirectory, file))));

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(sourceDirectory, path.join(outputDirectory, "config"), { recursive: true });

await mkdir(path.join(outputDirectory, "src", "common"), { recursive: true });
await cp(path.join(repositoryRoot, "src", "common", "endpoints.js"), path.join(outputDirectory, "src", "common", "endpoints.js"));

const configIndex = path.join(outputDirectory, "config", "index.html");
await writeFile(configIndex, (await readFile(configIndex, "utf8"))
  .replace("../../src/common/endpoints.js", "../src/common/endpoints.js"));

const redirect = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=./config/" />
    <title>codey settings</title>
  </head>
  <body>
    <p><a href="./config/">Open codey settings</a></p>
  </body>
</html>
`;

await writeFile(path.join(outputDirectory, "index.html"), redirect, "utf8");

console.log(`Built settings site at ${path.relative(repositoryRoot, outputDirectory)}/`);
