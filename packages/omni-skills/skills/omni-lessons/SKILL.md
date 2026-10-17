---
name: omni-lessons
description: Turn what a session learned — a trap, a rule, a working recipe — into a durable update of the right marketplace skill through Omni, instead of a note in one project. Use when the user says "remember this", "add this to the skill", "we should note that", or at the end of a task that changed how something should be done.
---

# From a lesson to a skill

A lesson kept in one project's notes is lost for the next project. Omni keeps the marketplace
as the single source of truth: update the skill there, and every project that carries it can
take the update.

## Steps

1. State the lesson in one or two sentences: the situation, what failed or worked, the rule
   that follows. Ask the user to confirm the wording when it changes a rule.
2. `omni_find_skill { query }` — find the skill that should hold it. If none fits, use
   `omni-marketplace-routing` to decide where a new skill belongs.
3. Read the current skill body (the `find` result gives its path; the user's project copy is
   fine to read) and place the lesson in its natural section — a rule under "Rules", a trap
   under "Pitfalls", a step in the sequence. Keep the skill's voice and length.
4. `omni_preview_update_skill { sourceId, packageId, folderName, files, reason }` with the
   full updated `SKILL.md`; the `reason` is the lesson in one line (it becomes the commit
   message context).
5. Present the diff summary from the plan, then apply the consent rule below. Existing clear approval for that exact plan counts; do not ask again.
6. After the receipt, `omni_drift_report` for the projects that carry the skill: they now
   show `update`; offer to apply it where the user works.

## Rules

- One lesson per update; small diffs are reviewable diffs.
- Never rewrite the whole skill to add a line.

Use the `packageId` returned by `omni_list_marketplace` or `omni_find_skill`,
for example `packages/<name>`. The short package name also works. Previews and
receipts keep the canonical observed id.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
