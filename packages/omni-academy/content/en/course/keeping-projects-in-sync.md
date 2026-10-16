---
title: Keeping projects in sync
kind: course
summary: Assign shared context to projects, spot drift, capture improvements, and let Git keep the history.
products: [claude-code, codex]
illustration: project
topic: projects
cta: { route: projects, label: Open Workspace }
---

## Start with an observed project

A project is a registered local root, not just a name in a list. Its observation gives Omni the evidence needed for a safe assignment.

Open the project node in `Workspace`, then choose `Manage skills` before choosing a write action.

- Read the project path and harness evidence.
- Use `Skills` for observed skills and their origins.
- Use `Info` for project evidence and `Review` in the rail for checks.

## Assign from the marketplace

Choose `＋ Add skills` in the project sheet. The picker keeps the destination project visible while you select skills from your marketplace.

This picker selects individual skills. It does not install a whole plugin with commands or hooks.

- Select the plugin’s available skills when they belong together.
- Choose a single skill when the scope must stay narrow.
- Keep the `Claude Code` and `Codex` harness rows explicit.

## Notice drift early

The project and its marketplace source can evolve independently. Choose `Refresh` when local files or manifests changed.

The skill list distinguishes origins and update states from the operation that could resolve them.

- Read the finding kind and severity.
- Open the affected root rather than guessing from a count.
- Keep later local edits outside a restore boundary.

## Capture and let Git tell the story

On `Skills`, open an active project-only skill and choose `Add to my marketplace`. Select its destination under `Place in` and read `What changes`.

The receipt answers what Omni wrote. Git answers how the change entered history; neither replaces the other.

- Inspect the capture summary before its final `Add`.
- The picker’s `Add (count)` applies selected skills directly; there is no later Review approval.
- Use `Undo` in `Activity` when the receipt and drift check support it.

## Before you act

Start with the observed page, not an assumption about the filesystem. The current route and its head tell you which target Omni has in scope.

- Read the page title and the active tab.
- Prefer the named action over a shortcut.
- Keep the local path available for comparison.

## Check the boundary

Every preview is read-only until its approval control is chosen. A blocked or unavailable state is evidence that needs a different decision.

- Treat a missing root as unavailable, not empty.
- Treat a conflict as a stop condition.
- Keep the harness name beside the path.

## Keep the trail

After a write, Activity holds the operation history. The receipt and Git commit complement each other and make a later restore deliberate.

- Read the files in the receipt.
- Compare later edits before restoring.
- Return to the source of truth for the next change.

## A weekly check

Re-open the source and project when your harness conventions change. This small review keeps the next operation tied to current local evidence.

- Refresh the observed root.
- Read the changed paths.
- Choose one deliberate next action.
