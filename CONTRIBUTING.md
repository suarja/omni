# Contributing to Omni

Read the [product premise](docs/product/README.md), [architecture](docs/architecture/README.md),
and [harness conventions](docs/conventions/README.md) before changing behavior.
Open an issue before a substantial feature or core change. Keep pull requests focused.

## Development

Use macOS, Git, Node.js 24 or later, and pnpm 10.33.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm test --maxWorkers=4
bash scripts/check-line-counts.sh
bash scripts/check-doc-structure.sh
```

`pnpm build` builds the desktop bundles and local plugin runtime. It does not publish a release.
`pnpm lint` runs the repository's Prettier checks. Format each changed file before submitting.

## Code and documentation

Write new source, identifiers, comments, tests, documentation, and commit messages in English.
Keep modules focused and public boundaries explicit. Prefer pure functions for parsing,
normalization, resolution, and validation. Keep filesystem, process, and network effects in adapters.
Export only what another module needs, with explicit return types for public TypeScript APIs.

A hand-authored source or test file should stay below 500 physical lines and must never
exceed 1,000. The repository check may enforce a tighter limit. Generated files, build output,
vendor files, dependency directories, and lockfiles are excluded. Do not edit generated output
by hand; use its build script.

Canonical Markdown targets 150 lines and must not exceed 200. Each documentation directory
contains at most five direct files, including its index. Split by responsibility and update
links when a page grows.

## Safety invariants

- Treat external marketplaces and provider caches as read-only unless an operation explicitly authorizes a change.
- Preserve source, revision, license, and content hash provenance.
- Keep catalogue state, desired bindings, and observed files distinct.
- Report locally modified files as drift or conflict. Never silently overwrite them.
- Never execute plugin scripts or hooks automatically.
- Make destructive actions explicit, previewable, and recoverable where possible.
- Keep partial failures visible and provide a safe recovery path.

Add focused deterministic tests for new invariants, parser rules, and destructive-operation guards.
Use synthetic names, paths, addresses, and transcripts in fixtures. Include no personal profiles,
private projects, credentials, or captures of real user data.

## User interface changes

Explain the intended behavior and provide before-and-after evidence for affected screens at
matching viewport and theme. Keep product and design decisions reviewable before implementation.
Report visual validation as PASS, FAIL, or NOT RUN, with a reason for missing evidence.

## Platform contributions

Only macOS is currently supported. Platform behavior belongs behind the interfaces in
`src/main/platform/`. A proposed platform adapter needs deterministic sanitized fixtures,
checks on that platform, and visual evidence for affected operations. Passing macOS tests alone
does not establish support for another platform.

## Pull requests

Describe the problem, resulting behavior, relevant validation, and remaining limitations.
Stage only files belonging to the change. Keep unrelated edits out of the pull request.
Report vulnerabilities through [private security reporting](SECURITY.md).
