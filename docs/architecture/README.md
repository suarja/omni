# Omni Desktop architecture

This page describes the local application boundaries.

## Current direction

Omni should use a local-first ports-and-adapters architecture with a small domain core.
The domain vocabulary follows Domain-Driven Design, but the first implementation should
use only the tactical patterns that improve clarity: explicit records, value-like IDs,
ports, and deterministic services. It should not introduce a large framework or a full
aggregate hierarchy before the first vertical slice proves the boundaries.

```text
Desktop UI → local application API → observation services → inventory evidence
                                  → application services → domain core
                                  → ports → filesystem, Git, provider adapters
```

The renderer never receives arbitrary filesystem access. Adapters own network, process,
filesystem, and provider-specific behavior.

## Registry boundary

The project/source registry is a main-process, versioned local store. It owns durable entry
identity and canonical local-directory locators; the renderer receives only redacted entry
views. Opening an entry issues a short-lived grant bound to the entry and filesystem identity.
Read-only observation returns a subject-bound `InventorySnapshot`. Archive keeps the
root on disk. Writes require a separate preview and approval.

## Canonical pages

- [Domain and state](domain-and-state.md)
- [Adapters and projections](adapters-and-projections.md)
- [Git and reconciliation](git-and-reconciliation.md)
- [Provider-managed state](provider-managed-state.md)
