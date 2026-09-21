# Contributing to whim

Thanks for your interest in contributing!

## Development setup

Prerequisites:

- Node.js 20+
- GitHub Copilot CLI (`npm install -g @github/copilot`)
- A GitHub account with Copilot access

```bash
git clone https://github.com/patniko/whim.git
cd whim
npm install
npm run start
```

The app builds, launches, and appears in your system tray. Press `Ctrl+Shift+Space` to open.

For iterative development:

```bash
npm run dev    # build + tsc watch + esbuild watch + Electron
```

## Before opening a pull request

All PRs must pass CI, which runs:

```bash
npm run typecheck   # main, shared, renderer, and web production TypeScript
npm run lint        # oxlint src/
npm test            # vitest run
```

Please run these locally before pushing.

Regression tests should exercise the boundaries involved in the change: use
the real editor for merge races, real storage workers for persistence ordering,
and lifecycle handlers for workspace recovery. Keep fixtures in disposable
directories, never an existing user workspace. Coverage reporting includes all
four source surfaces; `npm test` also runs the renderer and web tests.

### Known issue on Windows

`src/main/integration.test.ts` has a small number of pre-existing `EBUSY` failures on Windows caused by SQLite file locking during test rebuilds. These are tracked separately and are not caused by your PR if they were already failing on `master`.

## Filing issues

Please use [GitHub Issues](https://github.com/patniko/whim/issues). When reporting a bug, include:

- OS and version (Windows / macOS)
- whim version (visible in the settings panel)
- Steps to reproduce
- Expected vs. actual behavior

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for an overview of the codebase layout and component responsibilities, and [`docs/user-guide.md`](./docs/user-guide.md) for end-user docs.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
