# Codex conventions

Status: validated reference baseline

## Skills and instructions

Codex keeps persistent repository instructions separate from on-demand skills:

- `AGENTS.md` supplies instruction context through a global-to-local chain;
- `.agents/skills/<name>/SKILL.md` supplies a skill in a repository;
- `~/.agents/skills/<name>/SKILL.md` supplies a user skill;
- `/etc/codex/skills` supplies administrator skills;
- bundled skills are system-provided.

Omni must not model `AGENTS.md` as a skill. Both can affect an agent, but their lifecycle
and ownership are different.

## Plugin package

The native package requires:

```text
plugin/
├── .codex-plugin/plugin.json
├── skills/
├── hooks/
├── .mcp.json
├── .app.json
└── assets/
```

The manifest points to component roots with relative paths. Hooks, MCP, and apps are
capability-bearing components, not equivalent to Markdown skills.

## Marketplace

Codex supports repository and personal catalogues:

- `$REPO_ROOT/.agents/plugins/marketplace.json`;
- `~/.agents/plugins/marketplace.json`.

Entries can point to local paths, GitHub repositories, or Git subdirectories. Refs may
be branches, tags, or commit SHAs. Catalogue commands include add, list, upgrade, and
remove.

## Installation and updates

Workspace imports can track a branch, tag, or commit and may synchronize periodically.
Omni records the requested and resolved revisions independently. It never treats a
moving ref or a Codex cache as permission to overwrite a project file.

## Omni adapter rules

- Discover `AGENTS.md` and skills as separate artifact families.
- Normalize `.codex-plugin/plugin.json` and the Codex marketplace without rewriting it.
- Materialize static skills only after a plan is approved.
- Keep hooks, MCP, apps, and provider-owned installation state behind explicit adapters.

Sources: [Codex skills](https://developers.openai.com/codex/skills), [AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md), and [Codex plugins](https://developers.openai.com/plugins/build/plugins).
