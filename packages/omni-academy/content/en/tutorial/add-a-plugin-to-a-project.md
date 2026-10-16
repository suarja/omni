---
title: Add a plugin to a project
kind: tutorial
summary: Select a plugin’s skills in a project and choose which agents receive them.
minutes: 4
products: [claude-code, codex]
illustration: plugin
topic: projects
cta: { route: projects, label: Open Workspace }
steps: [1. Open the project, 2. Choose the skills, 3. Check agents and add]
---

## 1. Open the project

From `Workspace`, open the destination project node, then choose `Manage skills`. Read the project name and folder in the sheet.

The tabs are `Skills`, `Instructions`, and `Info`. This flow adds skills from your personal marketplace; it does not install a whole plugin with commands or hooks.

What you will see: the project sheet on `Skills`, with `＋ Add skills` in its footer.

[screenshot:add-plugin-project]

## 2. Choose the skills

Choose `＋ Add skills`. The `Add skills` sheet lists marketplace skills that are not yet in this project. Each row names its source package.

Select the skills belonging to the plugin you want. There is no whole-plugin picker in this flow. Already assigned skills are omitted.

What you will see: the available skills, their package identifiers, and the `Agents` choices.

[screenshot:add-plugin-picker]

## 3. Check agents and add

Check the project name, selected skills, and the `Claude Code` and `Codex` checkboxes under `Agents`. Both agents start selected.

`Add (2)`, for example, applies the two selected skills directly after preparing their operations. There is no saved assignment to approve later in Review. Choose it only when the selection is correct.

Afterward, inspect the result and open `Activity` for receipts. A failure can leave a partial result; read it before retrying.

What you will see: two selected skills, the agent choices, and `Add (2)` before it is clicked.

[screenshot:add-plugin-assignment]

Next, read [marketplaces](academy://topic/marketplaces), then [Capture a skill from a project](academy://tutorial/capture-a-skill-from-a-project).
