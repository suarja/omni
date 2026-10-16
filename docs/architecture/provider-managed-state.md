# Provider-managed state

Provider-owned caches remain outside Omni file ownership.

## Why this is separate

An Omni-owned project file and a provider-owned plugin cache have different owners and
different lifecycle rules. The cache is derived from a source package and may be indexed,
signed, or migrated by the provider. Treating it as an ordinary target path would make
Omni depend on private implementation details.

## Observation record

```text
ProviderInstallation
├── assignmentId
├── harnessId
├── artifactId?
├── packageFormat
├── scope: project | user | host-managed
├── requestedRevision?
├── resolvedRevision?
├── providerRef?
├── packageState: not-installed | current | outdated | drifted | blocked | unknown
└── activationState: not-applicable | inactive | active | unknown
```

This record is evidence, not a second source of truth. The source snapshot remains
canonical.

## Hooks and executable artifacts

Hooks, MCP servers, plugin JavaScript, agents with tools, and commands are visible in the
catalogue and compatibility report. Their `executionClass` and capabilities determine
the trust boundary.

Omni may inspect, hash, diff, and plan them. It does not execute, activate, install, or
remove them without an explicit provider-mediated action and approval.

## Provider action contract

```text
ProviderAction
├── kind: install | update | uninstall | activate | deactivate
├── assignmentId
├── harnessId
├── artifactId?
├── requiresApproval: true
└── rationale
```

The adapter may use an official CLI, API, or host integration. The reconciler must not
write into a private cache or run a hook itself.

## Validation gates

Real observations must first prove that cache presence, selected version, activation, and
authentication are distinct. Regression cases then cover current, outdated, drifted,
blocked, and unknown states, plus an inactive hook that requires activation. The UI must
show provider actions and consequences before approval. Observation alone never authorizes a write.
