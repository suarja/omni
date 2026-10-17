---
name: omni-bootstrap
description: Route reusable skill creation, updates, installation, assignment, synchronization, and drift checks through Omni. Use when the user asks to create, write, improve, remember, install, assign, sync, or audit a reusable skill. Do not use for executing an already-installed skill or for an explicitly project-local one-off skill.
---

# Route reusable skills through Omni

Omni is the source of truth for reusable skills. This entrypoint keeps a
skill request on the Omni path instead of silently creating a project-local file.

1. Call `omni_bootstrap_status` first when available. It distinguishes the
   plugin, MCP runtime, Desktop installation, Desktop reachability, harness
   registration, and skills. The runtime first tries to open an installed Desktop
   in the background for the default profile and waits up to 20 seconds. Follow
   the returned `nextAction` after that attempt:
   `install-desktop`, `open-desktop`, `register-mcp`, or `install-skills`.
2. If `omni_bootstrap_status` is unavailable, the plugin/MCP is not loaded. For
   Codex, recommend installing the Omni Codex plugin. For Claude Code, recommend
   Omni → Settings → Agents → Enable Omni for Claude Code. If the harness
   is unknown, say that the local state cannot be inspected and present both paths;
   do not claim that Desktop is absent.
3. If the diagnostic says Desktop is not detected, recommend installing Desktop
   or opening an existing installation in a non-standard location. If
   it still says installed but not running, ask the user to open it. This session
   reconnects by itself; a new agent session is not needed. Never create a
   replacement `SKILL.md` by hand as a bootstrap fallback.
4. Once the path is ready, call `omni_status` before planning a reusable-skill
   operation.
5. For creating or updating a skill, follow `omni-skill-authoring`.
6. For choosing its owning plugin, follow `omni-marketplace-routing`.
7. For assigning, installing, synchronizing, or checking drift, follow
   `omni-project-sync`.
8. For a lesson to retain, follow `omni-lessons`.
   For auditing identity, overlap, or skill responsibilities, follow `omni-audit`.
9. For every write, use Omni preview, `omni_apply`, and its receipt. Clear approval already given for that exact plan counts; do not ask again.

An already-installed skill can be used directly for its task. Omni is needed
when the reusable skill or its assignment is being managed.

## Register a project

If `omni_status` does not list the intended project, call
`omni_preview_register_project { path?, reason? }`. Omit `path` for this session's
working folder; pass the project path when it is another folder. Absolute paths
work without a known working directory; relative paths resolve against the calling
agent's working directory. The target resolves to its Git root when present, else
the folder itself. Registering another project requires conversation consent under
the same approval rule. Do not ask the user to open Desktop just to register it.
Registration lets Omni read the folder; it writes no project files. Undo archives
it. Use the consent rule below: existing clear authorization counts for conversation
approval; when projects are configured for `omni`, approval happens in Desktop.
An active registration returns `ready` and `projectId` without a write. Otherwise
apply the preview with `omni_apply`; use the returned `projectId` directly in
`omni_preview_assign`. An archived registration is restored with the same id.
If blocked, report the refusal and recovery text; do not bypass the path guard.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` once the user gives a clear yes.
