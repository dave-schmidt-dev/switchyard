# Changelog

Noteworthy changes follow [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html); the compatibility contract is in [README.md](README.md).

## [Unreleased]

- Partition the remaining contract test families into bounded files while preserving registrations, scoped hooks, runtime leaf results and incident mutation coverage.

### Changed

- Split runner, dispatch CLI, and detached-dispatch coverage into 55, 24, and 18 flat test files; keep VM-sensitive test execution explicit and TAP-reported.

### Fixed

- Keeps fixture-only contract execution nonzero in each detached-dispatch part while preserving the original VM skips.

- Contract gates handle large staged refactor patches with a bounded Git-output buffer, preserving complete snapshot digests.

- Test splitting preserves generated registrations, scope, source order, hooks, and initialization effects. Unsupported partial registration shapes are rejected before writing output.
- Split test files copy the helpers and imports referenced by their selected tests, avoiding dependencies used only by unselected tests.
