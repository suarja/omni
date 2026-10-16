import { describe, expect, it } from "vitest";
import { buildSigningPlan, notarize, signApplication, assessApplication } from "../../scripts/release/signing.mjs";
import { createDistribution } from "../../scripts/release/distribution.mjs";

const app = "/tmp/example/Omni Desktop.app";
const config = {
  mode: "developer-id",
  identity: "Developer ID Application: Example Person (ABCDE12345)",
  notary: { keyPath: "/tmp/fake-key.p8", keyId: "FAKEKEY001", issuer: "00000000-0000-0000-0000-000000000001" },
};
const binaries = [
  `${app}/Contents/Frameworks/Example.framework/Versions/A/Example`,
  `${app}/Contents/Resources/omni-mcp`,
  `${app}/Contents/MacOS/Omni Desktop`,
];
const targets = [...binaries.slice(0, 2), `${app}/Contents/Frameworks/Example.framework`, app];

describe("signed distribution command execution", () => {
  it("retains the local ad-hoc path without notary or Gatekeeper calls", async () => {
    const calls = [];
    await signApplication({ app, config: { mode: "ad-hoc-local-only" }, run: (...args) => calls.push(args) });
    expect(calls).toEqual([
      ["/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]],
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", app]],
    ]);
  });
  it("signs inside-out, timestamps with hardened runtime, and verifies all code objects", () => {
    const plan = buildSigningPlan({ app, config, targets, binaries, entitlements: "/tmp/jit.plist" });
    const signing = plan.filter((step) => step.args.includes("--sign"));
    expect(signing.map((step) => step.args.at(-1))).toEqual(targets);
    expect(
      signing.every(
        (step) => step.args.includes("--timestamp") && step.args.includes("runtime") && !step.args.includes("--deep"),
      ),
    ).toBe(true);
    for (const binary of binaries)
      expect(plan).toContainEqual({ command: "/usr/bin/codesign", args: ["--verify", "--strict", binary] });
    expect(signing.at(-1).args).toContain("/tmp/jit.plist");
  });
  it("fails notarization with its log id and never staples a rejected submission", async () => {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      return JSON.stringify({ id: "fake-log-id", status: "Invalid" });
    };
    await expect(notarize("/tmp/upload.zip", app, config.notary, run)).rejects.toThrow("fake-log-id");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain("--wait");
  });
  it("reports a log id from a nonzero notarytool response without leaking command errors", async () => {
    const run = () => {
      throw Object.assign(new Error("private command arguments"), {
        stdout: JSON.stringify({ id: "fake-failed-id", status: "Invalid" }),
      });
    };
    await expect(notarize("/tmp/upload.zip", app, config.notary, run)).rejects.toThrow("fake-failed-id");
  });
  it("staples and validates only an accepted ticket before Gatekeeper assessment", async () => {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      return JSON.stringify({ id: "fake-accepted-id", status: "Accepted" });
    };
    await notarize("/tmp/upload.zip", app, config.notary, run);
    await assessApplication(app, binaries, run);
    expect(calls[1]).toEqual(["xcrun", ["stapler", "staple", app]]);
    expect(calls[2]).toEqual(["xcrun", ["stapler", "validate", app]]);
    expect(calls.at(-1)).toEqual(["/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]]);
  });
  it("creates both final artifacts from the stapled app and notarizes the signed DMG", async () => {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      return JSON.stringify({ id: "fake-log", status: "Accepted" });
    };
    const fs = { mkdir: async () => {}, cp: async () => {}, symlink: async () => {}, rm: async () => {} };
    await createDistribution({
      app,
      destination: "/tmp/example",
      scratch: "/tmp/scratch",
      version: "1.2.3",
      arch: "arm64",
      config,
      run,
      fs,
    });
    const stapled = calls.findIndex(([, args]) => args[0] === "stapler" && args[1] === "staple" && args[2] === app);
    const zip = calls.findIndex(([, args]) => args.at(-1) === "/tmp/example/Omni-Desktop-1.2.3-mac-arm64.zip");
    expect(zip).toBeGreaterThan(stapled);
    expect(calls.some(([command, args]) => command === "/usr/bin/hdiutil" && args.includes("UDZO"))).toBe(true);
    expect(calls.some(([, args]) => args[0] === "stapler" && args[1] === "staple" && args[2].endsWith(".dmg"))).toBe(
      true,
    );
  });
});
