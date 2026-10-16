# Synthetic demo profile

Run from the repository root with Node, pnpm and Git installed:

```sh
pnpm demo:profile /private/tmp/omni-o2-demo-20261016
pnpm test scripts/demo-profile/profile.test.mjs
pnpm build
```

The destination must be empty or absent. Use a physical path, such as `/private/tmp`,
without symbolic-link ancestors. Existing files are never overwritten. After a partial
failure, inspect the target and choose a new empty directory to retry.

## Layout

- `home/` contains synthetic Claude Code, Codex, OpenCode and Cursor config files,
  empty Claude Code/Codex skill directories, and Ada Example's Git identity.
- `projects/` contains `acme-web`, `notes-app` and `acme-workspace`. Each is a clean,
  tiny Git repository with instructions, two project skills and a runnable Node test.
- `acme-skills/` is a Git marketplace with four plugins and five original skills.
  It has native Omni manifests and Claude Code/Codex plugin manifests.
- `userData/` is empty. The generator never writes Omni stores or receipts.
- `tmp/` is reserved for the demo app's temporary files and gateway socket fallback.

Every initial commit uses `Ada Example <ada@example.com>` and a fixed date.
Git ignores inherited configuration, repository redirects, hooks, templates and signing.
No repository is cloned and no network request is made.

## Launch the real app

On macOS, after building, run this exact command from the repository root:

```sh
demo_home=/private/tmp/omni-o2-demo-20261016/home
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$demo_home" \
  OMNI_USER_DATA=/private/tmp/omni-o2-demo-20261016/userData \
  TMPDIR=/private/tmp/omni-o2-demo-20261016/tmp \
  XDG_CONFIG_HOME="$demo_home/.config" \
  XDG_CACHE_HOME="$demo_home/.cache" \
  GIT_CONFIG_NOSYSTEM=1 \
  ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9334
```

`OMNI_USER_DATA` is resolved in `src/main/runtime-identity.ts`; `src/main/index.ts`
sets Electron's profile before acquiring its single-instance lock. Login items are
unavailable for this development app and explicit profile. The empty environment
also removes inherited agent homes, Git redirects and Electron renderer overrides.
The launcher calls the built Electron binary directly. It never wakes an installed app.

Verify `http://127.0.0.1:9334/json/list` before attaching CDP. Never attach the
Academy capture script to another app or port. If the sandbox denies socket creation
or Electron startup, run the command outside that sandbox and retain the same demo path.

## Seed through Omni

This is a manual continuation through the real app, not a claim of completed seeding.
Use only resources inside this demo directory:

1. Connect `acme-skills/` as the personal marketplace through the app's connection flow.
2. Register all three folders under `projects/` through Omni's project registration flow.
3. Preview and apply Claude Code and Codex agent setup. Verify their configs and
   operation receipts point to the demo's `userData/` and `home/`.
4. Add the `web-quality` plugin to `acme-web` for both agents through the real
   preview/apply flow. Keep the receipt restorable and leave its files untouched.
5. Keep `acme-workspace`'s local skills unmanaged for the skill-capture previews.
6. Set the interface language to French, matching the existing Academy walkthroughs.

Do not write registry, operation, binding or settings JSON by hand. Do not use an
installed MCP client's default endpoint. A successful fixture generation does not
prove that registration, agent setup, assignment or restore succeeded.

## Academy continuation

The existing capture script uses CDP port 9334 and 18 read-only walks:

```sh
node scripts/academy-shots.mjs
```

Before running it, check the current navigation and test IDs against the seeded app.
The script predates the current canvas navigation and may require adapting those
read-only walks. Agent setup shots must open a preview even after setup is complete.
Walks must never click a final apply, save, install or restore confirmation.

Retake all images at 1440 by 900, open every image, check private terms and home paths,
and record its actual contents before adding its path to the public image allowlist.
The generator alone does not make the existing captures safe for export.
