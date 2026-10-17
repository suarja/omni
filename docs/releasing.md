# Releasing Omni

Omni releases are built from a clean Git snapshot. Local commits, remote tags, draft creation
and publication are separate actions. The workflow creates a **draft**; the maintainer reviews
and publishes it manually. Never upload ad-hoc builds for public distribution.

## Prepare a version

1. Run `pnpm release:version 1.2.3` or `pnpm release:version 1.2.3-rc.1`.
   These are fictional example versions. The command changes `package.json`, the MCP runtime
   version and a new `CHANGELOG.md` section together. Edit that section with the actual changes.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm test --maxWorkers=4`, `pnpm test:release`,
   `bash scripts/check-line-counts.sh`, `bash scripts/check-doc-structure.sh` and `pnpm check:public`.
   In the private source repository also run `pnpm verify:public /tmp/omni-public-example`
   with a new empty target. This installs and tests the exported tree without starting Electron.
3. Commit the exact release changes. Run `pnpm release:version --check v1.2.3`.
   Only after explicit authorization, create and push the matching `v<version>` tag.
4. GitHub Actions validates the tag and both versions before importing any credentials, then
   builds, signs and notarizes on `macos-14` with an explicit arm64 architecture check.
5. Review the draft's notes, checksums and artifacts. Test a quarantined download on a separate
   Mac, launch the app, test MCP and the explicit update/restart journey, then publish manually.

The version command never creates tags or commits. The release command refuses dirty tracked
files, an existing output directory, mismatched versions and incomplete notarization inputs.
A failed release leaves its incomplete output for inspection; retry in a new directory.

## Configure GitHub Actions secrets

Only repository administrators should provision the following five secrets. Never commit a
certificate, private key, password, key contents or decoded credential. Do not print them in logs.

| Secret | How the owner creates it |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | In Keychain Access, export the Developer ID Application certificate **with its private key** as a password-protected `.p12`. Base64-encode that file directly into the GitHub secret input. |
| `MACOS_CERT_PASSWORD` | The password chosen for that `.p12` export. Use a nonempty password. |
| `ASC_KEY_P8_BASE64` | In App Store Connect, Users and Access, Integrations, create an API key authorized for notarization. Download its `.p8` once and base64-encode it directly into this secret. |
| `ASC_KEY_ID` | The API key's Key ID from App Store Connect. |
| `ASC_ISSUER_ID` | The API key's Issuer ID from App Store Connect. |

For example, on the owner's machine, pipe `base64 < /secure/example/certificate.p12` into
`gh secret set MACOS_CERT_P12_BASE64`, and do the same for `/secure/example/AuthKey.p8` and
`ASC_KEY_P8_BASE64`. These paths are fictional. Set the other values through GitHub's secret
form or `gh secret set` interactive input. This documentation does not authorize execution.

The workflow selects the Developer ID identity from the temporary keychain and checks its
team, without embedding a person's certificate subject in the public source. The public team
ID, bundle ID and update repository are centralized in `resources/release-identity.json`.
Renew the certificate before its expiry and replace the certificate secrets when needed.
The certificate must include Apple's Developer ID intermediate chain on the signing runner.

The workflow imports into a temporary keychain, writes a mode-600 API key file and passes
its keychain explicitly to codesign. An `always()` step deletes the keychain, `.p12` and `.p8`
before creating the draft. No credential is a release artifact. Cleanup failure fails the job.
The built-in `GITHUB_TOKEN` creates the draft with job-scoped `contents: write`; no PAT is needed.

## Signing and artifacts

For a local ad-hoc build, leave all `OMNI_SIGN_*` and `OMNI_NOTARY_*` variables unset and run
`pnpm release:mac /tmp/omni-release-example` in a clean checkout. No certificate or keychain is
needed. `release.json` records `signing: ad-hoc-local-only` and `notarized: false`.

For an authorized signed build, the packager accepts `OMNI_SIGN_IDENTITY` and optionally
`OMNI_SIGN_KEYCHAIN`. Notarization also requires `OMNI_NOTARY_KEY_PATH`, `OMNI_NOTARY_KEY_ID`
and `OMNI_NOTARY_ISSUER`. CI requires all of them and an agreeing release tag.

The signed pipeline compiles the MCP launcher, signs Mach-O objects and nested bundles
inside-out with timestamps and hardened runtime, then seals the outer app. It verifies each
binary and bundle with `codesign --verify --strict`; signing never uses `--deep`.
Only `com.apple.security.cs.allow-jit` is enabled for Electron/V8 in app/helper bundles.
Electron 36 does not require unsigned executable memory. No library-validation, sandbox,
get-task-allow or resource-access exceptions are added. See [Electron notarization prerequisites](https://github.com/electron/notarize#prerequisites).

The shell MCP launcher remains unchanged in local ad-hoc builds. Signed builds use a native
launcher because shell-script signatures depend on extended attributes. Gatekeeper assesses
the notarized enclosing application, which seals its nested code; dylibs and scripts are not
independent Gatekeeper distributions.

The app is zipped for `notarytool submit --wait`, stapled and validated, then assessed with
`spctl`. The final update ZIP is made from that stapled app. A compressed DMG contains the
same app and an Applications shortcut; the DMG is signed, submitted, stapled and assessed too.
A rejected submission fails the job and reports its notary log ID. Retrieve the log using
`xcrun notarytool log <id>` with the same API credentials before retrying.

Artifacts use the following names, with actual version and architecture substituted:

- `Omni-<version>-mac-<arch>.zip`
- `Omni-<version>-<arch>.dmg`
- `SHA256SUMS`, including both artifacts and `release.json`
- `release.json`, including source commit, version, architecture, signing mode, notarization,
  artifact names and hashes, plus separate signature and Gatekeeper results

Verify downloaded files with `shasum -a 256 -c SHA256SUMS`.
arm64 is required. Intel builds are feasible as a separate x64 Electron installation on an
Intel runner. Cross-packaging x64 on the arm64 runner is also feasible after adding an explicit
target architecture and fetching x64 Electron; this packager currently labels the host architecture.
Universal builds need both Electron distributions and a validated merge before signing, using
[@electron/universal](https://github.com/electron/universal). Neither is currently produced. Two architectures roughly double build/sign/notary work and
storage. Universal archives are larger because they contain both executable slices.
Standard runners are free for public repositories; private runs consume the account's included
minutes or paid macOS usage. See [GitHub runner availability](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

## Updates and existing installations

The updater uses Electron's `autoUpdater` through `update-electron-app`, pointed at
`update.electronjs.org` for the public repository. It requires packaged macOS, release metadata,
the default profile, Developer ID metadata and a valid Apple/team/bundle signature. DEV,
tests, smoke/demo profiles and ad-hoc builds never initialize it. No account or telemetry is added.
The service needs a public GitHub repository and published releases; drafts and pre-releases
are not a beta update feed. See the [public update service](https://github.com/electron/update.electronjs.org).
Tags containing a Semver prerelease create GitHub pre-release drafts.

Settings has a default-on "Install updates automatically" switch. Turning it off persists
immediately and stops periodic checks; turning it on resumes checking. An in-flight Electron
transfer cannot be canceled by this API, and an already staged native update may still apply
on a later normal quit. The quiet notification and Settings action restart only after an
explicit click. Preferences live under the existing profile in `omni/app-updates.json`.

The bundle ID is `io.github.suarja.omni`, defined in `resources/release-identity.json`.
The release profile is `~/Library/Application Support/Omni`; DEV uses
`~/Library/Application Support/Omni Dev`. Each starts fresh. There is no profile migration,
previous-folder lookup or bundle-ID compatibility path.

## Roll back a publication

Delete the affected GitHub Release to stop offering it. Installed users keep their current
version; auto-update does not downgrade them. Publish a corrected release with a higher
version after validation. Do not reuse an already distributed version or tag. An unpublished
draft can be deleted and regenerated after fixing its source or credentials.
