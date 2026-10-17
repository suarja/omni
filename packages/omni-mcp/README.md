# `@omni/mcp`

`@omni/mcp` is the stdio MCP server that gives Claude Code and Codex a thin client for the
running Omni app. It reads and writes only through Omni's authenticated local socket.

## Install

Build the workspace package:

```sh
pnpm --filter @omni/mcp build
```

Print the provider configuration and add it to the indicated user or project file:

```sh
omni-mcp --print-config claude
omni-mcp --print-config codex
```

The printed configuration includes `OMNI_USER_DATA` so the client uses Omni's user data directory. Hand-written configurations use the platform default; configurations installed by Omni provide the exact path explicitly.

## Bootstrap provenance

`OMNI_MCP_SOURCE` accepts `codex-plugin`, `claude-plugin`, and `direct`.
Absent or unsupported values become `unknown`.
`OMNI_MCP_HARNESS` accepts `codex` and `claude-code`.
Both plugin sources supply skills only for the active harness. Direct registration
still checks installed skills. Settings registration writes `OMNI_USER_DATA` without
plugin provenance; it remains independent of the plugin installation.

## Tools

- `omni_bootstrap_status` — diagnose the plugin, MCP transport, CLI runtime, Desktop installation and
  reachability, harness registration, skills, and the one next action; read-only and usable before Desktop is running.
- `omni_status` — read app, marketplace, and project status.
- `omni_list_marketplace` — list packages, assets, and compatibilities.
- `omni_find_skill` — find matching skills and identity findings.
- `omni_list_project_assets` — inspect managed and unmanaged project assets.
- `omni_drift_report` — report marketplace drift by project.
- `omni_receipt` — read an operation receipt.
- `omni_stack_profile` — read a project's deterministic stack profile (tags, evidence, languages).
- `omni_catalog_search` — search the merged skill catalogue by text and/or tags.
- `omni_suggest` — read the ranked skill suggestions for a project, with why and alreadyInProject.
- `omni_session` — read one Activity session (title, task, transcript-tail evidence) by id.
- `omni_preview_link_storefront` — preview linking a local storefront by absolute path or a path relative to the calling agent's working directory, with optional `reason`. Shows the folder, GitHub repository when recognized, ORIGIN.md workshop sources and base commits, and unlinked plugins with reasons. Already linked returns `ready` with `storefrontId` and no write. Apply via `omni_apply` under `agents.approval.personalMarketplace`, using the existing `marketplace-setting` reason. Undo archives the link; storefront files stay unchanged. Workshop, project and external source folders are refused.
- `omni_preview_publish` — preview a complete workshop plugin for one existing or new storefront, with per-file conflict choices. Publication always requires owner approval in Omni; follow `omni-share`.
- `omni_preview_capture` — preview capturing a project-local artifact.
- `omni_preview_make_compatible` — preview a harness compatibility change.
- `omni_preview_assign` — preview assigning an asset to projects.
- `omni_preview_create_skill` — preview creating a marketplace skill.
- `omni_preview_update_skill` — preview updating a marketplace skill.
- `omni_apply` — apply after a clear conversation yes or Omni approval; returns `applied`, `failed`, `declined`, `expired`, or `stale`.

## Approval model

`omni_bootstrap_status` is the exception: it performs local read-only checks and probes the
authenticated Desktop gateway when available. Other reads are served from the running app.
Every preview returns `approval: "conversation"` or
`"omni"`. For conversation approval, present the one-sentence plan, ask the user, wait for a
clear yes, then call `omni_apply`; no or unclear means no write. For Omni approval, tell the user
once that the change waits in Omni → Review, then call `omni_apply`. The MCP server never
writes marketplace or project files itself. `askInOmni: true` escalates a preview and never
de-escalates it. If the app is unavailable, tools return an `app-not-running` result with
instructions to open Omni.
