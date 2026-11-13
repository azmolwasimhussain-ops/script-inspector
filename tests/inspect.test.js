const assert = require("node:assert/strict");
const { access, mkdtemp, mkdir, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { inspectProject } = require("../src");
const { BINARIES_TO_PACKAGES } = require("../src/command-parser.js");

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
      scripts: { dev: "node src/index.js", lint: "eslint .", build: "vite build" },
      dependencies: { vite: "^6.0.0" },
      devDependencies: { eslint: "^9.0.0" }
    },
    { "src/index.js": "console.log('ready')" }
  );

  const report = await inspectProject(directory);
  assert.equal(report.fatal, false);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, infos: 0 });
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

test("checks quoted Node entry paths that contain spaces", async () => {
  const directory = await createProject(
    { scripts: { start: 'node "src folder/index.js"' } },
    { "src folder/index.js": "console.log('ready')" }
  );
  const report = await inspectProject(directory);

  assert.equal(report.summary.errors, 0);
  assert.equal(report.findings.length, 0);
});

test("checks quoted absolute Node entry paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-absolute-"));
  temporaryDirectories.push(directory);
  const entryPath = path.join(directory, "source folder", "entry file.js");
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "");
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ scripts: { start: `node "${entryPath}"` } })
  );

  const report = await inspectProject(directory);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.findings.length, 0);
});

test("deduplicates repeated findings for the same script and target", async () => {
  const directory = await createProject({ scripts: { build: "node missing.js && node missing.js" } });
  const report = await inspectProject(directory);

  assert.equal(report.findings.filter((finding) => finding.code === "node-entry-not-found").length, 1);
  assert.equal(report.summary.errors, 1);
});

for (const [binary, packageName] of BINARIES_TO_PACKAGES) {
  test(`maps ${binary} to the expected package dependency`, async () => {
    const directory = await createProject({ scripts: { check: `${binary} --version` } });
    const report = await inspectProject(directory);
    const finding = report.findings.find((item) => item.code === "cli-dependency-not-declared");

    assert.ok(finding, `expected ${binary} to be checked`);
    assert.equal(finding.target, packageName);
  });
}

test("reports a missing npm run target", async () => {
  const directory = await createProject({ scripts: { deploy: "npm run build" } });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "npm-script-not-found");
  assert.match(report.findings[0].message, /build/);
});

