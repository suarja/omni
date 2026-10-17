---
name: omni-skill-authoring
description: Create or update a skill in the user's Omni marketplace through the Omni MCP tools instead of writing SKILL.md files by hand. Use when the user asks to create, write, add, improve or update a skill, or to turn a lesson into a skill.
---

# Skill authoring through Omni

Omni is the single source of truth for the user's skills. A skill written by hand
into one project drifts; a skill written through Omni lands in the marketplace with valid
structure and provenance, is projected to every harness, committed, and applied to the
projects that carry it. Never write `SKILL.md` files directly when the Omni tools are
available.

## Steps

1. `omni_bootstrap_status` — diagnose the plugin, runtime, Desktop installation, and
   harness before assuming any part of the path is available. Follow `nextAction` when
   it is not ready; never infer an absent Desktop from an unavailable tool.
2. `omni_status` — confirm the app is running and note the personal marketplace id. If the
   answer is `app-not-running`, tell the user to open Omni and stop.
3. `omni_find_skill { query }` — check whether a skill with the same intent already exists
   (name, description, identity findings). If one exists, prefer `omni_preview_update_skill`.
4. Choose the owning plugin with `omni_list_marketplace` (see `omni-marketplace-routing`).
5. Write the skill: a `name` in kebab-case equal to the folder, a `description` of at most
   1024 characters that says what it does **and when to use it** ("Use when …"), a body
   under 500 lines with concrete steps. No placeholder text left in the body.
6. `omni_preview_create_skill { sourceId, packageId, name, description, body, reason }`
   (or `omni_preview_update_skill`). Read the returned `plan`: findings with severity
   `error` block the write — fix the content and preview again; warnings are advice.
7. Present the plan to the user in one short paragraph: the files, the plugin, the commit.
8. Use Omni preview, `omni_apply`, and its receipt for every write. Clear approval already given for that exact plan counts; do not ask again. If approval is not clear, ask once and wait; no or unclear means do nothing.
   Report the receipt (files written, commit) or the decline. Never retry a declined request.

## Rules

- Author and fix skills only in the active workshop. Follow `omni-share` for sharing or publishing.

- One skill, one intent, one folder. Do not duplicate an existing skill under a new name.
- Keep the user's voice: the body is guidance for an agent, not a blog post.
- Provenance is recorded by Omni (harness, session, reason); write a useful `reason`.

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
