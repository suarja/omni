# Changelog

## 0.5.3

Omni shows what your agents really get.

- Approved changes to your marketplace are pushed to GitHub right away, branch only, never forced.
  A failed push shows its reason with Retry; a diverged history is never rewritten.
- The workspace shows your marketplace's sync state, installed Claude Code and Codex plugins that
  are behind your marketplace (with an approved one-click update), and projects with conflicts or
  pending updates.
- "Restart to update" is now a primary button in the window toolbar as soon as an update is ready.

## 0.5.2

The window is just the window.

- Omni no longer paints its own frame inside the window: the dark (or grey) ring around the app
  and its corners is gone in both appearances. macOS draws the window's shape and edge.

## 0.5.1

Updates that install, and a calmer workspace.

- "Restart to update" now installs the downloaded version: Omni stops checking once an update is
  downloaded, so a later empty check can no longer cancel it. Quitting Omni always ends the app and
  its child processes within a few seconds.
- A native macOS 26 app icon (light, dark and tinted), without the dark frame around it.
- The Omni center appears only during setup. Once setup is finished or hidden, the workspace lays
  sources, projects and agents out across the canvas, with straight branching links and a single
  link from your agents to your projects.
- A project subtitle no longer stays a loading bar; unread projects say "Not read yet".
- Setup names the step that is left. If you added your own marketplace as an external source,
  Omni offers to use it as your marketplace in one click, with Undo. Adding a first marketplace
  opens on "My marketplace".

If you run 0.5.0 or earlier, install 0.5.1 from the DMG once: the update bug is in those versions.

## 0.5.0

Agents can share on purpose.

- New MCP tool `omni_preview_link_storefront`: an agent links a public storefront folder that Omni
  does not know yet. Omni reads its `ORIGIN.md`, shows the recognized plugins and their workshop
  source, writes nothing in the folder, and can undo the link.
- New agent skill `omni-share`: "share this plugin", "make a marketplace for…" or "publish" choose
  a storefront by audience, make the plugin generic in the workshop, preview, and wait for your
  approval in Omni. The publication rule now lives in this one skill.

## 0.4.0

A real first screen, and calm loading everywhere.

- First run shows the workspace map before it is filled: your marketplace, your projects and your
  agents around Omni, each with its step. Every step can be done in any order, hidden, and shown
  again from Help. The map, its Omni center and its links stay once setup is done.
- Every surface loads with skeletons shaped like the final layout, after a short delay, with no
  text in the corner and no layout jump; background refreshes keep the current content.
- Canvases open already framed: nothing moves when late data arrives.
- The External library appears only once it has a source; a first marketplace opens on the
  personal tab.

## 0.3.0

The app is now called Omni.

- New name, app icon and identity: `Omni.app`, data in `~/Library/Application Support/Omni`.
  Settings from 0.2.0 are not carried over; connect your marketplace again on first launch.
- This repository is an `omni` plugin marketplace for Claude Code and Codex, and the plugin
  starts Omni's MCP server in each agent.
- A new README with a demo.

## 0.2.0

First public release.

- Signed and notarized macOS build (Apple silicon), distributed as a DMG and a ZIP.
- Automatic updates from GitHub Releases, with an opt-out in Settings and an explicit restart.
- Register any local project, not only those found by the agents.
- Packages that declare a manifest id open correctly from the canvas.
- Connect agents from the workspace setup opens Settings; the restore preview is no longer empty.
- Marketplace locations outside your home folder show their full path.
- No false "locations could not be observed" warning while the canvas loads.
- Academy tutorials rewritten for the workspace canvas, with new screenshots.

## 0.1.1-rc.15

- Publish the create-skill and receipt MCP schemas.
