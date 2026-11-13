import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/script-inspector.js", import.meta.url));
const temporaryDirectories = [];

async function createProject(scripts, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-cli-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "cli-fixture", scripts, ...extra }, null, 2)
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("prints findings and returns code 1 for script errors", async () => {
  const directory = await createProject({ dev: "node src/missing.js" });
  const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /node-entry-not-found/);
});

test("prints JSON and strict mode fails on warnings", async () => {
  const directory = await createProject({ build: "vite build" });
  const jsonResult = spawnSync(process.execPath, [cliPath, directory, "--json"], { encoding: "utf8" });
  const report = JSON.parse(jsonResult.stdout);

  assert.equal(jsonResult.status, 0);
  assert.equal(report.findings[0].code, "cli-dependency-not-declared");

  const strictResult = spawnSync(process.execPath, [cliPath, directory, "--strict"], { encoding: "utf8" });
  assert.equal(strictResult.status, 1);
});
