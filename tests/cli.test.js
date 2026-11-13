const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { afterEach, test } = require("node:test");

const cliPath = path.join(__dirname, "..", "bin", "script-inspector.js");
const temporaryDirectories = [];

async function createProject(packageJson) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-cli-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2));
  return directory;
}

async function createProjectWithRawPackageJson(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-cli-json-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), source);
  return directory;
}

function runCli(directory, ...argumentsList) {
  return spawnSync(process.execPath, [cliPath, directory, ...argumentsList], { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("prints findings and returns code 1 for script errors", async () => {
  const directory = await createProject({ scripts: { dev: "node src/missing.js" } });
  const result = runCli(directory);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /node-entry-not-found/);
});

test("prints JSON and strict mode fails on warnings", async () => {
  const directory = await createProject({ scripts: { build: "vite build" } });
  const jsonResult = runCli(directory, "--json");
  const report = JSON.parse(jsonResult.stdout);

  assert.equal(jsonResult.status, 0);
  assert.equal(report.findings[0].code, "cli-dependency-not-declared");

  const strictResult = runCli(directory, "--strict");
  assert.equal(strictResult.status, 1);
});

test("returns code 2 and a JSON finding when package.json is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-cli-no-package-"));
  temporaryDirectories.push(directory);
  const result = runCli(directory, "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 2);
  assert.equal(report.findings[0].code, "package-json-not-found");
});

test("returns code 2 and a JSON finding for invalid package.json", async () => {
  const directory = await createProjectWithRawPackageJson("{ invalid }");
  const result = runCli(directory, "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 2);
  assert.equal(report.findings[0].code, "package-json-invalid");
});
