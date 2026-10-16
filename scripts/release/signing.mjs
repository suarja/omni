import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const MACH_O_MAGICS = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf"]);

/** @returns {Promise<boolean>} */
async function isMachO(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

/** @returns {Promise<{ targets: string[], binaries: string[] }>} */
export async function discoverCode(app) {
  const targets = [],
    binaries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      // Framework aliases must not cause signing the same code twice or following external links.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
        if (/\.(app|framework|xpc)$/u.test(path)) targets.push(path);
      } else if (entry.isFile() && (await isMachO(path))) {
        binaries.push(path);
        // Signing an app's main executable also seals its bundle. Seal it after its children.
        if (!/\.app\/Contents\/MacOS\/[^/]+$/u.test(path)) targets.push(path);
      }
    }
  }
  await visit(app);
  targets.push(app);
  return { targets, binaries };
}

/** @returns {{ command: string, args: string[] }[]} */
export function buildSigningPlan({ app, config, targets, binaries, entitlements }) {
  if (config.mode === "ad-hoc-local-only")
    return [
      { command: "/usr/bin/codesign", args: ["--force", "--deep", "--sign", "-", app] },
      { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", app] },
    ];
  return [
    ...targets.map((path) => ({
      command: "/usr/bin/codesign",
      args: [
        "--force",
        "--sign",
        config.identity,
        "--timestamp",
        "--options",
        "runtime",
        ...(config.keychain ? ["--keychain", config.keychain] : []),
        ...(path.endsWith(".app") ? ["--entitlements", entitlements] : []),
        path,
      ],
    })),
    ...[...new Set([...binaries, ...targets])].map((path) => ({
      command: "/usr/bin/codesign",
      args: ["--verify", "--strict", path],
    })),
  ];
}

/** @returns {Promise<string[]>} */
export async function signApplication({ app, config, run, entitlements, code }) {
  const discovered =
    config.mode === "developer-id" ? (code ?? (await discoverCode(app))) : { targets: [], binaries: [] };
  for (const step of buildSigningPlan({ app, config, entitlements, ...discovered })) await run(step.command, step.args);
  return discovered.binaries;
}

function notaryResult(output) {
  try {
    return JSON.parse(String(output));
  } catch {
    return {};
  }
}

/** @returns {Promise<void>} */
export async function notarize(archive, stapleTarget, credentials, run) {
  let result;
  try {
    result = notaryResult(
      await run("xcrun", [
        "notarytool",
        "submit",
        archive,
        "--wait",
        "--output-format",
        "json",
        "--key",
        credentials.keyPath,
        "--key-id",
        credentials.keyId,
        "--issuer",
        credentials.issuer,
      ]),
    );
  } catch (error) {
    const response = notaryResult(error.stdout);
    throw new Error(
      `Notarization failed. Notary log id: ${safeLogId(response.id)}. Retrieve the log with notarytool log and retry.`,
    );
  }
  if (result.status !== "Accepted")
    throw new Error(
      `Notarization failed. Notary log id: ${safeLogId(result.id)}. Retrieve the log with notarytool log and retry.`,
    );
  await run("xcrun", ["stapler", "staple", stapleTarget]);
  await run("xcrun", ["stapler", "validate", stapleTarget]);
}

function safeLogId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/u.test(value) ? value : "unavailable";
}

/** @returns {Promise<void>} */
export async function assessApplication(app, binaries, run) {
  for (const path of [...binaries, app]) await run("/usr/bin/codesign", ["--verify", "--strict", path]);
  // Gatekeeper assesses a distributable app, not standalone dylibs or resource scripts.
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
}
