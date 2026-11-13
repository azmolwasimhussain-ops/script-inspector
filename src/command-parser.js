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

function portableBasename(value) {
  return path.basename(value.replace(/\\/g, "/"));
}

function canEscapeNextCharacter(nextCharacter, quote) {
  if (process.platform === "win32" || !nextCharacter || quote === "'") return false;
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

    if (character === ";") {
      if (process.platform === "win32") current += character;
      else pushPart(";");
      continue;
    }

    if (character === "\n") {
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
    const base = portableBasename(executable).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
    entries.push({ executable, base, words: current });

    if (base !== "cross-env" && base !== "cross-env-shell") break;
    current = skipEnvironmentPrefix(current.slice(1));
  }

  return entries;
}

function nodeEntryTarget(words) {
  const executable = portableBasename(words[0]).replace(/\.exe$/i, "").toLowerCase();
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
  const executable = portableBasename(words[0]).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
  if (executable !== "npm") return null;

  const runIndex = words.findIndex((word, index) => index > 0 && (word === "run" || word === "run-script"));
  const execIndex = words.findIndex((word, index) => index > 0 && word === "exec");
  if (execIndex !== -1 && (runIndex === -1 || execIndex < runIndex)) return null;
  if (runIndex === -1) return null;

  const optionBoundary = words.indexOf("--");
  const allArguments = words.slice(1, optionBoundary === -1 ? words.length : optionBoundary);
  const unsupportedOptions = ["--prefix", "--workspace", "--workspaces", "-w", "--script-shell"];
  const unsupportedOption = allArguments.find((argument) =>
    unsupportedOptions.some((option) => argument === option || argument.startsWith(`${option}=`))
  );
  if (unsupportedOption) {
    return { unsupported: true, option: unsupportedOption.split("=", 1)[0] };
  }

  const args = words.slice(runIndex + 1);
  const runOptionBoundary = args.indexOf("--");
  const runOptions = args.slice(0, runOptionBoundary === -1 ? args.length : runOptionBoundary);
  const skipNext = new Set(["--workspace", "-w", "--prefix", "--script-shell"]);
  let target = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--if-present") continue;
    if (argument === "--") break;
    if (argument.startsWith("-")) {
      if (skipNext.has(argument)) index += 1;
      continue;
    }
    target = argument;
    break;
  }

  if (!target) return null;
  return {
    name: target,
    dynamic: isDynamicValue(target),
    optional: runOptions.includes("--if-present")
  };
}

function normalizePath(target) {
  return target.replace(/[\\/]+/g, path.sep);
}

function isDynamicPath(target) {
  return isDynamicValue(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

function isWindowsStylePath(target) {
  return /\\[^\s]/.test(target);
}

function containsUnquotedCharacter(command, characters) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && canEscapeNextCharacter(command[index + 1], quote)) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (quote === '"' && character === "$" && command[index + 1] === "(") return true;
      else if (quote === '"' && character === "`") return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (characters.includes(character)) return true;
    if (character === "$" && command[index + 1] === "(") return true;
  }

  return false;
}

function unsupportedShellReason(command, words, malformed) {
  if (malformed) return "the command has an unmatched quote.";
  if (command.includes("\\\n")) return "the command uses a shell line continuation.";
  if (UNSUPPORTED_SHELL_WORDS.has(words[0])) {
    return "the command uses shell control syntax that this static parser does not interpret.";
  }
  if (containsUnquotedCharacter(command, "(){}<>`")) {
    return "the command uses grouping, redirection, or substitution syntax this parser does not interpret.";
  }
  if (process.platform === "win32" && (command.includes("'") || containsUnquotedCharacter(command, ";^"))) {
    return "the command uses Windows shell syntax this parser does not interpret.";
  }
  if (words[0] === ".") return "the command sources another shell file.";
  return null;
}

module.exports = {
  BINARIES_TO_PACKAGES,
  executableEntries,
  isDynamicPath,
  isWindowsStylePath,
  normalizePath,
  nodeEntryTarget,
  npmRunTarget,
  shellWords,
  splitCommands,
  unsupportedShellReason
};
