const assert = require("node:assert/strict");
const { access, mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { inspectProject } = require("../src");

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

async function createProjectWithRawPackageJson(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-json-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), source);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("accepts correctly configured Node entries and declared CLI tools", async () => {
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

test("reports a missing file inside nested directories", async () => {
  const directory = await createProject({ scripts: { build: "node src/deep/missing.js" } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "node-entry-not-found"));
  assert.equal(report.findings[0].target, "src/deep/missing.js");
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

test("reports a fatal finding for invalid package JSON", async () => {
  const directory = await createProjectWithRawPackageJson("{ invalid }");
  const report = await inspectProject(directory);

  assert.equal(report.fatal, true);
  assert.equal(report.findings[0].code, "package-json-invalid");
});

test("reports a fatal finding when package.json is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-no-package-"));
  temporaryDirectories.push(directory);
  const report = await inspectProject(directory);

  assert.equal(report.fatal, true);
  assert.equal(report.findings[0].code, "package-json-not-found");
});

test("warns when the scripts section is missing", async () => {
  const directory = await createProject({ name: "without-scripts" });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "scripts-section-missing");
  assert.equal(report.summary.warnings, 1);
});

test("does not report a dynamic npm script name as missing", async () => {
  const directory = await createProject({ scripts: { start: 'npm run "$TARGET"' } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "npm-script-dynamic"));
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
  assert.equal(report.summary.errors, 0);
});

test("checks Node entries and npm scripts after a simple cd", async () => {
  const directory = await createProject(
    {
      scripts: {
        present: "cd scripts && node entry.js",
        nestedDirectory: "cd scripts && cd nested && node entry.js",
        missingFile: "cd scripts && node absent.js",
        missingScript: "cd scripts && npm run missing"
      }
    },
    {
      "scripts/entry.js": "console.log('ready')",
      "scripts/nested/entry.js": "console.log('nested ready')"
    }
  );
  const report = await inspectProject(directory);

  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found" && finding.target === "entry.js"), false);
  assert.ok(report.findings.some((finding) => finding.code === "node-entry-not-found" && finding.target === "absent.js"));
  assert.ok(report.findings.some((finding) => finding.code === "npm-script-not-found" && finding.target === "missing"));
  assert.equal(report.findings.some((finding) => finding.code === "analysis-inconclusive"), false);
});

test("reports an inconclusive warning when cd uses a dynamic directory", async () => {
  const directory = await createProject({ scripts: { start: 'cd "$PROJECT_DIR" && npm run missing' } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
});

test("reports inconclusive when shell control syntax cannot be parsed", async () => {
  const directory = await createProject(
    { scripts: { start: "if [ -d src ]; then node src/index.js; fi" } },
    { "src/index.js": "console.log('ready')" }
  );
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
});

test("recognizes a Windows-style relative Node entry path", async () => {
  const directory = await createProject(
    { scripts: { start: "node .\\src\\index.js" } },
    { "src/index.js": "console.log('ready')" }
  );
  const report = await inspectProject(directory);

  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
  assert.equal(report.findings.some((finding) => finding.code === "analysis-inconclusive"), false);
});

test("never executes a command found in package.json", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-safe-"));
  temporaryDirectories.push(directory);
  const marker = path.join(directory, "script-was-executed.txt");
  const command = `node -e "require('node:fs').writeFileSync('${marker}', 'executed')"`;
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts: { malicious: command } }));

  const report = await inspectProject(directory);
  const markerExists = await access(marker).then(() => true, () => false);

  assert.equal(report.fatal, false);
  assert.equal(markerExists, false);
});
