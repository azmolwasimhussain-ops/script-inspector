const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");

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
const SHELL_ESCAPABLE_CHARACTERS = new Set([
  "\\",
  "'",
  '"',
  "`",
  "$",
  "&",
  "|",
  ";",
  "<",
  ">",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}"
]);
const UNSUPPORTED_SHELL_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "eval",
  "source"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canEscapeNextCharacter(nextCharacter, quote) {
  if (!nextCharacter || quote === "'") return false;
  if (/\s/.test(nextCharacter)) return true;
  if (quote === '"') return ['"', "\\", "$", "`"].includes(nextCharacter);
  return SHELL_ESCAPABLE_CHARACTERS.has(nextCharacter);
}

function splitCommands(command) {
  const parts = [];
  let current = "";
  let quote = null;

  function pushPart(separatorAfter) {
    const text = current.trim();
    if (text) parts.push({ command: text, separatorAfter });
    current = "";
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (character === "\\" && canEscapeNextCharacter(command[index + 1], quote)) {
      current += character + command[index + 1];
      index += 1;
      continue;
    }

    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }

    if (character === "&" || character === "|") {
      const operator = command[index + 1] === character ? character + character : character;
      if (operator.length === 2) index += 1;
      pushPart(operator);
      continue;
    }

    if (character === ";" || character === "\n") {
      pushPart(";");
      continue;
    }

    current += character;
  }

  pushPart(null);
  return parts;
}

function shellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }

    if (character === "\\" && canEscapeNextCharacter(command[index + 1], quote)) {
      escaped = true;
      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }

    current += character;
    started = true;
  }

  if (escaped) current += "\\";
  if (started) words.push(current);
  return { words, malformed: quote !== null };
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

function isDynamicValue(value) {
  return /[$*?{}]/.test(value) || /%[^%]+%/.test(value) || value.startsWith("~");
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
  return { name: target, dynamic: isDynamicValue(target) };
}

function normalizePath(target) {
  return target.replace(/[\\/]+/g, path.sep);
}

function isInsideProject(projectDirectory, workingDirectory) {
  const relativePath = path.relative(projectDirectory, workingDirectory);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
}

function isDynamicPath(target) {
  return isDynamicValue(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
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

async function fileExists(workingDirectory, target) {
  if (isDynamicPath(target)) return null;
  const normalized = normalizePath(target);

  // A Windows drive or UNC path cannot be resolved on a non-Windows host.
  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target)) return null;

  try {
    await stat(path.resolve(workingDirectory, normalized));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function resolveCdTarget(workingDirectory, words) {
  let argumentsList = words.slice(1);
  if (argumentsList[0] === "--") argumentsList = argumentsList.slice(1);

  if (!workingDirectory) return { directory: null, reason: "the current directory is already unknown." };
  if (argumentsList.length !== 1) {
    return { directory: null, reason: "the cd command does not have one simple, literal path." };
  }

  const target = argumentsList[0];
  if (target === "-" || isDynamicPath(target)) {
    return { directory: null, reason: `the cd target "${target}" is dynamic or shell-dependent.` };
  }
  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target)) {
    return { directory: null, reason: `the Windows cd target "${target}" cannot be resolved on this host.` };
  }

  const directory = path.resolve(workingDirectory, normalizePath(target));
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) {
      return { directory: null, reason: `the cd target "${target}" is not a directory.` };
    }
    return { directory, reason: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { directory: null, reason: `the cd target "${target}" does not exist.` };
    }
    throw error;
  }
}

function unsupportedShellReason(command, words, malformed) {
  if (malformed) return "the command has an unmatched quote.";
  if (command.includes("\\\n")) return "the command uses a shell line continuation.";
  if (words.some((word) => UNSUPPORTED_SHELL_WORDS.has(word))) {
    return "the command uses shell control syntax that this static parser does not interpret.";
  }
  if (words.some((word) => ["(", ")", "{", "}"].includes(word) || word.includes("$(") || word.includes("`"))) {
    return "the command uses a subshell or command substitution.";
  }
  if (words[0] === ".") return "the command sources another shell file.";
  return null;
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
async function inspectProject(projectPath = process.cwd()) {
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
      severity: "warning",
      code: "scripts-section-missing",
      message: 'This package.json does not define a "scripts" section.',
      suggestion: 'Add a "scripts" object if this project needs npm commands.'
    });
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
    let workingDirectory = projectDirectory;

    for (const segment of segments) {
      const parsed = shellWords(segment.command);
      const words = parsed.words;
      if (words.length === 0) continue;

      const unsupportedReason = unsupportedShellReason(segment.command, words, parsed.malformed);
      if (unsupportedReason) {
        addInconclusiveFinding(findings, scriptName, segment.command, unsupportedReason);
        workingDirectory = null;
        continue;
      }

      if (/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)+/.test(segment.command)) {
        addFinding(findings, {
          severity: "warning",
          code: "posix-environment-assignment",
          script: scriptName,
          command: segment.command,
          message: `Script "${scriptName}" uses POSIX-style environment assignment.`,
          suggestion: "Use cross-env for environment variables when the script should also work in Windows shells."
        });
      }

      const entries = executableEntries(words);
      const firstCommand = entries[0]?.base;

      if (firstCommand === "cd") {
        const result = await resolveCdTarget(workingDirectory, entries[0].words);
        if (!result.directory) {
          addInconclusiveFinding(findings, scriptName, segment.command, result.reason);
          workingDirectory = null;
        } else if (segment.separatorAfter === "||") {
          addInconclusiveFinding(
            findings,
            scriptName,
            segment.command,
            "cd is followed by ||, so the next command may run from either directory."
          );
          workingDirectory = null;
        } else if (segment.separatorAfter === "|" || segment.separatorAfter === "&") {
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
        const nestedRun = npmRunTarget(entry.words);
        if (nestedRun?.dynamic) {
          addFinding(findings, {
            severity: "warning",
            code: "npm-script-dynamic",
            script: scriptName,
            target: nestedRun.name,
            message: `Script "${scriptName}" runs npm with a dynamic script name; its target cannot be verified statically.`,
            suggestion: "Check that the environment variable or shell expression resolves to a defined npm script."
          });
        } else if (nestedRun && (!workingDirectory || !isInsideProject(projectDirectory, workingDirectory))) {
          addInconclusiveFinding(
            findings,
            scriptName,
            nestedRun.name,
            "the current directory is unknown or outside the inspected project, so the npm package containing this script cannot be identified."
          );
        } else if (nestedRun && !Object.hasOwn(scripts, nestedRun.name)) {
          addFinding(findings, {
            severity: "error",
            code: "npm-script-not-found",
            script: scriptName,
            target: nestedRun.name,
            message: `Script "${scriptName}" calls "npm run ${nestedRun.name}", but that script is not defined.`,
            suggestion: `Add a "${nestedRun.name}" entry to the scripts object or correct the script name.`
          });
        }

        const nodeTarget = nodeEntryTarget(entry.words);
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
          if (exists === null) {
            addInconclusiveFinding(findings, scriptName, nodeTarget, "the Node.js entry path is dynamic or host-specific.");
          } else if (exists === false) {
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

module.exports = { inspectProject };
