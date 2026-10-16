# Sanitized inventory cases

Inventory cases describe observed local state without claiming installation, enablement, authentication, currentness, or removability.

Cases must use stable aliases instead of personal absolute paths (for example `project`, `user`, `source`, and `provider-cache`). They must contain no secrets, credentials, private file contents, or proprietary source text. Each case records its provenance and source class, such as `fixture`, `sanitized-local-observation`, or `diagnostic-only`, and states the expected inventory classification.

Aliases are part of the case contract: keep them non-empty, stable between runs, relative or redacted, and free of absolute-path or traversal segments. A case should identify the observed scope, artifact kind, confidence, symlink state, provider identifiers, and any deliberately unknown provider states.

## M2B2 source layout

Origin class: `sanitized-local-observation`. The case mirrors a personal marketplace with declared and undeclared packages, mixed known manifests, an implicit skill package, a malformed manifest, loose root evidence, and an ignored `.git` directory.
