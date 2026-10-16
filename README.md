# Omni Desktop

Omni Desktop is a local-first macOS application for managing agent skills, plugins,
marketplaces, and project assignments. It reads existing Codex, Claude Code, OpenCode,
and Cursor conventions and shows what is installed, duplicated, changed, or missing.

Connect a marketplace, inspect your projects, preview a change, then approve it.
Omni records operations and recovery information. It never silently overwrites local
changes or automatically executes plugin hooks. Local inventory and deterministic
reconciliation work without an account or inference service.

## Install

Download the macOS application from this repository's [Releases](../../releases).
Use the installation instructions attached to the release you choose. macOS is the
only supported platform for now.

## Build from source

Install Git, Node.js 24 or later, and pnpm 10.33.0. From a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

To build the application bundles without packaging a release:

```sh
pnpm build
```

Run checks before contributing:

```sh
pnpm typecheck
pnpm lint
pnpm test --maxWorkers=4
bash scripts/check-line-counts.sh
bash scripts/check-doc-structure.sh
```

## Use Omni from your agents

The bundled stdio MCP runtime connects agents to the running desktop application's
local authenticated gateway. The desktop owns state, previews, approvals, and receipts.
The MCP runtime does not write marketplace or project files directly.

Use Settings → Agents in Omni Desktop to install its tools for a harness, then open a
new agent session. See the [MCP runtime guide](packages/omni-mcp/README.md) for manual
configuration and bootstrap diagnostics.

## Documentation

- [Product and documentation index](docs/README.md)
- [Architecture](docs/architecture/README.md)
- [Harness conventions](docs/conventions/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

## License

Omni Desktop is available under the [MIT license](LICENSE).
