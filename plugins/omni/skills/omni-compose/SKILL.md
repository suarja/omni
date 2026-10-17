---
name: omni-compose
description: Compose up to three project skills through Omni previews
---

# Compose a skill set with Omni

Use this skill when the user asks Omni to compose skills for a project.

1. Read the project's stack profile with `omni_stack_profile`.
2. Read the project's current assets with `omni_list_project_assets` and inspect the marketplace with `omni_list_marketplace`.
3. Read project conventions from `CLAUDE.md` or `AGENTS.md` with the bounded read tool when available.
4. Compose at most three focused skills, each no longer than 120 lines. Use only tool names and conventions you actually read.
5. Before each proposed skill, explain the one-sentence plan. Existing clear approval for that exact plan counts; ask once only when approval is missing.
6. After clear approval for the exact plan, call `omni_apply` without asking again. Do not force `askInOmni` after conversational approval. Every write uses Omni preview, apply, and receipt.

The previews are the source of truth. Do not present model prose as a completed change; point the user to Omni → Review.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` once the user gives a clear yes.
