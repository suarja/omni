# Domain and state

The core distinguishes source, desired state, and observed files.

## Core records

| Record              | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `Source`            | A local, Git, HTTP, or provider catalogue locator                       |
| `Plugin`            | A published package with identity, version, license, and artifacts      |
| `Artifact`          | A skill, rule, agent, command, hook, MCP server, or resource            |
| `Project`           | A local codebase managed by Omni                                        |
| `Harness`           | A provider adapter such as Codex, Claude Code, OpenCode, or Cursor      |
| `Binding`           | A desired plugin or artifact assignment to a project and harness        |
| `Installation`      | An observed or owned materialized file state                            |
| `Operation`         | A plan, application, result, and recovery record                        |
| `InventorySnapshot` | Read-only evidence found at explicit project, source, or provider roots |

## Three states

Omni must keep these states separate:

```text
catalogue state → desired binding state → materialized/provider state
```

- Catalogue state says what a source exposes at a resolved revision.
- Desired state says what the user wants active for a project and harness.
- Materialized state says what files and provider installations exist now.

No state is inferred from another state without an observation step.

Observation is deliberately earlier and less strict than normalization. An inventory
snapshot may contain a loose skill, partial manifest, unknown artifact, broken symlink, or
per-location diagnostic that cannot yet become a valid catalogue package or installation.
Preserving that evidence is required for real-world compatibility.

## Invariants

- External source records preserve provider, locator, revision, license, and hashes.
- A personal fork gets a new owned identity and keeps origin provenance.
- An unmanaged or locally changed file is never silently overwritten.
- A target path is resolved by a harness adapter and stays inside an approved root.
- A plugin package and its child artifacts remain separately addressable.
- Provider caches are observed state, not source-of-truth records.
- Executable artifacts require a capability and approval boundary.

## Result model

Every boundary operation returns a typed result with success, warnings, or a recoverable
failure. A partial source or provider failure remains visible. The UI must distinguish
`current`, `missing`, `drifted`, `conflict`, `blocked`, and `unknown`.

## Implementation references

Inventory observation lives in `src/adapters/inventory/`. Assignment planning and target
resolution live in `src/domain/assignment-plan.ts` and `src/domain/harness-targets.ts`.
The main process owns filesystem operations and IPC.
