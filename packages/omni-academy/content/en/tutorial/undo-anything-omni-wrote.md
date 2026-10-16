---
title: Undo anything Omni wrote
kind: tutorial
summary: Read an operation in Activity and check its restore preview before approval.
minutes: 4
products: [claude-code, codex]
illustration: lesson
topic: agents-at-work
cta: { route: library, label: Open Workspace }
steps: [1. Open Activity, 2. Read the operation result, 3. Check the reverse operation]
---

## 1. Open Activity

Choose `Activity` in the canvas rail. This is the operation history: it lists what Omni wrote, who requested it, and when.

Find the operation for the intended target. `Undo` appears only for eligible receipts. Some operations cannot be reversed here; the title of this tutorial does not promise otherwise.

What you will see: the Activity history with completed operations and eligible `Undo` buttons.

[screenshot:undo-review]

## 2. Read the operation result

Open the operation row to inspect its result. Check its target, changed files, and Git outcome when recorded. Skill operations can open a different result sheet from marketplace captures.

For a captured project skill, the receipt offers `Restore`. Read the receipt before choosing that action.

What you will see: a skill-capture receipt with the original result and `Restore`.

[screenshot:undo-receipt]

## 3. Check the reverse operation

Choose `Restore` from that receipt. It opens a reverse-operation preview; the final `Restore` applies it. Read the preview and any blocked state before confirming.

Omni checks current content against the original receipt and protects later edits. If the reverse operation is blocked, keep those edits and resolve the cause before retrying.

You can also open an eligible operation’s reverse flow directly with `Undo` in Activity. Read its result after approval, including any partial failure.

What you will see: the restore workbench before the final `Restore`, with the proposed reverse effects.

[screenshot:undo-restore]

Next, read [marketplaces](academy://topic/marketplaces), then [Capture a skill from a project](academy://tutorial/capture-a-skill-from-a-project).
