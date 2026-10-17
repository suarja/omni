# Omni plugin

This plugin is the Codex and Claude Code discovery entry for Omni. It packages the Omni skills and
a portable MCP runtime, then routes reusable skill work to Omni.
Installing the plugin does not install or launch Omni.

The MCP launcher first uses an explicit `OMNI_MCP_CLI`, then the runtime bundled
with this plugin, then the runtime materialized by Omni. The plugin can
therefore diagnose an incomplete installation without access to this repository.
Omni remains the authority for the user data path, token, previews,
approvals, receipts, and writes.

## Install in Codex

Run these commands in a terminal:

```sh
codex plugin marketplace add suarja/omni
codex plugin add omni@omni
```

## Install in Claude Code

Run these commands in a terminal:

```sh
claude plugin marketplace add suarja/omni
claude plugin install omni@omni
```

Claude Code discovers `.mcp.json` at the plugin root. Its launcher uses
`${CLAUDE_PLUGIN_ROOT}/scripts/omni-mcp.mjs` with `OMNI_MCP_HARNESS=claude-code`
and `OMNI_MCP_SOURCE=claude-plugin`.
Codex explicitly loads `.mcp.codex.json` from its manifest, with `OMNI_MCP_HARNESS=codex`
and `OMNI_MCP_SOURCE=codex-plugin`. Its `cwd: "."` resolves to the installed plugin root,
so `scripts/omni-mcp.mjs` works from any session directory.
Both local installations and MCP connections were verified in isolated profiles.
See the [Claude Code path reference](https://code.claude.com/docs/en/plugins-reference#environment-variables).

Both marketplaces are named `omni` and expose the plugin from `plugins/omni`.
They share the same skills and portable runtime. Install and open Omni separately,
then start a new harness session and ask it to diagnose Omni.

## Local test

1. Run `pnpm build` to refresh the portable plugin runtime.
2. Add this repository as a local marketplace and install `omni@omni` in the selected harness.
3. Start a new harness session and ask it to diagnose Omni.
4. Follow `omni_bootstrap_status`: install/open Desktop when requested.
5. Ask: `Create a reusable skill that explains our Convex migration workflow.`

The expected first Omni call is `omni_bootstrap_status`, followed by
`omni_status`, discovery, and a preview. Clear approval already given for that
exact plan counts; do not ask again. All writes use Omni preview, `omni_apply`,
and its receipt. Never write a replacement `SKILL.md` directly.
