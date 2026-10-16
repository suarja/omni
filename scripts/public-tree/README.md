# Public tree export

`manifest.json` is the single exclusion and image-approval policy. Exclusions are literal
repository-relative files or directories, not globs. Image approval names an exact file.
An empty allowlist deliberately blocks all images until they receive visual review.

```sh
pnpm check:public
pnpm check:public /tmp/candidate-tree
pnpm export:public /tmp/new-public-tree
```

The default check and export read an immutable `HEAD` snapshot through `git archive`.
Commit intended changes first. Dirty and untracked files never enter the snapshot.
Use an empty destination outside this checkout. The exporter never initializes a repository,
pushes, publishes, or changes the source checkout. It checks in scratch space before copying
anything to the destination. A failed check leaves the destination empty.

The checker rejects private terms, personal homes other than the `example` home, emails
outside `example.com` or noreply addresses, unapproved images, files over 5 MiB, links into
excluded paths, excluded entries, and symbolic or special files. URL credentials and Git
transports are parsed as transports, not email addresses. Private terms are case-insensitive.
Images are recognized by extension and common file signatures; this is not OCR.

The private repository maintains an optional `private-terms.txt` beside the manifest.
Use one term per line; blank lines and lines beginning with `#` are ignored. Keep this file
excluded. The export reads its committed version. An explicit-directory check reads the local
policy and terms. A public checkout without this private file still enforces structural rules;
it cannot check owner-specific terms that it does not have.

Check before installing dependencies in a candidate tree. An explicit-directory check scans
every entry, including untracked files and dependency directories. It never follows symlinks.
Approval of an image applies to the named path, so re-review replacement image bytes before
exporting. A successful check proves only these deterministic rules and the manifest policy.

## Verify a fresh public checkout

```sh
pnpm verify:public /tmp/new-public-verification
```

Verification exports committed `HEAD`, initializes one commit as
`Ada Example <ada@example.com>`, installs with `pnpm install --frozen-lockfile`, and runs
`typecheck`, `lint`, then the full Vitest suite with four workers. It never starts Electron.
The target must be empty and outside the source checkout. Leave failed targets for inspection;
retry in a new directory. Installation may need network access to the package registry.

The test reporter counts collected files, tests, passed/skipped/failed tests, empty files and
unhandled errors. Any command failure, unhandled error, failed file, or zero-test file fails
verification. A missing report also fails. Collected skipped tests remain visible in the counts.

Every exported text format is checked for literal paths into excluded trees, including source,
shell, tests and JSON. Paths are checked from the repository root and containing directory;
encoded traversal and backslashes are normalized. Policy declarations in the manifest's
`exclusions` array are the only content exemption. Bare domain names such as instruction
filenames and directory ignore names are not paths; explicit relative paths are checked.
The scanner does not evaluate dynamically constructed paths. Keep runtime fixture paths scoped
to synthetic projects, and test the exported tree to catch missing runtime inputs.
