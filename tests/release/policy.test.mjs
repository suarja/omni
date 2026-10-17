import { describe, expect, it } from "vitest";
import {
  artifactNames,
  assertVersionAgreement,
  parseVersion,
  planVersionBump,
  releaseManifest,
  signingConfiguration,
} from "../../scripts/release/policy.mjs";

describe("release policy", () => {
  it.each(["1.2.3", "1.2.3-rc.1", "1.2.3-beta.2"])("accepts Semver %s", (version) => {
    expect(parseVersion(version).version).toBe(version);
  });
  it.each(["v1.2.3", "01.2.3", "1.2", "1.2.3-rc.01", "1.2.3\n", "1.2.3+meta"])(
    "refuses unsafe release version %s",
    (version) => {
      expect(() => parseVersion(version)).toThrow(/version/i);
    },
  );
  it("requires package, MCP and tag agreement before releasing", () => {
    expect(() => assertVersionAgreement("1.2.3", 'export const RUNTIME_VERSION = "1.2.3";\n', "v1.2.4")).toThrow(
      /disagree/,
    );
    expect(() => assertVersionAgreement("1.2.3", 'export const RUNTIME_VERSION = "1.2.4";\n')).toThrow(/disagree/);
    expect(() => assertVersionAgreement("1.2.3", 'export const RUNTIME_VERSION = "1.2.3";\n', "v1.2.3")).not.toThrow();
  });
  it("bumps both versions and creates one changelog section without losing history", () => {
    const result = planVersionBump(
      '{"version":"1.2.3","name":"example"}',
      'export const RUNTIME_VERSION = "1.2.3";\n',
      "# Changelog\n\n## 1.2.3\n\nOld changes.\n",
      "1.3.0-rc.1",
    );
    expect(JSON.parse(result.packageJson).version).toBe("1.3.0-rc.1");
    expect(result.mcpVersion).toContain('"1.3.0-rc.1"');
    expect(result.changelog).toContain("## 1.3.0-rc.1");
    expect(result.changelog).toContain("Old changes.");
    expect(() => planVersionBump(result.packageJson, result.mcpVersion, result.changelog, "1.3.0-rc.1")).toThrow();
  });
  it("names architecture-specific update and installer artifacts", () => {
    expect(artifactNames("1.2.3", "arm64")).toEqual({
      zip: "Omni-1.2.3-mac-arm64.zip",
      dmg: "Omni-1.2.3-arm64.dmg",
    });
    expect(() => artifactNames("1.2.3", "../bad")).toThrow();
  });
  it("keeps ad-hoc builds local and refuses partial notarization credentials", () => {
    expect(signingConfiguration({})).toEqual({ mode: "ad-hoc-local-only" });
    expect(() => signingConfiguration({ OMNI_NOTARY_KEY_ID: "FAKEKEY001" })).toThrow(/all|complete/i);
    expect(() => signingConfiguration({ OMNI_SIGN_IDENTITY: "-" })).toThrow(/Developer ID/);
    expect(
      signingConfiguration({ OMNI_SIGN_IDENTITY: "Developer ID Application: Example Person (ABCDE12345)" }).mode,
    ).toBe("developer-id");
  });
  it("records provenance, signing and notarization separately", () => {
    expect(
      releaseManifest(
        { version: "1.2.3", commit: "a".repeat(40) },
        { zip: "update.zip", dmg: "install.dmg" },
        "ad-hoc-local-only",
        false,
        { "update.zip": "a".repeat(64) },
      ),
    ).toMatchObject({
      version: "1.2.3",
      signing: "ad-hoc-local-only",
      notarized: false,
      artifacts: { zip: "update.zip", dmg: "install.dmg" },
    });
  });
});
