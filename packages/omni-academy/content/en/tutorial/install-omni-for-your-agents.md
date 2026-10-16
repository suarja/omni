---
title: Install Omni for your agents
kind: tutorial
summary: Connect each detected agent from Settings and verify a real Omni call.
minutes: 4
products: [claude-code, codex]
illustration: agent
topic: mcp
cta: { route: agents-setup, label: Open Settings }
steps: [1. Open Settings, 2. Choose an agent, 3. Confirm and verify a session]
---

## 1. Open Settings

Choose `Settings` in the canvas rail. The `Agents` section shows each supported agent and its observed connection state.

`Not found on this Mac` means there is no Connect action for that agent. Configure the agent locally, then reopen Settings.

What you will see: Settings with the `Agents` section and per-agent status.

[screenshot:install-agents-home]

## 2. Choose an agent

For a detected agent marked `Not connected`, choose `Connect` on its row. Each agent is connected separately.

Read `Connect Codex?` or `Connect Claude Code?`. The confirmation describes the omni tool, Omni’s skills, and protection for files it manages.

What you will see: the connection confirmation for a detected agent that is not yet connected.

[screenshot:install-agents-select]

## 3. Confirm and verify a session

Read the confirmation before its final `Connect`. That click prepares and applies the installation. This sheet shows a summary rather than file-by-file diffs.

After connecting, open a new agent session and make an Omni call. Return to the agent row’s `More actions`, then `Check connection`, to read the last-call evidence. A connected status alone does not prove a call succeeded.

Repeat for another agent when needed. Do not use `Reinstall` just to inspect a connection; it writes files.

What you will see: the connection summary and final `Connect` button before installation.

[screenshot:install-agents-review]

Next, read [marketplaces](academy://topic/marketplaces), then [Undo anything Omni wrote](academy://tutorial/undo-anything-omni-wrote).
