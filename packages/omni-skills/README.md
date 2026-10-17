# Omni skills

Open-source skills (MIT) that teach an agent — Claude Code, Codex, and any harness that
reads `SKILL.md` folders — how to work **through Omni**: create and update skills in
the user's marketplace, route them to the right plugin, keep projects in sync, turn lessons
into durable skill updates, suggest skills for a project's stack, and explain or summarize
what Omni already knows. Every write goes through the Omni MCP server and follows the
conversation consent policy.

| Skill                      | Use when                                            |
| -------------------------- | --------------------------------------------------- |
| `omni-share`               | sharing a plugin through a public storefront        |
| `omni-audit`               | audit identity, overlap, and skill responsibilities |
| `omni-bootstrap`           | routing reusable skill work through Omni            |
| `omni-skill-authoring`     | creating, writing or updating a skill               |
| `omni-marketplace-routing` | deciding which plugin owns a skill                  |
| `omni-project-sync`        | installing skills in a project, checking drift      |
| `omni-lessons`             | "remember this", "add this to the skill"            |
| `omni-suggest`             | what skills would help this project                 |
| `omni-compose`             | compose up to three skills for this project         |
| `omni-explain`             | why Omni flags something, what a drift means        |
| `omni-summarize`           | what an agent session did, a receipt changed        |

## Bootstrap path

The Codex plugin is the discovery entry. It does not install Omni. The plugin
starts a portable MCP runtime; `omni_bootstrap_status` then reports whether Desktop is
installed and reachable, whether the current harness is registered, and the one next
action to take. Omni is the authority for marketplace state, previews, approvals,
receipts, and writes. If the plugin/MCP is absent, a skill can recommend installation but
cannot inspect the local machine.

## Requirements

Omni running, with its MCP server enabled for your harness (Settings · Agents), or
the printed configuration from `omni-mcp --print-config claude|codex`.

## Consent

The consent paragraph is maintained in [consent.md](consent.md). `pnpm build:plugin-runtime`
copies it into every canonical skill and synchronizes the plugin skills. Edit that source
instead of the generated paragraphs. Saved settings remain explicit; `askInOmni: true` opts
a preview into Omni approval. Omni requests stay pending until approved or declined;
`omni_apply` waits in bounded rounds and `omni_receipt` reports a later result.

## Install

Copy the `skills/` folders into your harness's skills directory, or install them from this
repository with the skills installer of your harness. The skills only call the `omni_*` tools;
they never write files themselves.
