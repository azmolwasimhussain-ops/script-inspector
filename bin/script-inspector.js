#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectProject } from "../src/inspect.js";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
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

function printHumanReport(report) {
  if (report.fatal) {
    const finding = report.findings[0];
    console.error(`ERROR [${finding.code}] ${finding.message}`);
    console.error(`  Fix: ${finding.suggestion}`);
    return;
  }

  console.log(`script-inspector: ${report.packageName ?? "unnamed package"}`);
  console.log(`Checked ${report.scriptsChecked} script${report.scriptsChecked === 1 ? "" : "s"}.`);

  if (report.findings.length === 0) {
    console.log(report.scriptsChecked === 0 ? "No npm scripts are defined." : "No issues found.");
  } else {
    for (const finding of report.findings) {
      const label = finding.severity.toUpperCase();
      console.log(`${label} [${finding.code}] ${finding.message}`);
      if (finding.suggestion) console.log(`  Fix: ${finding.suggestion}`);
    }
  }

  console.log(`Summary: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s).`);
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.error) {
  console.error(`script-inspector: ${parsed.error}`);
  console.error("Run script-inspector --help for usage.");
  process.exitCode = 2;
} else if (parsed.options.help) {
  console.log(usage());
} else if (parsed.options.version) {
  console.log(packageVersion);
} else {
  try {
    const report = await inspectProject(parsed.options.projectPath);
    if (parsed.options.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);

    if (report.fatal) process.exitCode = 2;
    else if (report.summary.errors > 0 || (parsed.options.strict && report.summary.warnings > 0)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`script-inspector: ${error.message}`);
    process.exitCode = 2;
  }
}
