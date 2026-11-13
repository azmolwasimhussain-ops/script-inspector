const { lstat, readFile, realpath, stat } = require("node:fs/promises");
const path = require("node:path");
const {
  BINARIES_TO_PACKAGES,
  executableEntries,
  isDynamicPath,
  isWindowsStylePath,
  normalizePath,
  nodeEntryTarget,
  nodeRunTarget,
  npmRunTarget,
  shellWords,
  splitCommands,
  unsupportedPackageManagerRun,
  unsupportedShellReason
} = require("./command-parser.js");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInsideProject(projectDirectory, workingDirectory) {
  const relativePath = path.relative(projectDirectory, workingDirectory);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(".." + path.sep) && !path.isAbsolute(relativePath))
  );
}

function packageDependencies(packageJson) {
  const names = new Set();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (isRecord(packageJson[field])) {
      for (const name of Object.keys(packageJson[field])) names.add(name);
    }
  }
  return names;
}

function addFinding(findings, finding) {
  const duplicate = findings.some(
    (existing) =>
      existing.code === finding.code &&
      existing.script === finding.script &&
      existing.target === finding.target
  );
  if (!duplicate) findings.push(finding);
}

function addInconclusiveFinding(findings, scriptName, target, reason) {
  addFinding(findings, {
    severity: "warning",
    code: "analysis-inconclusive",
    script: scriptName,
    target,
    message: `Could not reliably analyze script "${scriptName}": ${reason}`,
    suggestion: "Review this command manually; script-inspector does not execute shell commands."
  });
}

async function packageManifestStatus(directory) {
  try {
    await lstat(path.join(directory, "package.json"));
    return "present";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
    return "unknown";
  }
}

async function fileExists(workingDirectory, target) {
  if (isDynamicPath(target)) return { exists: null, reason: "the target path is dynamic." };
  if (process.platform !== "win32" && isWindowsStylePath(target)) {
    return { exists: null, reason: "the target uses Windows-style separators on a non-Windows host." };
  }
  const normalized = normalizePath(target);

  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target)) {
    return { exists: null, reason: "the target is a Windows absolute path on a non-Windows host." };
  }

  try {
    await stat(path.resolve(workingDirectory, normalized));
    return { exists: true };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false };
    return { exists: null, reason: `the target could not be inspected (${error?.code || "filesystem error"}).` };
  }
}

async function resolveCdTarget(workingDirectory, words) {
  let argumentsList = words.slice(1);
  if (process.platform === "win32" && argumentsList[0]?.toLowerCase() === "/d") {
    argumentsList = argumentsList.slice(1);
  }
  if (argumentsList[0] === "--") argumentsList = argumentsList.slice(1);

  if (!workingDirectory) return { directory: null, reason: "the current directory is already unknown." };
  if (argumentsList.length !== 1) {
    return { directory: null, reason: "the cd command does not have one simple, literal path." };
  }

  const target = argumentsList[0];
  if (target === "-" || isDynamicPath(target)) {
    return { directory: null, reason: "the cd target is dynamic or shell-dependent." };
  }
  if (process.platform !== "win32" && isWindowsStylePath(target)) {
    return { directory: null, reason: "the cd target uses Windows-style separators on a non-Windows host." };
  }
  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target)) {
    return { directory: null, reason: "the Windows cd target cannot be resolved on this host." };
  }

  const directory = path.resolve(workingDirectory, normalizePath(target));
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) {
      return { directory: null, reason: "the cd target is not a directory." };
    }
    return { directory: await realpath(directory), reason: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { directory: null, reason: "the cd target does not exist." };
    }
    return { directory: null, reason: `the cd target could not be inspected (${error?.code || "filesystem error"}).` };
  }
}

function parsePackagePath(projectPath) {
  const absolutePath = path.resolve(projectPath);
  return path.basename(absolutePath).toLowerCase() === "package.json"
    ? { projectDirectory: path.dirname(absolutePath), packageFile: absolutePath }
    : { projectDirectory: absolutePath, packageFile: path.join(absolutePath, "package.json") };
}

function makeFatalReport(projectDirectory, packageFile, code, message, suggestion) {
  return {
    projectDirectory,
    packageFile,
    packageName: null,
    scriptsChecked: 0,
    fatal: true,
    findings: [{ severity: "error", code, message, suggestion }],
    summary: { errors: 1, warnings: 0, infos: 0 }
  };
}

/**
 * Inspect package.json scripts without executing shell commands.
 * @param {string} projectPath Project directory or a direct path to package.json.
 */
