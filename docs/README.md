# Omni Desktop documentation

- [Product premise](product/README.md) describes the local-first workflow and safety boundaries.
- [Architecture](architecture/README.md) explains state, adapters, reconciliation, and ownership.
- [Harness conventions](conventions/README.md) records provider-specific paths and package formats.
- [MCP runtime](../packages/omni-mcp/README.md) covers agent configuration and approval behavior.
- [Releasing](releasing.md) covers signing, notarization, draft releases and updates.
- [Contributing](../CONTRIBUTING.md) lists development checks and contribution requirements.

Canonical Markdown targets 150 physical lines and must not exceed 200. Each documentation
directory contains at most five direct files, including its index. Split by responsibility
and update the nearest index when a page grows.
