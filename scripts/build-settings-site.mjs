import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
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

const redirect = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=./config/" />
    <title>Pebble Agent settings</title>
  </head>
  <body>
    <p><a href="./config/">Open Pebble Agent settings</a></p>
  </body>
</html>
`;

await writeFile(path.join(outputDirectory, "index.html"), redirect, "utf8");

console.log(`Built settings site at ${path.relative(repositoryRoot, outputDirectory)}/`);
