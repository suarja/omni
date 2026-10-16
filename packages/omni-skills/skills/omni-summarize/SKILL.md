---
name: omni-summarize
description: Summarize what an agent session did, or what a receipt changed, in one factual paragraph. Use when the user asks what an agent session did, or what a receipt changed.
---

# Summarizing a session or a receipt

A short, factual paragraph beats a wall of JSON. This skill reads exactly one session or one
receipt and reports only what that evidence actually contains — no invention, no filling gaps
with a plausible guess.

## Steps

1. Decide which the user means: an agent session (title, task, "what did it do") or a receipt
   (an already-applied write, "what changed").
2. For a session: `omni_session { sessionId }` — the session id comes from the conversation or
   from Activity. Read `title` or `name`, `task`, and `activity` (`firstPrompt`,
   `latestPrompt`, `lastTool`, `turns`, `lastAnswerAt`).
3. For a receipt: `omni_receipt { operationId }` or `omni_receipt { requestId }` — read
   `displayTarget`, `actions`, and `git`.
4. Write one paragraph: what it is (session or receipt), what it did or changed, using only the
   fields that were present. When a field this summary would normally mention is missing, say
   "unknown" for it rather than guessing or omitting it silently.
5. If the session or receipt is not found, say so plainly; do not summarize something else in
   its place.

## Rules

- One paragraph, facts only; no adjectives the evidence does not support.
- Never call a write tool from this skill — summarizing is read-only.

## Consent

<!-- Generated from packages/omni-skills/consent.md. -->

For ordinary skill changes, previously given clear approval for this exact plan counts; do not ask again. If approval is not already clear, present the plan and wait for a clear yes; no or unclear means do nothing. For `approval: "omni"`: Approval happens in Omni Desktop for the reason returned with the preview. Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result. Route every write through Omni preview, `omni_apply`, and its receipt.

Use the workshop reported by `omni_status` for all skill authoring and fixes. A source with `role: "storefront"` is a published copy. Never write skills or fixes into it. For a publication, call `omni_preview_publish` with the complete plugin id and one storefront destination, then `omni_apply`. Publication always requires the owner's approval in Omni Desktop, whatever the agent settings or prior conversation approval. Present blocking findings with file and line, fix the workshop content, and preview again.

Install external skills through Omni using `omni_list_external_library`, `omni_preview_install_external`, `omni_apply` and its receipt; never run `npx skills add` directly.

## Managed files

Never edit a skill folder, a plugin or marketplace manifest, or the personal marketplace
directly — Omni's guard refuses it. Use `omni_preview_update_skill`, `omni_preview_capture`, or
`omni_preview_assign` to plan the change, then `omni_apply` using the user's existing clear authorization for that exact change.
