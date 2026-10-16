# Omni Codex plugin

This plugin is Codex's discovery entry for Omni. It packages the Omni skills and
a portable MCP runtime, then routes reusable skill work to Omni Desktop.
Installing the plugin does not install or launch Omni Desktop.

The MCP launcher first uses an explicit `OMNI_MCP_CLI`, then the runtime bundled
with this plugin, then the runtime materialized by Omni Desktop. The plugin can
therefore diagnose an incomplete installation without access to this repository.
Omni Desktop remains the authority for the user data path, token, previews,
approvals, receipts, and writes.

## Local test

1. Run `pnpm build` to refresh the portable plugin runtime.
2. Install the `omni` plugin from `.agents/plugins/marketplace.json`.
3. Start a new Codex session and ask it to diagnose Omni.
4. Follow `omni_bootstrap_status`: install/open Desktop when requested.
5. Ask: `Create a reusable skill that explains our Convex migration workflow.`

The expected first Omni call is `omni_bootstrap_status`, followed by
`omni_status`, discovery, and a preview. Clear approval already given for that
exact plan counts; do not ask again. All writes use Omni preview, `omni_apply`,
and its receipt. Never write a replacement `SKILL.md` directly.
