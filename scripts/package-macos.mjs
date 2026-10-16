import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeElectronFramework } from "./macos-framework.mjs";
import { assertCleanSnapshot, assertSafeDestination, inspectRuntimeImports } from "./release-policy.mjs";
import { assertVersionAgreement, releaseManifest, signingConfiguration } from "./release/policy.mjs";
import { signApplication } from "./release/signing.mjs";
import { createDistribution } from "./release/distribution.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function hashDirectory(path) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Release resource cannot contain a symlink: ${relative}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative + "/");
      else {
        hash.update(relative + "\0");
        hash.update(await readFile(join(directory, entry.name)));
      }
    }
  }
  await visit(path);
  return hash.digest("hex");
}

async function copyApplication(snapshot, destination, metadata, config, identity) {
  const app = join(destination, "Omni Desktop.app");
  await cp(join(root, "node_modules/electron/dist/Electron.app"), app, { recursive: true, verbatimSymlinks: true });
  const resources = join(app, "Contents/Resources");
  await rm(join(resources, "default_app.asar"), { force: true });
  const appRoot = join(resources, "app");
  await mkdir(appRoot, { recursive: true });
  for (const path of [
    "out",
    "resources",
    "packages/omni-skills",
    "packages/omni-academy/academy.json",
    "packages/omni-catalogue/catalogue.json",
    "plugins/omni/runtime/omni-mcp.mjs",
  ]) {
    await mkdir(dirname(join(appRoot, path)), { recursive: true });
    await cp(join(snapshot, path), join(appRoot, path), { recursive: true });
  }
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      { name: "omni-desktop", productName: "Omni Desktop", version: metadata.version, main: "out/main/index.js" },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(appRoot, "build-info.json"), JSON.stringify(metadata, null, 2) + "\n");
  await cp(join(root, "node_modules/electron/dist/LICENSE"), join(resources, "ELECTRON-LICENSE"));
  await cp(join(root, "node_modules/electron/dist/LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
  const plist = join(app, "Contents/Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleDisplayName: "Omni Desktop",
    CFBundleName: "Omni Desktop",
    CFBundleIdentifier: identity.bundleId,
    CFBundleExecutable: "Omni Desktop",
    CFBundleShortVersionString: metadata.version,
    CFBundleVersion: metadata.version,
  })) {
    run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  }
  await rename(join(app, "Contents/MacOS/Electron"), join(app, "Contents/MacOS/Omni Desktop"));
  const launcher =
    '#!/bin/sh\nOMNI_APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n' +
    'export ELECTRON_RUN_AS_NODE=1\nexec "$OMNI_APP_ROOT/MacOS/Omni Desktop" "$OMNI_APP_ROOT/Resources/app/plugins/omni/runtime/omni-mcp.mjs" "$@"\n';
  await writeFile(join(resources, "omni-mcp"), launcher, { mode: 0o755 });
  if (config.mode === "developer-id") {
    run("xcrun", [
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(snapshot, "resources/macos/omni-mcp-launcher.c"),
      "-o",
      join(resources, "omni-mcp"),
    ]);
  }
  await normalizeElectronFramework(app);
  return app;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This packaging command requires macOS.");
  assertCleanSnapshot(run("git", ["status", "--porcelain", "--untracked-files=no"]));
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  const version = JSON.parse(run("git", ["show", `${commit}:package.json`])).version;
  const mcpVersion = run("git", ["show", `${commit}:packages/omni-mcp/src/version.ts`]);
  const tags = run("git", ["tag", "--points-at", commit])
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("v"));
  for (const value of tags) assertVersionAgreement(version, mcpVersion, value);
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : tags[0];
  assertVersionAgreement(version, mcpVersion, tag);
  const config = signingConfiguration(process.env);
  if (process.env.CI === "true" && (!tag || !config.notary))
    throw new Error("CI releases require an agreeing version tag, Developer ID signing and notarization.");
  const destination = resolve(process.argv[2] ?? join(root, "release", `${version}-${commit.slice(0, 8)}`));
  assertSafeDestination(destination, existsSync(destination));
  const snapshot = await mkdtemp(join(tmpdir(), "omni-release-source-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", commit], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    });
    await writeFile(join(snapshot, "source.tar"), archive);
    run("tar", ["-xf", "source.tar"], snapshot);
    await rm(join(snapshot, "source.tar"));
    const identity = JSON.parse(await readFile(join(snapshot, "resources/release-identity.json"), "utf8"));
    await symlink(join(root, "node_modules"), join(snapshot, "node_modules"));
    await symlink(join(root, "packages/omni-mcp/node_modules"), join(snapshot, "packages/omni-mcp/node_modules"));
    console.log(run("pnpm", ["build"], snapshot));
    for (const folder of ["main", "preload"]) {
      for (const entry of await readdir(join(snapshot, "out", folder))) {
        if (!entry.endsWith(".js")) continue;
        const external = inspectRuntimeImports(await readFile(join(snapshot, "out", folder, entry), "utf8"));
        if (external.length)
          throw new Error(`Unbundled runtime dependencies in ${folder}/${entry}: ${external.join(", ")}`);
      }
    }
    const metadata = {
      version,
      commit,
      channel: "release",
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      signing: config.mode,
      protocolVersion: "1",
      agentBundleHash: await hashDirectory(join(snapshot, "packages/omni-skills/skills")),
    };
    await mkdir(destination, { recursive: true });
    const app = await copyApplication(snapshot, destination, metadata, config, identity);
    const binaries = await signApplication({
      app,
      config,
      run,
      entitlements: join(snapshot, "resources/macos/entitlements.plist"),
    });
    const { artifacts, notarized } = await createDistribution({
      app,
      config,
      run,
      binaries,
      destination,
      scratch: snapshot,
      version,
      arch: process.arch,
    });
    const checksums = {};
    for (const artifact of Object.values(artifacts))
      checksums[artifact] = sha256(await readFile(join(destination, artifact)));
    const manifest = releaseManifest(metadata, artifacts, config.mode, notarized, checksums);
    await writeFile(join(destination, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
    checksums["release.json"] = sha256(await readFile(join(destination, "release.json")));
    await writeFile(
      join(destination, "SHA256SUMS"),
      Object.entries(checksums)
        .map(([name, hash]) => `${hash}  ${name}\n`)
        .join(""),
    );
    console.log(`Packaged ${app}\nManifest ${join(destination, "release.json")}`);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
await main();
