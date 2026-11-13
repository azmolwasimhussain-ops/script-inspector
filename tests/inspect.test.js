import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { inspectProject } from "../src/index.js";

const temporaryDirectories = [];

async function createProject(packageJson, files = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("accepts existing Node entries and declared CLI tools", async () => {
  const directory = await createProject(
    {
      name: "sample",
      scripts: { dev: "node src/index.js", lint: "eslint ." },
      devDependencies: { eslint: "^9.0.0" }
    },
    { "src/index.js": "console.log('ready')" }
  );

  const report = await inspectProject(directory);
  assert.equal(report.fatal, false);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0 });
});

test("reports a missing Node entry file as an error", async () => {
  const directory = await createProject({ scripts: { dev: "node src/missing.js" } });
  const report = await inspectProject(directory);

  assert.equal(report.summary.errors, 1);
  assert.equal(report.findings[0].code, "node-entry-not-found");
  assert.equal(report.findings[0].target, "src/missing.js");
});

test("reports a missing npm run target", async () => {
  const directory = await createProject({ scripts: { deploy: "npm run build" } });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "npm-script-not-found");
  assert.match(report.findings[0].message, /build/);
});

test("reports an empty npm script command", async () => {
  const directory = await createProject({ scripts: { test: "  " } });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "empty-script-command");
  assert.equal(report.findings[0].script, "test");
});

test("does not parse an npm run command nested under npm exec", async () => {
  const directory = await createProject({ scripts: { tool: "npm exec -- npm run build" } });
  const report = await inspectProject(directory);

  assert.equal(report.summary.errors, 0);
});

test("warns when a recognized CLI dependency is not declared", async () => {
  const directory = await createProject({ scripts: { build: "vite build" } });
  const report = await inspectProject(directory);

  assert.equal(report.summary.warnings, 1);
  assert.equal(report.findings[0].code, "cli-dependency-not-declared");
  assert.equal(report.findings[0].target, "vite");
});

test("warns about POSIX environment assignments", async () => {
  const directory = await createProject({ scripts: { start: "NODE_ENV=production node app.js" } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "posix-environment-assignment"));
});

test("returns a fatal finding for invalid package JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-bad-json-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), "{ invalid }");

  const report = await inspectProject(directory);
  assert.equal(report.fatal, true);
  assert.equal(report.findings[0].code, "package-json-invalid");
});
