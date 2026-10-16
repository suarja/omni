---
name: omni-marketplace-routing
description: Decide which plugin of the user's Omni marketplace should own a new or moved skill, using the marketplace listing and identity findings. Use when creating a skill, when a skill seems misplaced, or when two skills overlap.
---

# Where a skill belongs

A marketplace is a catalogue of plugins; a plugin is the installable namespace that owns
related skills. Routing a skill to the right plugin keeps the catalogue readable and keeps
one canonical owner per intent.

## Steps

1. `omni_list_marketplace` — read the plugins, their descriptions and the skills they hold.
2. `omni_find_skill { query }` with two or three words from the new skill's intent — the
   `identityFindings` show exact duplicates and variants across the marketplace and the
   registered projects.
3. Route:
   - an existing plugin already covers the source family or the domain → add the skill there;
   - a variant of an existing skill exists → propose an update of that skill instead of a new one;
   - no plugin has a clear ownership boundary → propose a new plugin name to the user and
     wait for their answer before creating anything.
4. Say the decision in one sentence ("`convex-migration-helper` belongs to `pstack` next to
   the other Convex skills") before previewing the write.

## Rules

- Never create a second skill with the same name, and never copy a skill into another plugin
  to make it easier to find.
- Ownership beats functional grouping: source identity first.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni Desktop for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni Desktop, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
