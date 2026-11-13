# Contributing

Focused bug reports and improvements are welcome. Keep changes small, explain the behavior they address, and update tests or documentation when behavior changes.

## Development setup

Use Node.js 22 or newer, then install from the lockfile and run the test suite:

```sh
npm ci
npm test
```

The project uses Node.js's built-in test runner and has no development dependencies.

## Bug reports and pull requests

- Include a minimal `package.json` and the command that demonstrates the issue.
- Describe the current result and the expected result.
- Add a regression test for a confirmed bug.
- Run `npm test` before opening a pull request.
- Do not run commands from test fixtures; the analyzer is designed to inspect them as data.

The parser is intentionally conservative. If a command cannot be analyzed safely, prefer an inconclusive result over a definite finding based on a guess.
