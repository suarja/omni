# OpenCode conventions

Status: validated reference baseline

## Skills

OpenCode V2 discovers skills from:

- project `.opencode/skills`;
- compatible project `.claude/skills` and `.agents/skills`;
- global `~/.config/opencode/skills`;
- compatible global paths;
- explicit local or HTTP sources in `opencode.json` or `opencode.jsonc`.

An OpenCode skill can be a `SKILL.md` directory or a Markdown file. The directory form
is preferred because scripts, references, and assets stay beside the entrypoint.

OpenCode can consume an HTTP `index.json` that lists skill files and a version. A changed
catalogue version refreshes the cached files.

## Identity and precedence

V2 derives the runtime skill ID from the path. IDs are case-sensitive and later sources
override earlier definitions. Frontmatter `name` is a display field for this purpose,
not the sole identity key. Omni stores both the provider ID and normalized identity.

## Plugins

OpenCode plugins are JavaScript or TypeScript modules from:

- project `.opencode/plugins/`;
- global `~/.config/opencode/plugins/`;
- npm or Git package entries in `opencode.json(c)`.

An OpenCode plugin is not an OpenCode skill. Plugins can execute code and register tools;
skills are instruction bundles. Omni uses separate adapters and capability classes.

## Omni adapter rules

- Support portable skill inspection and static projection first.
- Treat HTTP skill catalogues as a source format, not as a plugin manifest.
- Preserve path-derived IDs, source order, exact revisions, and catalogue versions.
- Keep executable plugin installation and cache mutation provider-managed.
- Preserve OpenCode-specific `slash`, `autoinvoke`, and metadata fields.

Source: [OpenCode skills](https://opencode.ai/v2/docs/skills) and [OpenCode plugins](https://opencode.ai/v2/docs/plugins).
