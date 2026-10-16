# Claude Code conventions

Status: validated reference baseline

## Skills and scopes

Claude Code discovers skills from:

- project: `.claude/skills/<name>/SKILL.md`;
- user: `~/.claude/skills/<name>/SKILL.md`;
- plugins: `<plugin>/skills/<name>/SKILL.md`;
- managed enterprise settings.

Plugin skills are namespaced as `plugin-name:skill-name`. Project and plugin precedence
must be recorded by the adapter rather than guessed from a filename.

## Plugin package

The native package layout is:

```text
plugin/
├── .claude-plugin/plugin.json
├── skills/
├── commands/
├── agents/
├── hooks/
└── .mcp.json
```

Only `plugin.json` belongs in `.claude-plugin/`. Skills are static instruction artifacts;
commands, agents, hooks, and MCP servers may change runtime behavior.

## Marketplace

The catalogue is normally `.claude-plugin/marketplace.json`. An entry identifies a
plugin and a source. Sources may be GitHub, Git, local paths, URLs, npm packages, or
archives. Branches, tags, and commits can be pinned.

The marketplace source and plugin source may be separate. Omni stores both locators,
the requested ref, the resolved revision, the manifest hash, and the content hash.

## Installation and updates

Claude can cache marketplace plugins under `~/.claude/plugins/cache` and supports user,
project, and local installation scopes. The cache is provider-owned derived state. Omni
may inspect it, but must use an approved provider operation for update or removal.

## Omni adapter rules

- Read marketplace and plugin manifests without executing their contents.
- Project skill files can use the deterministic file reconciler.
- Hooks, agents, commands, and MCP servers require explicit capability and trust review.
- `disable-model-invocation`, `user-invocable`, and related frontmatter are preserved as
  provider metadata and normalized into an invocation policy.

Source: [Claude Code plugins](https://code.claude.com/docs/en/plugins), [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), and [plugin reference](https://code.claude.com/docs/en/plugins-reference).
