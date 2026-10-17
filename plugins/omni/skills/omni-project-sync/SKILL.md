---
name: omni-project-sync
description: Assign marketplace skills to projects, detect drift between a project's copies and the marketplace, and resolve it through Omni's previewed operations. Use when the user asks to install, add, sync, update or check skills in a project, or when a project's skills look out of date.
---

# Keeping projects in sync with the marketplace

Projects carry copies of marketplace skills, one folder per harness. Omni knows which copies
it wrote (bindings) and can tell when a copy drifted.

## Steps

1. `omni_status` — list the registered projects and pick the one the user means (ask when
   several match).
2. `omni_list_project_assets { projectId }` — managed skills with their binding state,
   unmanaged skills present only in the project, per harness.
3. `omni_drift_report { projectId }` — for each managed skill: `current`, `update`
   (marketplace moved on), `conflict` (the project copy was edited locally).
4. To add a skill: `omni_preview_assign { artifactPath, sourceId, packageId, projectIds }`,
   present the plan (which harness folders receive it, the commit), then use the consent rule
   below and call `omni_apply`.
5. To adopt a local edit into the marketplace: `omni_preview_capture { projectId,
relativePath, target }` — the project's version becomes the marketplace version — then use
   the consent rule below and call `omni_apply`. To take the marketplace version instead, tell the user to open the project in
   Omni and choose "Take the marketplace version" on the conflict.
   To update linked copies from the current marketplace, use `omni_preview_sync_skill { sourceId, packageId, artifactPath, projectIds? }`, then `omni_apply` under the same consent rule.
   `omni_preview_update_skill` includes eligible linked copies by default; set `sourceOnly: true` for an explicit marketplace-only update. Both keep local edits.
6. Unmanaged skills that exist in several projects are candidates for capture: say so, once.

## Rules

- Never edit files in `.claude/skills` or `.agents/skills` by hand: every write goes through a
  preview the user approves in Omni.
- Report drift as facts (hashes differ), not as blame.

Use the `packageId` returned by `omni_list_marketplace` or `omni_find_skill`,
for example `packages/<name>`. The short package name also works. Previews and
receipts keep the canonical observed id.

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
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
