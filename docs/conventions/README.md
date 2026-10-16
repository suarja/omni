# Harness conventions

Status: validated reference baseline

This folder is the provider reference for Omni adapters. It records where each harness
finds skills and plugins, how it identifies packages, how it refreshes sources, and
which artifacts can execute code.

## Pages

- [Claude Code](claude-code.md)
- [Codex](codex.md)
- [OpenCode](opencode.md)
- [Cursor](cursor.md)

## Shared model

The portable unit is an Agent Skill: a directory containing `SKILL.md` with YAML
frontmatter, Markdown instructions, and optional `scripts/`, `references/`, and `assets/`.
The portable package unit is an Agent Plugin with a root `plugin.json`, `skills/`, and
optional `mcp.json`.

These standards do not remove provider differences. A marketplace or HTTP index points
to a package, and a provider manifest declares how the package is loaded. Omni preserves
all three layers:

```text
catalogue → package/plugin → child artifacts → harness projection
```

## Omni rules

- Preserve the original provider, manifest path, identifier, revision, license, and
  content hash.
- Keep `skill`, `rule`, `agent`, `command`, `hook`, `mcp-server`, and `resource` as
  distinct artifact kinds.
- Treat provider caches as observed state, not source-of-truth files.
- Treat hooks, MCP servers, and executable plugins as explicit trust boundaries.
- Resolve project and user targets through adapters. Never infer a target from a package
  manifest alone.

## Canonical sources

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Plugins specification](https://agent-plugins.org/specification)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Codex skills](https://developers.openai.com/codex/skills)
- [OpenCode skills](https://opencode.ai/v2/docs/skills)
- [Cursor Agent Skills](https://cursor.com/docs/skills)

Update a page when a provider changes a documented path, manifest, scope, precedence
rule, or installation behavior. Record the verification date in the commit or research
note rather than adding a long changelog to the page.
