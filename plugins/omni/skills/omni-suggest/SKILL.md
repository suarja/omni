---
name: omni-suggest
description: Suggest marketplace skills that fit this project's detected stack, add the chosen ones through Omni with consent, then offer to assign them to the project. Use when the user asks what skills would help this project, what to install, or how to improve the agent setup.
---

# Suggesting skills for this project's stack

Omni already ranks the catalogue deterministically for this project — tag match, installs,
audit and already-in-marketplace bonuses, no model involved. This skill reads that ranking,
does the one judgment step (which of the top matches are actually worth adding), and routes
every write through the existing preview → consent → apply path.

## Steps

1. `omni_stack_profile { projectId }` — the detected tags with their evidence. If the project
   carries none, say so; there is nothing to suggest yet.
2. `omni_suggest { projectId }` — the ranked candidates, each with `why` (the matched tags) and
   `alreadyInProject`. Present the top 5 that are not already in the project, one line each:
   name and its `why`.
3. Ask which of these the user wants added. No or unclear means stop here.
4. For each chosen skill: `omni_catalog_search { query: name }` to find its entry (owner/repo,
   `url`). Fetch the `SKILL.md` at that `url` yourself — Omni's tools never fetch on the agent's
   behalf. Use `omni-marketplace-routing` to pick the plugin it belongs in.
5. `omni_preview_create_skill { sourceId, packageId, folderName, files }` with the fetched
   content, present the plan, then use the consent rule below and call `omni_apply`.
6. After the receipt, propose `omni_preview_assign { artifactPath, sourceId, packageId,
projectIds: [projectId] }` for this project — a second, separately previewed gesture; use the
   consent rule again before calling `omni_apply`.

## Rules

- Never invent a suggestion outside `omni_suggest`'s list; the ranking is the evidence.
- Skip anything `alreadyInProject` reports as already there.

Use the `packageId` returned by `omni_list_marketplace` or `omni_find_skill`,
for example `packages/<name>`. The short package name also works. Previews and
receipts keep the canonical observed id.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

For sharing or publishing, follow `omni-share`; author and fix skills only in the active workshop, never in a storefront.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
