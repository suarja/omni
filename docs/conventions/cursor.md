# Cursor conventions

Status: validated reference baseline

## Agent Skills

Cursor discovers Agent Skills from project `.cursor/skills` and `.agents/skills`, user
`~/.cursor/skills` and `~/.agents/skills`, and compatibility paths such as
`.claude/skills` and `.codex/skills`. It walks nested directories and supports scripts,
references, and assets. `name` and `description` are required; `paths` can scope a skill
to matching files.

## Plugin formats

Cursor supports two formats:

1. Portable Agent Plugins use a root `plugin.json`, `skills/`, and optional `mcp.json`.
2. Cursor Plugins use `.cursor-plugin/plugin.json` and can add rules, agents, commands,
   hooks, variables, and other Cursor-specific components.

The official [`cursor/plugins`](https://github.com/cursor/plugins) repository is a
multi-plugin marketplace. Its root `.cursor-plugin/marketplace.json` lists plugin source
directories. Each plugin has its own manifest.

## Skills, rules, and hooks

Cursor rules under `.cursor/rules/*.mdc` remain a separate artifact family. `globs` and
`alwaysApply` trigger semantics must not be flattened into a skill. Skills can carry
provider fields such as `disable-model-invocation: true`, which normalizes to a
user-only invocation policy.

The `pstack` package is the reference fixture: one marketplace entry, one Cursor Plugin,
many child skills and agents, and additional automation material. Its
[`unslop` skill](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md)
is a static child artifact, not a separate marketplace package.

## Refresh and installation

Cursor can install plugins from Git repositories and refresh imported team marketplaces.
Its plugin cache and activation state are provider-managed. Omni observes and plans these
states but does not write the cache directly or activate hooks without approval.

Sources: [Cursor skills](https://cursor.com/docs/skills), [plugins](https://cursor.com/docs/plugins), and [plugin reference](https://cursor.com/docs/reference/plugins).
