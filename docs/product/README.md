# Omni Desktop product premise

Omni Desktop is an open-source, local-first desktop application for a solo developer who
uses several agent harnesses across several projects. It manages marketplaces, plugins,
skills, project bindings, provenance, drift, and deterministic changes.

## Core promise

**Manage your AI tools once. Use them consistently across every project.**

Omni gives one personal view of what is available, what is desired, and what is actually
installed. It does not replace external marketplaces. It reads them, preserves their
identity and license information, and projects approved static artifacts into projects.

## Entry and daily loop

The first launch is a read-only audit, not an empty dashboard. The user chooses which local
projects, user-level harness configuration, and source folders Omni may inspect. Omni then
reports duplicated, divergent, unmanaged, stale, unavailable, or conflicting assets.

The next required act is to create a personal marketplace or connect an existing one. This
marketplace becomes the user's managed library and the source of truth for reusable skills,
plugins, instructions, rules, commands, agents, hooks, and MCP configuration.

The recurring workflow starts from this library or from a project:

1. choose an asset or project;
2. choose the intended projects;
3. let Omni detect compatible harness targets;
4. preview the deterministic file and provider changes;
5. approve, apply, and verify the result.

Omni must also detect out-of-band changes and offer an explicit choice: adopt the local
version into the personal marketplace or restore the managed version.

## Two product loops

- **Deterministic management:** install, remove, update, synchronize, preview, apply, verify,
  and recover across projects without requiring inference.
- **Audit and intelligence:** detect duplicates, divergence, scope shadowing, unknown
  provenance, stale versions, unavailable sources, incompatible projections, and local drift.
  Later inference may recommend consolidation or create a tailored asset, but it is not
  required for the core product.

## Real-state-first validation

The product must learn from existing local states rather than assume an ideal Omni-shaped
configuration. Project-local loose skills, user-level installations, cloned marketplaces,
provider-managed caches, missing manifests, mixed conventions, and stale or malformed
entries are first-class observations.

Synthetic fixtures remain useful for deterministic regression tests, but the target
contract never registers them as the default runtime catalogue or counts them as dogfood
evidence on their own. Sanitized regression cases should preserve the structure of an observed layout.

## V1 boundaries

- solo macOS developer;
- Codex, Claude Code, OpenCode, and Cursor skill compatibility;
- external and personal catalogue sources;
- static skill materialization after approval;
- read-only provider cache and executable-artifact inspection;
- no silent overwrite, direct cache deletion, hook execution, or Git write outside a
  previewed operation (Omni commits what it writes; the user can turn that off; no push).
- no account or network dependency for local inventory and deterministic reconciliation.

## Product states

```text
catalogue → desired bindings → materialized/provider state
```

Every user-facing change must identify its source, revision, scope, files, provider
actions, conflicts, and recovery path.
