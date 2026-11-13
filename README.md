# script-inspector

Inspect a Node.js project's `package.json` scripts for common setup problems before you run them.

`script-inspector` reads project files and prints findings. It never executes package scripts or other shell commands.

**Repository:** [azmolwasimhussain-ops/script-inspector](https://github.com/azmolwasimhussain-ops/script-inspector) · [Issues](https://github.com/azmolwasimhussain-ops/script-inspector/issues)

## Installation

After the package is published:

```sh
npm install --save-dev script-inspector
```

You can also run it without adding it to your project:

```sh
npx script-inspector
```

## Usage

Run it from a Node.js project folder:

```sh
npx script-inspector
```

Or pass a project folder or direct `package.json` path:

```sh
npx script-inspector ./my-app
npx script-inspector ./my-app/package.json
```

For example, if `dev` runs `node src/server.js` but that file is missing, the report points to the script and path:

```text
script-inspector: my-app
Checked 2 scripts.
ERROR [node-entry-not-found] Script "dev" points to missing Node.js entry "src/server.js".
  Fix: Correct the path or add the referenced file to the project.
Summary: 1 error(s), 0 warning(s).
```

### Options

```text
script-inspector [project-path] [options]

--json       Print a machine-readable JSON report
--strict     Return a failing exit code when warnings are found
-h, --help   Show help
-v, --version Show the installed version
```

To check it automatically in CI, add a script to your own `package.json`:

```json
{
  "scripts": {
    "inspect:scripts": "script-inspector --strict"
  }
}
```

## Checks

- **Missing Node.js entry files:** checks literal file targets in common commands such as `node src/index.js`.
- **Missing npm scripts:** checks simple nested calls such as `npm run build` against the project's scripts object.
- **Undeclared common CLI tools:** warns when recognized tools such as Vite, ESLint, TypeScript, Jest, or Vitest are used without the matching package in the manifest.
- **POSIX environment assignments:** warns about forms such as `NODE_ENV=production node app.js`, which may not work in Windows shells.

The checker understands common command separators (`&&`, `||`, `;`, and `|`) and quoted arguments. It does not try to understand every shell, wrapper, workspace setup, dynamic variable, or custom executable. Findings are static hints; commands are never run.

## Exit codes

- `0`: no errors were found. Warnings do not fail by default.
- `1`: at least one error was found, or `--strict` was used and warnings exist.
- `2`: the project configuration could not be read, or the CLI arguments were invalid.

## JavaScript API

```js
import { inspectProject } from "script-inspector";

const report = await inspectProject("./my-app");
console.log(report.summary);
console.log(report.findings);
```

`inspectProject(projectPath)` accepts a project directory or a path to `package.json`. It returns the project path, the number of scripts inspected, a `fatal` flag, a findings array, and error/warning counts.

Each finding includes a severity, a stable code, a message, and a suggested next step. Some findings also include the script name, command, or target involved.

## Development

```sh
npm test
```

The test suite uses Node.js's built-in test runner, so the package has no runtime dependencies.

## Limitations

This is a static checker, not a shell interpreter. It only checks known command patterns and a curated list of common CLI packages. Complex shell expressions may be skipped or may need a human review. A warning means the package is not declared in this package's manifest; it may still be supplied by a workspace or the user's machine.

## Contributing

Bug reports and focused improvements are welcome. Include a small `package.json` example and the expected finding when reporting a detection issue.
