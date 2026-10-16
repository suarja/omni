---
title: Install a marketplace by hand
kind: tutorial
summary: Locate your local marketplace and check a native installation back in Omni.
minutes: 4
products: [claude-code, codex]
illustration: terminal
topic: claude-code
cta: { route: library, label: Open Workspace }
steps: [1. Locate the marketplace, 2. Use the agent’s native instructions, 3. Observe the project afterward]
---

## 1. Locate the marketplace

From `Workspace`, open `My marketplace ·` followed by your marketplace name. Its canvas groups observed skills by plugin.

For the registered local path, open `Settings` and read the `Marketplace` section. Connecting this source to Omni does not install a native agent plugin.

What you will see: the personal marketplace canvas with its plugin groups.

[screenshot:install-marketplace-library]

## 2. Use the agent’s native instructions

Choose `Plugins and storefronts` to inspect the plugin list. A plugin’s `More actions for` menu concerns publishing and skill creation; there is no manual-install guide or compatibility conversion action here.

A whole-marketplace native installation happens outside Omni, using the selected agent’s own installation instructions and the repository’s native manifests. This sheet supplies neither installation commands nor a compatibility verdict. Do not copy a manifest to a guessed path.

For a path entirely inside Omni, use [Add a plugin to a project](academy://tutorial/add-a-plugin-to-a-project) to select its skills instead.

What you will see: a plugin’s actions menu in the marketplace sheet.

[screenshot:install-marketplace-menu]

## 3. Observe the project afterward

After a manual installation, return to `Workspace`, open the affected registered project, and choose `Refresh`, then `Manage skills`.

Read its `Skills` and `Instructions` tabs. Agent chips show observed copies, not proof that a native plugin loader enabled the plugin. Verify native plugin loading in the agent itself.

What you will see: the project’s observed skills and their `Claude Code` and `Codex` chips.

[screenshot:install-marketplace-harnesses]

Next, read [marketplaces](academy://topic/marketplaces), then [Add a plugin to a project](academy://tutorial/add-a-plugin-to-a-project).
