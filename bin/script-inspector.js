#!/usr/bin/env node

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { inspectProject } = require("../src/inspect.js");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;

function usage() {
  return `script-inspector ${packageVersion}

Inspect package.json scripts for common Node.js setup issues.

Usage:
  script-inspector [project-path] [options]

Options:
  --json       Print the report as JSON
  --strict     Exit with code 1 when warnings are found
  -h, --help   Show this help
  -v, --version Show the version

If no project path is provided, the current directory is inspected.`;
}

function parseArguments(args) {
  const options = { json: false, strict: false, projectPath: process.cwd() };
  let hasProjectPath = false;
  let positionalOnly = false;

  for (const argument of args) {
    if (positionalOnly) {
      if (hasProjectPath) return { error: "Only one project path can be provided." };
      options.projectPath = argument;
      hasProjectPath = true;
      continue;
    }

    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "--json") options.json = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
    else if (argument.startsWith("-")) return { error: `Unknown option: ${argument}` };
    else if (hasProjectPath) return { error: "Only one project path can be provided." };
    else {
      options.projectPath = path.resolve(argument);
      hasProjectPath = true;
    }
  }

  return { options };
}

function terminalSafe(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function printHumanReport(report) {
  if (report.fatal) {
    const finding = report.findings[0];
    console.error(`ERROR [${terminalSafe(finding.code)}] ${terminalSafe(finding.message)}`);
    console.error(`  Fix: ${terminalSafe(finding.suggestion)}`);
    return;
  }

  console.log(`script-inspector: ${terminalSafe(report.packageName ?? "unnamed package")}`);
  console.log(`Checked ${report.scriptsChecked} script${report.scriptsChecked === 1 ? "" : "s"}.`);

  if (report.findings.length === 0) {
    console.log(report.scriptsChecked === 0 ? "No npm scripts are defined." : "No issues found.");
  } else {
    for (const finding of report.findings) {
      const label = terminalSafe(finding.severity.toUpperCase());
      console.log(`${label} [${terminalSafe(finding.code)}] ${terminalSafe(finding.message)}`);
      if (finding.suggestion) console.log(`  Fix: ${terminalSafe(finding.suggestion)}`);
    }
  }

  console.log(
    `Summary: ${countLabel(report.summary.errors, "error")}, ${countLabel(report.summary.warnings, "warning")}, ${countLabel(report.summary.infos, "informational finding")}.`
  );
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    console.error(`script-inspector: ${terminalSafe(parsed.error)}`);
    console.error("Run script-inspector --help for usage.");
    process.exitCode = 2;
    return;
  }

  if (parsed.options.help) {
    console.log(usage());
    return;
  }

  if (parsed.options.version) {
    console.log(packageVersion);
    return;
  }

  try {
    const report = await inspectProject(parsed.options.projectPath);
    if (parsed.options.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);

    if (report.fatal) process.exitCode = 2;
    else if (report.summary.errors > 0 || (parsed.options.strict && report.summary.warnings > 0)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`script-inspector: ${terminalSafe(error.message)}`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`script-inspector: ${terminalSafe(error.message)}`);
  process.exitCode = 2;
});
