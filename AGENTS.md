# Repository Guidelines

## Project Structure & Module Organization
This repository is currently a minimal scaffold with no committed source files or Git metadata in the workspace. Add new code with a predictable layout:

- `src/` for application or library code
- `tests/` for automated tests that mirror `src/`
- `assets/` for static files such as images or fixtures
- `docs/` for design notes, ADRs, or usage guides

Keep modules focused and small. Prefer feature-oriented folders once the codebase grows, for example `src/auth/`, `src/cli/`, or `src/api/`.

## Build, Test, and Development Commands
No build system is configured yet. When adding tooling, expose the main workflows through a single entrypoint such as `Makefile`, `package.json`, or language-native scripts.

Examples:

- `make build` to produce distributable artifacts
- `make test` to run the full automated test suite
- `make lint` to run formatters and linters

If you introduce another command surface, document it in `README.md` and keep command names consistent across languages.

## Coding Style & Naming Conventions
Use the standard formatter for the language you add rather than hand-formatting. Keep naming predictable:

- directories and file names: `kebab-case`
- variables and functions: language-standard style
- classes and types: `PascalCase`

Write small functions, avoid deeply nested logic, and prefer explicit names over abbreviations. Keep configuration files near the repo root unless a tool requires otherwise.

## Testing Guidelines
Add tests with every non-trivial change. Mirror the production path when naming tests, for example `src/api/client.*` with `tests/api/client.test.*`. Favor fast, deterministic tests and keep fixtures under `tests/fixtures/` when needed.

## Commit & Pull Request Guidelines
There is no local Git history in this workspace yet, so no project-specific commit pattern can be inferred. Use concise, imperative commit messages, ideally Conventional Commits such as `feat: add CLI bootstrap` or `fix: handle empty config`.

Open small pull requests with:

- a short problem statement
- a summary of changes
- test or lint commands run
- screenshots or logs when UI or CLI output changes

## Configuration & Security
Do not commit secrets, tokens, or machine-local settings. Check in sample config files such as `.env.example` instead of live credentials.
