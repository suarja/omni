# Adapters and projections

Adapters own effects and provider-specific conventions.

## Core boundaries

The core depends on narrow ports and services:

- `SourceAdapter` discovers and normalizes a catalogue snapshot;
- `HarnessAdapter` detects a harness and resolves safe target roots;
- `FilePort` reads, hashes, backs up, and applies bounded file changes;
- `Reconciler` consumes normalized records and emits bounded plans.

## Normalized package shape

```text
Plugin
├── providerId
├── packageFormat
├── catalogueFormat
├── externalId
├── requestedRevision
├── resolvedRevision
├── license
└── artifacts[]
    ├── kind
    ├── relativePath
    ├── contentHash
    ├── executionClass
    └── invocationPolicy
```

`omni.plugin.json` is Omni's normalized export. An external provider does not need to
adopt it. The adapter retains the original manifest path and provider metadata.

## Adapter responsibilities

An adapter owns provider-specific discovery, parsing, identity, precedence, scopes,
update keys, and runtime policy. It must not leak arbitrary filesystem or process access
to the renderer or MCP client.

The reconciler consumes normalized records and emits bounded plans. It does not branch on
`.claude-plugin`, `.codex-plugin`, `.cursor-plugin`, or `.opencode` paths itself.

## Runtime registries

`SourceRegistry` owns the ordered source registrations and validates snapshot identity
(`sourceId`, `providerId`, and `locator`) before returning a snapshot. `HarnessRegistry`
owns the available projection targets; callers select a harness explicitly by its
descriptor ID.

Source adapters remain the source-of-truth boundary for provider discovery and normalized
snapshots. Harness adapters own provider-specific target resolution. The reconciler
consumes the selected source snapshot and harness adapter to emit a bounded plan. The
renderer receives descriptors from the runtime; it does not discover provider files or
branch on provider directory names.

Provider-specific adapters require convention evidence. Project and source observations
are the runtime inputs.

## Observation before normalization

Real local state does not always form a valid package. Discovery therefore emits observed
locations and artifacts before catalogue normalization:

```text
filesystem roots → observed evidence + diagnostics → normalized source/package records
                                                ↘ provider-managed state
```

A loose `SKILL.md`, partial manifest, unknown file, inaccessible directory, or stale cache
remains visible evidence. It must not be discarded merely because it cannot become a
complete `Plugin`. Errors are attached to the affected location so one broken root does not
erase a usable inventory.

## Projection rules

- A portable `SKILL.md` can project to validated provider skill roots.
- A provider rule remains a `rule` artifact unless the user explicitly requests a
  conversion.
- A plugin bundle remains a bundle in the catalogue even when one child skill is bound.
- Hooks, MCP servers, agents, and commands are capability-bearing artifacts.
- Host-managed plugin installation produces a provider action, not a file target.

## Agent bootstrap topology

The Codex plugin is a discovery entry, not the Desktop application. It provides the
skills and a portable stdio MCP runtime. Omni remains the local authority: it
owns the authenticated socket, marketplace state, previews, approvals, receipts, and
materialized runtime. The harness owns the session, model, quota, and agent loop.

The bootstrap sequence is deterministic:

```text
agent → omni_bootstrap_status → plugin/runtime + Desktop + harness checks
                              ↘ one nextAction
agent → omni_status → discovery → preview → explicit approval → omni_apply
```

`omni_bootstrap_status` may start the installed Desktop in the background for the default
profile. It does not edit harness configuration. It must distinguish these states rather than
collapsing them into “Omni is unavailable”:

- plugin/MCP absent: the skill can only recommend installing the plugin;
- runtime present but Desktop not detected in standard locations: install Desktop or open an existing non-standard installation;
- Desktop installed but closed: the runtime tries one background launch for the default profile,
  waits up to 20 seconds for the socket, and retries the call once. If still unreachable,
  open Desktop manually; the current session reconnects on its next call;
- Desktop reachable but direct registration missing: use Settings → Agents;
- Desktop reachable through the plugin or direct registration: continue with `omni_status`.

The MCP process may inspect provider configuration to explain the state, but it never
writes a provider-owned plugin cache or silently creates a replacement `SKILL.md`.

## Compatibility status

Each artifact-to-harness pairing is `native`, `mapped`, `unsupported`, or `unknown`.
Unknown is not treated as supported. A plan fails with an actionable explanation instead
of silently dropping an artifact.

## Regression corpus

Regression cases are sanitized snapshots derived from real projects, marketplaces, or
provider-managed layouts (for example `tests/fixtures/personal-marketplace/`) and record
their origin class. Synthetic malformed cases are acceptable only for
boundary conditions that cannot be safely preserved from real state. No fixture is loaded
as a default user source.
