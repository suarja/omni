import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { artifactNames } from "./policy.mjs";
import { assessApplication, notarize } from "./signing.mjs";

/** @returns {Promise<{ artifacts: { zip: string, dmg: string }, notarized: boolean }>} */
export async function createDistribution({
  app,
  destination,
  scratch,
  version,
  arch,
  config,
  run,
  binaries = [],
  fs = filesystem,
}) {
  const artifacts = artifactNames(version, arch);
  const zip = (output) => run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, output]);
  if (config.notary) {
    const upload = join(scratch, "notary-upload.zip");
    try {
      await zip(upload);
      await notarize(upload, app, config.notary, run);
    } finally {
      await fs.rm(upload, { force: true });
    }
    await assessApplication(app, binaries, run);
  }
  await zip(join(destination, artifacts.zip));
  const stage = join(scratch, "dmg-root");
  await fs.mkdir(stage);
  await fs.cp(app, join(stage, "Omni Desktop.app"), { recursive: true, verbatimSymlinks: true });
  await fs.symlink("/Applications", join(stage, "Applications"));
  const dmg = join(destination, artifacts.dmg);
  await run("/usr/bin/hdiutil", ["create", "-volname", "Omni Desktop", "-srcfolder", stage, "-format", "UDZO", dmg]);
  if (config.mode === "developer-id") {
    await run("/usr/bin/codesign", [
      "--force",
      "--sign",
      config.identity,
      "--timestamp",
      ...(config.keychain ? ["--keychain", config.keychain] : []),
      dmg,
    ]);
    await run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
  }
  if (config.notary) {
    await notarize(dmg, dmg, config.notary, run);
    await run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=2",
      dmg,
    ]);
  }
  return { artifacts, notarized: Boolean(config.notary) };
}
