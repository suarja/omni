/** @returns {{ version: string, prerelease: boolean }} */
export function parseVersion(version) {
  const numeric = "(0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  if (
    typeof version !== "string" ||
    !new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`, "u").test(version) ||
    /\s/u.test(version)
  )
    throw new Error("Release version must be Semver x.y.z or x.y.z-pre.N without build metadata.");
  return { version, prerelease: version.includes("-") };
}

/** @returns {void} */
export function assertVersionAgreement(version, mcpSource, tag) {
  parseVersion(version);
  const matches = [...mcpSource.matchAll(/export const RUNTIME_VERSION = "([^"]+)";/gu)];
  if (matches.length !== 1 || matches[0][1] !== version || (tag !== undefined && tag !== `v${version}`))
    throw new Error("Release tag, package.json and MCP version disagree. Run pnpm release:version before tagging.");
}

/** @returns {{ packageJson: string, mcpVersion: string, changelog: string }} */
export function planVersionBump(packageSource, mcpSource, changelog, version) {
  parseVersion(version);
  const pkg = JSON.parse(packageSource);
  assertVersionAgreement(pkg.version, mcpSource);
  if (pkg.version === version || changelog.split("\n").includes(`## ${version}`))
    throw new Error("Release version already exists. Choose a new version.");
  pkg.version = version;
  if (!changelog.startsWith("# Changelog\n")) throw new Error("CHANGELOG.md must start with # Changelog.");
  return {
    packageJson: JSON.stringify(pkg, null, 2) + "\n",
    mcpVersion: mcpSource.replace(/(RUNTIME_VERSION = ")[^"]+(";)/u, `$1${version}$2`),
    changelog: changelog.replace(
      "# Changelog\n",
      `# Changelog\n\n## ${version}\n\n- Describe the changes before tagging this release.\n`,
    ),
  };
}

/** @returns {{ zip: string, dmg: string }} */
export function artifactNames(version, arch) {
  parseVersion(version);
  if (!["arm64", "x64", "universal"].includes(arch)) throw new Error("Unsupported release architecture.");
  return { zip: `Omni-Desktop-${version}-mac-${arch}.zip`, dmg: `Omni-Desktop-${version}-${arch}.dmg` };
}

/** @returns {{ mode: string, identity?: string, keychain?: string, notary?: { keyPath: string, keyId: string, issuer: string } }} */
export function signingConfiguration(env) {
  const notaryValues = [env.OMNI_NOTARY_KEY_PATH, env.OMNI_NOTARY_KEY_ID, env.OMNI_NOTARY_ISSUER];
  const hasNotary = notaryValues.some((value) => value !== undefined);
  if (
    hasNotary &&
    (!notaryValues.every((value) => typeof value === "string" && value.trim()) || !env.OMNI_SIGN_IDENTITY)
  )
    throw new Error("Notarization requires all three OMNI_NOTARY values and a signing identity.");
  if (env.OMNI_SIGN_IDENTITY === undefined) return { mode: "ad-hoc-local-only" };
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(env.OMNI_SIGN_IDENTITY))
    throw new Error("OMNI_SIGN_IDENTITY must be a Developer ID Application identity.");
  return {
    mode: "developer-id",
    identity: env.OMNI_SIGN_IDENTITY,
    ...(env.OMNI_SIGN_KEYCHAIN ? { keychain: env.OMNI_SIGN_KEYCHAIN } : {}),
    ...(hasNotary ? { notary: { keyPath: notaryValues[0], keyId: notaryValues[1], issuer: notaryValues[2] } } : {}),
  };
}

/** @returns {Record<string, unknown>} */
export function releaseManifest(metadata, artifacts, signing, notarized, checksums) {
  return {
    ...metadata,
    artifacts,
    artifact: artifacts.zip,
    artifactSha256: checksums[artifacts.zip],
    signing,
    notarized,
    checksums,
    validation: {
      cleanTrackedSource: true,
      build: "PASS",
      runtimeImports: "PASS",
      signatureIntegrity: "PASS",
      gatekeeper: notarized ? "PASS" : "NOT RUN",
    },
  };
}

/** @returns {string} */
export function changelogSection(changelog, version) {
  parseVersion(version);
  const lines = changelog.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  if (!notes || notes.includes("Describe the changes before tagging"))
    throw new Error("Complete the changelog before releasing.");
  return notes + "\n";
}
