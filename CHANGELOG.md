# Changelog

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