async function inspectProject(projectPath = process.cwd()) {
  const { projectDirectory, packageFile } = parsePackagePath(projectPath);
  let source;

  try {
    const details = await lstat(packageFile);
    if (details.isSymbolicLink()) {
      return makeFatalReport(
        projectDirectory,
        packageFile,
        "package-json-symlink",
        "package.json must be a regular file, not a symbolic link.",
        "Use a regular package.json file inside the inspected project."
      );
    }
    if (!details.isFile()) {
      return makeFatalReport(
        projectDirectory,
        packageFile,
        "package-json-not-file",
        "The package.json path is not a regular file.",
        "Pass a project directory containing a regular package.json file."
      );
    }
    source = await readFile(packageFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return makeFatalReport(
        projectDirectory,
        packageFile,
        "package-json-not-found",
        `No package.json found at ${packageFile}.`,
        "Pass the root folder of a Node.js project or the path to its package.json."
      );
    }
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "package-json-unreadable",
      `Could not read package.json (${error?.code || "filesystem error"}).`,
      "Check that package.json exists and is readable."
    );
  }

  let packageJson;
  try {
    packageJson = JSON.parse(source);
  } catch (error) {
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "package-json-invalid",
      "Could not parse package.json as valid JSON.",
      "Fix the JSON syntax in package.json and run script-inspector again."
    );
  }

  if (!isRecord(packageJson)) {
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "package-json-invalid-shape",
      "package.json must contain a JSON object.",
      "Replace the top-level JSON value with a package object."
    );
  }

  const findings = [];
  const hasScripts = Object.hasOwn(packageJson, "scripts");
  const scripts = hasScripts ? packageJson.scripts : {};
  if (!isRecord(scripts)) {
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "scripts-invalid-shape",
      'The "scripts" field in package.json must be an object.',
      'Use an object such as { "scripts": { "test": "node --test" } }.'
    );
  }

  if (!hasScripts) {
    addFinding(findings, {
      severity: "info",
      code: "scripts-section-missing",
      message: 'This package.json does not define a "scripts" section.',
      suggestion: 'Add a "scripts" object if this project needs npm commands.'
    });
  } else if (Object.keys(scripts).length === 0) {
    addFinding(findings, {
      severity: "info",
      code: "scripts-section-empty",
      message: 'The "scripts" section is empty.',
      suggestion: "Add npm scripts if this project needs reusable commands."
    });
  }

  const scriptEntries = Object.entries(scripts);
  const dependencies = packageDependencies(packageJson);
  let projectRoot;
  try {
    projectRoot = await realpath(projectDirectory);
  } catch {
    projectRoot = projectDirectory;
  }

  for (const [scriptName, command] of scriptEntries) {
    if (typeof command !== "string") {
      addFinding(findings, {
        severity: "error",
        code: "script-command-not-string",
        script: scriptName,
        message: `Script "${scriptName}" must have a string command.`,
        suggestion: "Set the script value to a shell command string."
      });
      continue;
    }

    if (command.trim().length === 0) {
      addFinding(findings, {
        severity: "error",
        code: "empty-script-command",
        script: scriptName,
        message: `Script "${scriptName}" has an empty command.`,
        suggestion: "Add the command this script should run or remove the script entry."
      });
      continue;
    }

    const segments = splitCommands(command);
    let workingDirectory = projectRoot;

    for (const segment of segments) {
      const parsed = shellWords(segment.command);
      const words = parsed.words;
      if (words.length === 0) continue;

      const unsupportedReason = unsupportedShellReason(segment.command, words, parsed.malformed);
      if (unsupportedReason) {
        addInconclusiveFinding(findings, scriptName, undefined, unsupportedReason);
        workingDirectory = null;
        continue;
      }

      if (process.platform === "win32" && /^(?:[A-Za-z_][A-Za-z0-9_]*=)/.test(segment.command)) {
        addInconclusiveFinding(
          findings,
          scriptName,
          undefined,
          "the command uses POSIX environment assignment syntax, which cmd.exe does not interpret."
        );
        workingDirectory = null;
        continue;
      }

      if (/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)+/.test(segment.command)) {
        addFinding(findings, {
          severity: "warning",
          code: "posix-environment-assignment",
          script: scriptName,
          message: `Script "${scriptName}" uses POSIX-style environment assignment.`,
          suggestion: "Use cross-env for environment variables when the script should also work in Windows shells."
        });
      }

      const entries = executableEntries(words);
      const firstCommand = entries[0]?.base;

      if (firstCommand === "cd") {
        const result = await resolveCdTarget(workingDirectory, entries[0].words);
        if (!result.directory) {
          addInconclusiveFinding(findings, scriptName, undefined, result.reason);
          workingDirectory = null;
        } else if (segment.separatorBefore === "||" || segment.separatorAfter === "||") {
          addInconclusiveFinding(
            findings,
            scriptName,
            undefined,
            "cd is conditional, so later commands may run from either directory."
          );
          workingDirectory = null;
        } else if (
          segment.separatorBefore === "|" ||
          segment.separatorAfter === "|" ||
          (segment.separatorAfter === "&" && process.platform !== "win32")
        ) {
          // A cd in a pipeline or background list does not change the parent shell's directory.
        } else {
          workingDirectory = result.directory;
        }
        continue;
      }

      for (const entry of entries) {
        const dependency = BINARIES_TO_PACKAGES.get(entry.base);
        if (dependency && !dependencies.has(dependency)) {
          addFinding(findings, {
            severity: "warning",
            code: "cli-dependency-not-declared",
            script: scriptName,
            command: entry.executable,
            target: dependency,
            message: `Script "${scriptName}" uses "${entry.executable}", but "${dependency}" is not declared in this package.json.`,
            suggestion: `Add "${dependency}" to dependencies or devDependencies, or confirm that it is intentionally provided by your environment.`
          });
        }
      }

      for (const entry of entries) {
        const unsupportedRunner = unsupportedPackageManagerRun(entry.words);
        if (unsupportedRunner) {
          addInconclusiveFinding(
            findings,
            scriptName,
            undefined,
            `the ${unsupportedRunner.runner} script command cannot be checked against this npm package's scripts.`
          );
          continue;
        }

        const nodeRun = nodeRunTarget(entry.words);
        const nestedRun = npmRunTarget(entry.words) || nodeRun;
        const isNodeRun = nestedRun?.runner === "node --run";
        const cwdPackageStatus =
          nestedRun &&
          workingDirectory &&
          isInsideProject(projectRoot, workingDirectory) &&
          workingDirectory !== projectRoot
            ? await packageManifestStatus(workingDirectory)
            : "not-checked";
        if (nestedRun?.unsupported) {
          addInconclusiveFinding(
            findings,
            scriptName,
            nestedRun.option,
            "npm is invoked with an option that can change which package's scripts are run."
          );
        } else if (nestedRun?.dynamic) {
          addFinding(findings, {
            severity: "warning",
            code: isNodeRun ? "node-run-script-dynamic" : "npm-script-dynamic",
            script: scriptName,
            target: nestedRun.name,
            message: `Script "${scriptName}" runs ${nestedRun.runner} with a dynamic script name; its target cannot be verified statically.`,
            suggestion: "Check that the environment variable or shell expression resolves to a defined npm script."
          });
        } else if (nestedRun && (!workingDirectory || !isInsideProject(projectRoot, workingDirectory))) {
          addInconclusiveFinding(
            findings,
            scriptName,
            nestedRun.name,
            "the current directory is unknown or outside the inspected project, so the npm package containing this script cannot be identified."
          );
        } else if (nestedRun && cwdPackageStatus === "present") {
          addInconclusiveFinding(
            findings,
            scriptName,
            nestedRun.name,
            "the current directory has its own package.json, which is not the manifest being inspected."
          );
        } else if (nestedRun && cwdPackageStatus === "unknown") {
          addInconclusiveFinding(
            findings,
            scriptName,
            nestedRun.name,
            "the package.json in the current directory could not be checked."
          );
        } else if (nestedRun && !Object.hasOwn(scripts, nestedRun.name)) {
          if (nestedRun.optional) {
            addFinding(findings, {
              severity: "info",
              code: "npm-script-optional-missing",
              script: scriptName,
              target: nestedRun.name,
              message: `Script "${scriptName}" optionally calls "${nestedRun.name}", which is not defined.`,
              suggestion: "Confirm that the missing script is intentionally optional."
            });
          } else {
            addFinding(findings, {
              severity: "error",
              code: isNodeRun ? "node-run-script-not-found" : "npm-script-not-found",
              script: scriptName,
              target: nestedRun.name,
              message: `Script "${scriptName}" calls "${nestedRun.runner} ${nestedRun.name}", but that script is not defined.`,
              suggestion: `Add a "${nestedRun.name}" entry to the scripts object or correct the script name.`
            });
          }
        }

        // `node --run` consumes its script name and forwarded arguments; they are not
        // Node entry-file paths.
        const nodeTarget = nodeRun ? null : nodeEntryTarget(entry.words);
        if (nodeTarget) {
          if (!workingDirectory) {
            addInconclusiveFinding(
              findings,
              scriptName,
              nodeTarget,
              "the current directory could not be determined after an earlier shell command."
            );
            continue;
          }

          const exists = await fileExists(workingDirectory, nodeTarget);
          if (exists.exists === null) {
            addInconclusiveFinding(findings, scriptName, nodeTarget, exists.reason);
          } else if (exists.exists === false) {
            addFinding(findings, {
              severity: "error",
              code: "node-entry-not-found",
              script: scriptName,
              target: nodeTarget,
              message: `Script "${scriptName}" points to missing Node.js entry "${nodeTarget}".`,
              suggestion: "Correct the path or add the referenced file to the project."
            });
          }
        }
      }
    }
  }

  const summary = {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    infos: findings.filter((finding) => finding.severity === "info").length
  };

  return {
    projectDirectory,
    packageFile,
    packageName: typeof packageJson.name === "string" ? packageJson.name : null,
    scriptsChecked: scriptEntries.length,
    fatal: false,
    findings,
    summary
  };
}

module.exports = { inspectProject };
