---
name: omni-explain
description: Explain a finding, a drift state, or the difference between two versions of a skill, in plain words, then point at the resolution Omni already offers. Use when the user asks why Omni flags something, what differs between two versions, or what a drift means.
---

# Explaining a finding without touching a file by hand

Every finding, drift state, or version difference Omni surfaces already has a resolution built
into an existing operation. This skill's job is to read both sides, say plainly what differs,
and point at that resolution — never to edit a skill folder directly.

## Steps

1. Identify what needs explaining: a project finding, a drift state, or two skills that look
   alike. Ask the user which project or skill when it is not already clear from the
   conversation.
2. Read the relevant side(s):
   - A drift or an "update"/"conflict" state: `omni_drift_report { projectId }`.
   - What a project has, managed or not: `omni_list_project_assets { projectId }`.
   - A possible duplicate or variant: `omni_find_skill { query }` — read its
     `identityFindings`.
3. State the difference in plain words: what changed, on which side, since when if known. Never
   guess at content you have not read.
4. Propose the existing resolution for that state — never a hand edit:
   - `update`: offer to apply the marketplace version (`omni-project-sync`'s assign step).
   - `conflict`: offer to capture the project's edit into the marketplace, or to take the
     marketplace version instead, exactly as `omni-project-sync` describes.
   - A duplicate/variant finding: offer to merge them via `omni-marketplace-routing` /
     `omni-lessons`, whichever fits.
5. Only act after the user agrees to the specific resolution; then follow that skill's own
   steps and the consent rule below.

## Rules

- Explain drift and duplicates as facts (hashes differ, one is newer), not as blame.
- Never write a file yourself to "fix" what you explained; hand off to the operation that owns it.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni Desktop for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni Desktop, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
