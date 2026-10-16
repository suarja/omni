#!/usr/bin/env node
import { createDemoProfile } from "./profile.mjs";

try {
  if (process.argv.length !== 3) throw new Error("Usage: pnpm demo:profile <empty-dir>");
  const profile = await createDemoProfile(process.argv[2]);
  process.stdout.write(
    `Created synthetic demo at ${profile.root}\nOmni userData is empty. Launch and seed through the real app as described in scripts/demo-profile/README.md.\n`,
  );
} catch (error) {
  process.stderr.write(
    `Demo profile failed: ${error.message}\nNo existing files are overwritten. Inspect a partial target and choose a new empty directory to retry.\n`,
  );
  process.exitCode = 1;
}
