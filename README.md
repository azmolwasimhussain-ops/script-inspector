# script-inspector

`script-inspector` statically checks a Node.js project's `package.json` scripts for common setup problems before you run them. It can point out missing Node.js entry files, misspelled nested npm scripts, and undeclared common CLI dependencies.

It reads the package manifest and checks referenced paths. **It never executes npm scripts or shell commands.**

[GitHub repository](https://github.com/azmolwasimhussain-ops/script-inspector) · [Report an issue](https://github.com/azmolwasimhussain-ops/script-inspector/issues)

## Features

- Detects missing files referenced by common `node` commands.
- Checks simple `npm run` and `npm run-script` calls against the manifest.
- Tracks simple `cd directory` commands when the directory exists.
- Reports dynamic script names and unsupported shell syntax without guessing.
- Warns when selected common CLI tools are missing from the manifest dependencies.
- Prints human-readable findings or a JSON report.
- Provides a CommonJS API and a command-line interface.

## Requirements

- Node.js 22 or newer.
- npm for installation and `npx` usage.

## Installation

Install it as a development dependency in the project you want to inspect:

```sh
npm install --save-dev script-inspector
```

Or run it on demand with `npx`:

```sh
npx script-inspector
```

## Usage

Run from a Node.js project directory:

```sh
npx script-inspector
```

Pass a project directory or a direct `package.json` path to inspect another project:

```sh
npx script-inspector ./my-app
npx script-inspector ./my-app/package.json
```

### Options

```text
script-inspector [project-path] [options]

--json       Print a machine-readable JSON report
--strict     Return a failing exit code when warnings are found
-h, --help   Show help
-v, --version Show the installed version
```

For example, given a missing entry file:

```text
script-inspector: my-app
Checked 1 script.
ERROR [node-entry-not-found] Script "start" points to missing Node.js entry "src/server.js".
  Fix: Correct the path or add the referenced file to the project.
Summary: 1 error, 0 warnings, 0 informational findings.
```

### JSON output

Use `--json` for tools and CI systems. A report has stable `findings` and `summary` fields:

```sh
npx script-inspector --json
```

```json
{
  "projectDirectory": "/absolute/path/to/my-app",
  "packageFile": "/absolute/path/to/my-app/package.json",
  "packageName": "my-app",
  "scriptsChecked": 1,
  "fatal": false,
  "findings": [
    {
      "severity": "error",
      "code": "node-entry-not-found",
      "script": "start",
      "target": "src/server.js",
      "message": "Script \"start\" points to missing Node.js entry \"src/server.js\".",
      "suggestion": "Correct the path or add the referenced file to the project."
    }
  ],
  "summary": { "errors": 1, "warnings": 0, "infos": 0 }
}
```

The `projectDirectory` and `packageFile` values are absolute paths on the machine where the command ran.

## Example project manifest

```json
{
  "name": "my-app",
  "scripts": {
    "start": "node src/index.js",
    "lint": "eslint .",
    "build": "npm run lint && node scripts/build.js"
  },
  "devDependencies": {
    "eslint": "^9.0.0"
  }
}
```

If `src/index.js` or `scripts/build.js` is missing, or if `lint` is removed from `scripts`, the analyzer reports it. It also warns if a recognized CLI command such as `eslint` is not declared in dependencies.

## Findings and exit codes

Findings use three severity levels:

- **error**: a confirmed problem, such as a missing Node entry file or nested npm script.
- **warning**: a possible problem or an analysis that needs manual review.
- **info**: context, such as a package with no scripts or an absent optional script.

The summary contains an `errors`, `warnings`, and `infos` count. Informational findings do not affect the exit code.

| Exit code | Meaning |
| --- | --- |
| `0` | No errors; warnings are allowed unless `--strict` is used. |
| `1` | At least one error, or `--strict` was used and at least one warning exists. |
| `2` | Invalid CLI arguments or a package configuration that could not be read. |

An absent `scripts` section is informational. An invalid `scripts` value or a non-string/empty script command is an error.

## Supported command patterns

The analyzer recognizes common, simple forms, including:

- `node src/index.js` and Node entry paths after common Node options.
- `npm run build` and `npm run-script build`.
- `cd scripts && node build.js` when `scripts` exists.
- Simple command separators such as `&&`, `||`, `|`, and POSIX `;`.
- A curated set of common CLI binaries, including ESLint, Jest, TypeScript, Vite, Vitest, and Webpack.

Dynamic npm script names such as `npm run "$TARGET"` cannot be checked for a specific target. They receive a warning instead of a false missing-script error. npm options that select another package, such as `--workspace` or `--prefix`, are reported as inconclusive.

Windows-style relative paths such as `node .\\src\\index.js` are checked on Windows. On POSIX systems these paths are reported as inconclusive because backslashes have different shell meanings. This project does not provide complete Windows `cmd.exe`, PowerShell, POSIX shell, or shell-expansion compatibility.

## JavaScript API

The package exports `inspectProject(projectPath)`, which accepts a project directory or a direct path to its `package.json`:

```js
const { inspectProject } = require("script-inspector");

async function main() {
  const report = await inspectProject("./my-app");
  console.log(report.summary);
  console.log(report.findings);
}

main();
```

The returned promise resolves to an `InspectionReport`. Fatal package-reading problems are represented in the report with `fatal: true`; the API does not run the CLI or throw for ordinary filesystem and JSON errors.

## Security

This is a static analyzer. It does not spawn processes, invoke a shell, install dependencies, or make network requests. It reads `package.json` and checks referenced paths with filesystem metadata calls. A `package.json` symbolic link is rejected. Script text is treated as data and is not run.

## Limitations

- Shell commands are parsed with a small, conservative parser; this is not a shell interpreter.
- Complex shell syntax, variable expansion, workspace selection, and commands whose working directory cannot be determined may be reported as inconclusive.
- The dependency check uses a curated list of common binaries. It cannot know whether a tool is supplied globally, by a workspace, or by the environment.
- A path's existence does not guarantee that it is valid JavaScript or that the command will succeed.
- Windows checks are run under the host's default Node/npm shell assumptions; PowerShell and arbitrary custom script shells are not fully interpreted.

## Development

Clone the repository, install from the lockfile, and run the tests:

```sh
git clone https://github.com/azmolwasimhussain-ops/script-inspector.git
cd script-inspector
npm ci
npm test
```

Tests use Node.js's built-in test runner; the package has no runtime or development dependencies.

## Contributing

Focused bug reports and improvements are welcome. Include a small `package.json` example, the command that produced the finding, and the expected result. Run `npm test` before submitting a change.

## License

MIT. See [LICENSE](LICENSE).
