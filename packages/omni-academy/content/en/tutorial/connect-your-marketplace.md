---
title: Connect your marketplace
kind: tutorial
summary: Register an existing local marketplace from the Workspace Add panel.
minutes: 4
products: [claude-code, codex]
illustration: marketplace
topic: marketplaces
cta: { route: library-add, label: Open Add Marketplace }
steps: [1. Open Add Marketplace, 2. Choose the source type, 3. Read the registered marketplace]
---

## 1. Open Add Marketplace

On first launch, `Welcome to Omni` shows a map with three places: your marketplace, your projects, and your agents. Under `Your marketplace`, choose `Connect existing` to open the personal marketplace flow directly. `Create my marketplace` opens the creation form with a file and Git preview.

You can fill the places in any order. Completed places become real nodes. After the first step, the compact setup line includes `Hide`; use `Help`, then `Show setup` to bring the remaining places back.

You can also choose `＋ Add`, then `Marketplace`. With no personal marketplace connected, the sheet opens on `My first marketplace`. Once one exists, it opens on `External source` for repositories published by others.

Connecting a local folder registers it in Omni. It does not install its skills into a project.

What you will see: the Add menu with `Project`, `Marketplace`, and `New skill`.

[screenshot:connect-marketplace-library]

## 2. Choose the source type

For someone else's local repository, choose `External source`, then `Choose a folder…`. For your first personal marketplace, keep `My first marketplace`, then choose `Choose a folder…` under `Git repository`.

Select the existing repository in the system picker. Confirming that picker starts registration immediately; there is no separate `Connect marketplace` page.

If a personal marketplace already exists, the personal tab is `Public storefront`. It opens a storefront flow, not a replacement for your current marketplace.

What you will see: the `Marketplace` sheet with source choices, `GitHub repository`, and `Choose a folder…`.

[screenshot:connect-marketplace-choose]

## 3. Read the registered marketplace

Wait for the registration result. If reading fails, use `Retry read`; if it completes, choose `Done` to return to `Workspace`.

Open the registered marketplace node to inspect its observed resources. Your personal marketplace opens a canvas grouped by plugin. `Refresh` reads changes made outside Omni.

What you will see: the registered personal marketplace canvas, with plugin groups and skill nodes.

[screenshot:connect-marketplace-confirm]

Next, read [marketplaces](academy://topic/marketplaces), then [Add a plugin to a project](academy://tutorial/add-a-plugin-to-a-project).
