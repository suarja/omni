import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedUxPass2Fixture } from "./ux-pass-2-fixture";
import { run } from "../ipc/apply-ipc-helpers";

it("seeds two named projects with owned, local and locked external skills in temporary roots", async () => {
  const fixture = await seedUxPass2Fixture();
  const marketplace = JSON.parse(await readFile(join(fixture.sourceRoot, "omni.marketplace.json"), "utf8"));
  expect(marketplace.packages).toHaveLength(3);
  const manifests = await Promise.all(
    marketplace.packages.map(async ({ path }: { path: string }) =>
      JSON.parse(await readFile(join(fixture.sourceRoot, path, "omni.plugin.json"), "utf8")),
    ),
  );
  expect(manifests.filter(({ description }) => description)).toHaveLength(2);
  expect((await run("git", ["-C", fixture.sourceRoot, "status", "--porcelain"])).stdout).toBe("");
  expect((await stat(fixture.unregisteredProjectRoot)).isDirectory()).toBe(true);
  expect((await run("git", ["-C", fixture.unregisteredProjectRoot, "status", "--porcelain"])).stdout).toBe("");
  expect(await readFile(join(fixture.unregisteredProjectRoot, "AGENTS.md"), "utf8")).toContain("Keep changes small");
  expect(fixture.projects.map(({ name }) => name)).toEqual(["alpha", "beta"]);
  const [alpha, beta] = fixture.projects;
  expect(alpha!.skills.skills).toHaveLength(3);
  expect(alpha!.skills.skills.find(({ name }) => name === "review")).toMatchObject({
    origin: { kind: "mine" },
    agents: { "claude-code": { state: "installed" }, codex: { state: "installed" } },
  });
  expect(alpha!.skills.skills.find(({ name }) => name === "local-tool")).toMatchObject({
    origin: { kind: "project-only" },
    agents: { "claude-code": { state: "installed" }, codex: { state: "absent" } },
  });
  expect(alpha!.skills.skills.find(({ name }) => name === "grill-me")).toMatchObject({
    origin: { kind: "external", source: "mattpocock/skills" },
    agents: { "claude-code": { state: "installed" }, codex: { state: "installed" } },
  });
  expect(beta!.skills.skills).toHaveLength(1);
  expect(beta!.skills.skills[0]).toMatchObject({
    origin: { kind: "mine" },
    agents: { "claude-code": { state: "installed" }, codex: { state: "absent" } },
  });
  expect((await stat(fixture.agentHomePath)).isDirectory()).toBe(true);
  const registry = JSON.parse(await readFile(join(fixture.userDataPath, "omni/project-source-registry.json"), "utf8"));
  expect(registry.projects.map(({ displayName }: { displayName: string }) => displayName)).toEqual(["alpha", "beta"]);
});
