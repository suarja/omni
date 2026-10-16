import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { observeRegisteredEntry } from "../../src/application/project-source-registry";
import { scanInventory } from "../../src/application/inventory";
import { readGrantedArtifact } from "../../src/main/artifact-reader";
import type { RegistryGrant, RegistryGrantStore } from "../../src/main/registry-ipc";
import { createResourceCatalogue, type ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { createRegistryView, registerProject, type RegistryState } from "../../src/domain/project-source-registry";

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("real resource canvas read journey", () => {
  it("observes a registered project, resolves its artifact, and reads only through its grant", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-canvas-read-"));
    temporaryRoots.push(temporaryRoot);
    const projectRoot = join(temporaryRoot, "project");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(projectRoot));
    const source = "# Project instructions\n\nReal local file content.\n";
    const filePath = join(projectRoot, "AGENTS.md");
    await writeFile(filePath, source, "utf8");
    const canonicalRoot = await realpath(projectRoot);
    const subject = { kind: "project" as const, id: "canvas-project" };
    const empty: RegistryState = { schemaVersion: 1, revision: 0, projects: [], sources: [] };
    const registration = registerProject(empty, {
      ...subject,
      displayName: "Canvas project",
      canonicalPath: canonicalRoot,
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    const details = await stat(canonicalRoot);
    const grant: RegistryGrant = {
      handle: "canvas-project-grant",
      subject,
      root: canonicalRoot,
      device: String(details.dev),
      inode: String(details.ino),
      expiresAt: Date.now() + 60_000,
    };
    const grants: RegistryGrantStore = {
      issue: () => grant.handle,
      get: (handle) => (handle === grant.handle && grant.expiresAt > Date.now() ? grant : undefined),
    };
    const observed = await observeRegisteredEntry(
      registration.nextState,
      {
        subject,
        grant: { subject, canonicalPath: canonicalRoot, rootHandle: grant.handle },
        displayRoot: "canvas-project",
        observedAt: "2026-10-04T00:01:00.000Z",
      },
      scanInventory,
    );
    expect(observed.status).toBe("observed");
    if (observed.status !== "observed") return;
    const snapshot: ResourceSnapshot = {
      registry: createRegistryView(registration.nextState),
      roots: [{ entry: subject, evidence: { status: "observed", observation: observed.observation } }],
      uses: { status: "ready", bindings: [] },
    };
    const artifact = createResourceCatalogue(snapshot)
      .browse({ kind: "entry", entry: subject })
      .children.find((resource) => resource.relativePath === "AGENTS.md");
    expect(artifact?.ref.kind).toBe("artifact");
    const result = await readGrantedArtifact(
      { ...subject, grantHandle: grant.handle, relativePath: "AGENTS.md" },
      grants,
    );
    expect(result).toEqual({
      status: "read",
      content: source,
      byteLength: Buffer.byteLength(source),
      truncated: false,
    });
    expect(await readFile(filePath, "utf8")).toBe(source);
    await expect(
      readGrantedArtifact(
        { ...subject, id: "other-project", grantHandle: grant.handle, relativePath: "AGENTS.md" },
        grants,
      ),
    ).resolves.toEqual({ status: "denied" });
  });
});
