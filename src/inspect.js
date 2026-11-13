import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const BINARIES_TO_PACKAGES = new Map([
  ["concurrently", "concurrently"],
  ["cross-env", "cross-env"],
  ["cross-env-shell", "cross-env"],
  ["eslint", "eslint"],
  ["jest", "jest"],
  ["mocha", "mocha"],
  ["next", "next"],
  ["nodemon", "nodemon"],
  ["prettier", "prettier"],
  ["rimraf", "rimraf"],
  ["rollup", "rollup"],
  ["ts-node", "ts-node"],
  ["ts-node-esm", "ts-node"],
  ["tsc", "typescript"],
  ["tsup", "tsup"],
  ["tsx", "tsx"],
  ["vite", "vite"],
  ["vitest", "vitest"],
  ["webpack", "webpack"]
]);

const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "--inspect-port",
  "--title",
  "--run",
  "--watch-path"
]);

const NODE_OPTIONS_WITH_INLINE_CODE = new Set(["-e", "--eval", "-p", "--print"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitCommands(command) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "&" || char === "|") {
      const next = command[index + 1];
      if (next === char) index += 1;
      parts.push(current.trim());
      current = "";
      continue;
    }

    if (char === ";" || char === "\n") {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function shellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let started = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (escaped) current += "\\";
  if (started) words.push(current);
  return words;
}

function isEnvironmentAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function skipEnvironmentPrefix(words) {
  let index = 0;

  if (words[index] === "env") {
    index += 1;
    while (words[index] === "-i" || words[index] === "--ignore-environment") index += 1;
    while (words[index] === "-u" || words[index] === "--unset") index += 2;
    if (words[index] === "--") index += 1;
  }

  while (isEnvironmentAssignment(words[index] ?? "")) index += 1;
  return words.slice(index);
}

function executableEntries(words) {
  const entries = [];
  let current = skipEnvironmentPrefix(words);

  while (current.length > 0) {
    const executable = current[0];
    const base = path.basename(executable).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
    entries.push({ executable, base, words: current });

    if (base !== "cross-env" && base !== "cross-env-shell") break;
    current = skipEnvironmentPrefix(current.slice(1));
  }

  return entries;
}

function nodeEntryTarget(words) {
  const executable = path.basename(words[0]).replace(/\.exe$/i, "").toLowerCase();
  if (executable !== "node") return null;

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];

    if (word === "--") return words[index + 1] ?? null;
    if (NODE_OPTIONS_WITH_INLINE_CODE.has(word)) return null;
    if (NODE_OPTIONS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) continue;
    if (word.startsWith("-")) continue;
    return word;
  }

  return null;
}

function npmRunTarget(words) {
  const executable = path.basename(words[0]).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
  if (executable !== "npm") return null;

  const runIndex = words.findIndex((word, index) => index > 0 && (word === "run" || word === "run-script"));
  const execIndex = words.findIndex((word, index) => index > 0 && word === "exec");
  if (execIndex !== -1 && (runIndex === -1 || execIndex < runIndex)) return null;
  if (runIndex === -1) return null;

  const args = words.slice(runIndex + 1);
  const target = args.find((word) => !word.startsWith("-"));
  if (!target || args.includes("--if-present")) return null;
  return target;
}

function isDynamicPath(target) {
  return /[*?{}$]/.test(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("~");
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

async function fileExists(projectDirectory, target) {
  if (isDynamicPath(target)) return null;
  const normalized = target.replace(/[\\/]+/g, path.sep);
  try {
    await stat(path.resolve(projectDirectory, normalized));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
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
    summary: { errors: 1, warnings: 0 }
  };
}

/**
 * Inspect package.json scripts without executing shell commands.
 * @param {string} projectPath Project directory or a direct path to package.json.
 */
export async function inspectProject(projectPath = process.cwd()) {
  const { projectDirectory, packageFile } = parsePackagePath(projectPath);
  let source;

  try {
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
    throw error;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(source);
  } catch (error) {
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "package-json-invalid",
      `Could not parse package.json: ${error.message}`,
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
  const scripts = Object.hasOwn(packageJson, "scripts") ? packageJson.scripts : {};
  if (!isRecord(scripts)) {
    return makeFatalReport(
      projectDirectory,
      packageFile,
      "scripts-invalid-shape",
      'The "scripts" field in package.json must be an object.',
      'Use an object such as { "scripts": { "test": "node --test" } }.'
    );
  }

  const scriptEntries = Object.entries(scripts);
  const dependencies = packageDependencies(packageJson);

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
    let changedWorkingDirectory = false;

    for (const segment of segments) {
      const words = shellWords(segment);
      if (words.length === 0) continue;

      if (/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)+/.test(segment)) {
        addFinding(findings, {
          severity: "warning",
          code: "posix-environment-assignment",
          script: scriptName,
          command: segment,
          message: `Script "${scriptName}" uses POSIX-style environment assignment.`,
          suggestion: "Use cross-env for environment variables when the script should also work in Windows shells."
        });
      }

      const entries = executableEntries(words);
      const firstCommand = entries[0]?.base;
      if (firstCommand === "cd") {
        changedWorkingDirectory = true;
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
        const missingScript = changedWorkingDirectory ? null : npmRunTarget(entry.words);
        if (missingScript && !Object.hasOwn(scripts, missingScript)) {
          addFinding(findings, {
            severity: "error",
            code: "npm-script-not-found",
            script: scriptName,
            target: missingScript,
            message: `Script "${scriptName}" calls "npm run ${missingScript}", but that script is not defined.`,
            suggestion: `Add a "${missingScript}" entry to the scripts object or correct the script name.`
          });
        }

        if (!changedWorkingDirectory) {
          const nodeTarget = nodeEntryTarget(entry.words);
          if (nodeTarget) {
            const exists = await fileExists(projectDirectory, nodeTarget);
            if (exists === false) {
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
  }

  const summary = {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length
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
