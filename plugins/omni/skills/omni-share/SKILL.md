---
name: omni-share
description: Share a workshop plugin through a public storefront using Omni. Use when the user says "share this plugin", "share this skill", "publish", "make a marketplace for a person, team or vertical", "lead magnet", or "storefront".
---

# Share a plugin through Omni

1. Read `omni_status` for the active workshop, storefronts and publication drift.
   If Omni is unavailable, follow `omni-bootstrap`. For an unlinked local storefront,
   offer `omni_preview_link_storefront { path, reason? }`. Absolute paths work without
   a known working directory; relative paths use the calling agent's working directory.
   Review its recognized origins and unlinked plugins. Apply the link with `omni_apply`
   under the existing personal marketplace approval setting. Already linked returns
   `storefrontId` without a write; Undo archives the link, leaving its folder intact.
2. Choose the destination with the user by audience and theme. Reuse a storefront
   when it fits; otherwise use `newStorefront` with a name and an explicit license.
   Keep one storefront per audience or vertical. Everything in a public repository is
   visible to everyone who can read it. Never make the private workshop public.
3. Make the complete plugin generic **in the workshop** before publishing. Use
   `omni_list_marketplace`, `omni_find_skill`, `omni_preview_update_skill` and
   `omni_apply` under `omni-skill-authoring`. Remove personal brand colors, product
   names, local paths and private data. Use English and working examples.
   A request to share one skill still publishes its complete plugin; inspect every file
   and agree on the plugin scope. Never patch a storefront copy or run plugin hooks.
4. Call `omni_preview_publish { pluginId, storefrontId }` or
   `omni_preview_publish { pluginId, newStorefront: { name, license } }`.
   Use the complete plugin id from the workshop and exactly one destination. For an
   update, review every conflicting file and pass `conflictChoices` mapping each path
   to `keep-storefront` or `take-workshop`. Present blocking findings with file and line.
   Fix them in the workshop through Omni, then preview again.
5. Present the destination, plugin and changes. Publishing always requires the
   owner's approval in Omni, whatever the agent settings or prior conversation consent.
   Call `omni_apply` with the requestId and follow the returned approval reason.
   Pending means wait on the same requestId; declined means stop. Read the receipt.
   Only a `pushed` publication proves the remote copy is available. Report
   `committed-not-pushed`, `push-outcome-unknown` or failure honestly; do not claim sharing succeeded.
6. After a confirmed publication, give install commands using its storefront repository,
   published plugin name and marketplace name from the destination manifest, never the
   workshop repository. Substitute the actual values in these command templates:

   ```sh
   claude plugin marketplace add OWNER/STOREFRONT
   claude plugin install PLUGIN@MARKETPLACE
   codex plugin marketplace add OWNER/STOREFRONT
   codex plugin add PLUGIN@MARKETPLACE
   ```

   Read the destination manifest without modifying it when its marketplace name is
   unknown. Give commands to the user; do not install or send them to a colleague.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

For sharing or publishing, follow `omni-share`; author and fix skills only in the active workshop, never in a storefront.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.