test("recognizes npm run after global flags without mistaking install arguments", async () => {
  const directory = await createProject({
    scripts: {
      wrongSubcommand: "npm install run missing",
      missingTarget: "npm --silent run missing"
    }
  });
  const report = await inspectProject(directory);

  assert.equal(
    report.findings.filter((finding) => finding.code === "npm-script-not-found").length,
    1
  );
  assert.equal(report.findings.find((finding) => finding.code === "npm-script-not-found").script, "missingTarget");
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

test("does not expose values from POSIX environment assignments", async () => {
  const secret = "script-inspector-test-secret";
  const directory = await createProject({ scripts: { start: `API_TOKEN=${secret} node app.js` } });
  const report = await inspectProject(directory);

  const expectedFinding = process.platform === "win32" ? "analysis-inconclusive" : "posix-environment-assignment";
  assert.ok(report.findings.some((finding) => finding.code === expectedFinding));
  assert.equal(JSON.stringify(report).includes(secret), false);
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

test("reports a missing scripts section as informational", async () => {
  const directory = await createProject({ name: "without-scripts" });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "scripts-section-missing");
  assert.equal(report.findings[0].severity, "info");
  assert.equal(report.summary.infos, 1);
});

test("reports an empty scripts object as informational", async () => {
  const directory = await createProject({ name: "empty-scripts", scripts: {} });
  const report = await inspectProject(directory);

  assert.equal(report.findings[0].code, "scripts-section-empty");
  assert.equal(report.summary.infos, 1);
});

test("does not report a dynamic npm script name as missing", async () => {
  const directory = await createProject({ scripts: { start: 'npm run "$TARGET"' } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "npm-script-dynamic"));
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
  assert.equal(report.summary.errors, 0);
});

test("checks Node's built-in --run script targets", async () => {
  const directory = await createProject(
    {
      scripts: {
        missing: "node --run absent",
        dynamic: 'node --run "$TARGET"',
        existing: "node --run=build",
        requiredBeforeRun: "node --require ./setup.js --run=build",
        forwardedArguments: "node --run build -- missing.js",
        inlineCode: 'node --eval="console.log(1)" --run absent',
        argument: "node app.js --run absent",
        build: "echo build"
      }
    },
    { "app.js": "", "setup.js": "" }
  );
  const report = await inspectProject(directory);

  assert.equal(
    report.findings.filter((finding) => finding.code === "node-run-script-not-found").length,
    1
  );
  assert.ok(report.findings.some((finding) => finding.code === "node-run-script-dynamic"));
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
});

test("recognizes percent-delimited dynamic npm script names", async () => {
  const directory = await createProject({ scripts: { start: "npm run %TARGET%" } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "npm-script-dynamic"));
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
});

test("does not report an absent optional npm script as an error", async () => {
  const directory = await createProject({ scripts: { deploy: "npm run --if-present optional-deploy" } });
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "npm-script-optional-missing"));
  assert.equal(report.summary.errors, 0);
});

test("reports package-selecting npm options as inconclusive", async () => {
  const directory = await createProject({
    scripts: {
      deploy: "npm --prefix ./other run deploy",
      workspaceDeploy: "npm run deploy --workspace app",
      packageInstall: "npm --prefix ./other install"
    }
  });
  const report = await inspectProject(directory);

  assert.equal(report.findings.filter((finding) => finding.code === "analysis-inconclusive").length, 2);
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
});

test("reports alternative package-manager run commands as inconclusive", async () => {
  const directory = await createProject({
    scripts: {
      pnpm: "pnpm --silent run missing",
      yarn: "yarn --cwd . run missing",
      bun: "bun --cwd . run missing"
    }
  });
  const report = await inspectProject(directory);

  assert.equal(report.findings.filter((finding) => finding.code === "analysis-inconclusive").length, 3);
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
});

test("does not treat forwarded npm script arguments as npm options", async () => {
  const directory = await createProject({ scripts: { deploy: "npm run build -- --workspace", build: "echo build" } });
  const report = await inspectProject(directory);

  assert.equal(report.findings.some((finding) => finding.code === "analysis-inconclusive"), false);
  assert.equal(report.findings.some((finding) => finding.code === "npm-script-not-found"), false);
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

test("does not assume a cd after || always changes the working directory", async () => {
  const directory = await createProject(
    { scripts: { start: "true || cd scripts && node entry.js" } },
    { "entry.js": "", "scripts/other.js": "" }
  );
  const report = await inspectProject(directory);

  assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
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

test("handles Windows-style relative Node paths conservatively on each host", async () => {
  const directory = await createProject(
    { scripts: { start: "node .\\src\\index.js" } },
    { "src/index.js": "console.log('ready')" }
  );
  const report = await inspectProject(directory);

  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
  if (process.platform === "win32") {
    assert.equal(report.findings.some((finding) => finding.code === "analysis-inconclusive"), false);
  } else {
    assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
  }
});

test("tracks the Windows cmd.exe cd /d form", { skip: process.platform !== "win32" }, async () => {
  const directory = await createProject(
    { scripts: { start: "cd /d scripts && node entry.js" } },
    { "scripts/entry.js": "" }
  );
  const report = await inspectProject(directory);

  assert.equal(report.summary.errors, 0);
  assert.equal(report.findings.length, 0);
});

test("does not assume Windows cd separators work in POSIX shells", async () => {
  const directory = await createProject(
    { scripts: { start: "cd .\\scripts && node missing.js" } },
    { "scripts/entry.js": "" }
  );
  const report = await inspectProject(directory);

  if (process.platform === "win32") {
    assert.ok(report.findings.some((finding) => finding.code === "node-entry-not-found"));
  } else {
    assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
    assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
  }
});

test("returns a structured fatal report when package.json is not a file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-unusual-package-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "package.json"));

  const report = await inspectProject(directory);
  assert.equal(report.fatal, true);
  assert.equal(report.findings[0].code, "package-json-not-file");
});

test("refuses to read a package.json symbolic link", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-inspector-symlink-"));
  temporaryDirectories.push(directory);
  const outsideFile = path.join(directory, "outside.json");
  await writeFile(outsideFile, JSON.stringify({ scripts: { start: "node secret.js" } }));
  await symlink(outsideFile, path.join(directory, "package.json"));

  const report = await inspectProject(directory);
  assert.equal(report.fatal, true);
  assert.equal(report.findings[0].code, "package-json-symlink");
});

test("reports an inconclusive result for a looping entry symlink", { skip: process.platform === "win32" }, async () => {
  const directory = await createProject({ scripts: { start: "node loop.js" } });
  await symlink("loop.js", path.join(directory, "loop.js"));

  const report = await inspectProject(directory);
  assert.ok(report.findings.some((finding) => finding.code === "analysis-inconclusive"));
  assert.equal(report.findings.some((finding) => finding.code === "node-entry-not-found"), false);
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
