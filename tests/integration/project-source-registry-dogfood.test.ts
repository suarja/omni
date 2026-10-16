import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { observeRegisteredEntry } from "../../src/application/project-source-registry";
import { scanInventory } from "../../src/application/inventory";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import {
  createRegistryView,
  parseRegistryState,
  registerProject,
  registerSource,
  type EntryRef,
  type RegistrationInput,
  type RegistryState,
  type SourceRegistrationInput,
} from "../../src/domain/project-source-registry";
import type { ProjectSourceRegistryStore } from "../../src/ports/project-source-registry";

const omniRoot = fileURLToPath(new URL("../../", import.meta.url));

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function assertDirectory(path: string): Promise<string> {
  await access(path);
  return realpath(path);
}

async function readyState(store: ProjectSourceRegistryStore): Promise<RegistryState> {
  const result = await store.read();
  if (result.status !== "ready") throw new Error(result.diagnostic);
  return result.state;
}

async function registerRealProject(store: ProjectSourceRegistryStore, input: RegistrationInput): Promise<EntryRef> {
  const state = await readyState(store);
  const decision = registerProject(state, input);
  const mutation = await store.mutate(state.revision, () => decision.nextState);
  if (mutation.status !== "ready") throw new Error("Project registration did not persist.");
  return decision.result.entry.ref;
}

async function registerRealSource(
  store: ProjectSourceRegistryStore,
  input: SourceRegistrationInput,
): Promise<EntryRef> {
  const state = await readyState(store);
  const decision = registerSource(state, input);
  if (decision.result.status !== "ready") throw new Error("Source ownership classification conflicted.");
  const mutation = await store.mutate(state.revision, () => decision.nextState);
  if (mutation.status !== "ready") throw new Error("Source registration did not persist.");
  return decision.result.entry.ref;
}

async function observe(state: RegistryState, subject: EntryRef, canonicalPath: string, displayRoot: string) {
  return observeRegisteredEntry(
    state,
    {
      subject,
      grant: { subject, canonicalPath, rootHandle: `grant-${subject.id}` },
      displayRoot,
      observedAt: "2026-09-09T12:00:00.000Z",
    },
    (request) => scanInventory(request),
  );
}

describe("real project and source registry dogfood", () => {
  it("persists and observes Omni plus a neighboring local workspace without writes", async () => {
    const workspaceRoot = await assertDirectory(dirname(omniRoot));
    const projectRoot = await assertDirectory(omniRoot);
    const registryTempRoot = await mkdtemp(join(tmpdir(), "omni-registry-dogfood-"));
    const registryPath = join(registryTempRoot, "registry.json");
    const store = createLocalJsonRegistryStore(registryPath);
    const beforePackage = await readFile(join(projectRoot, "package.json"), "utf8");
    const beforeGit = await runGit(projectRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);

    try {
      const omniProject = await registerRealProject(store, {
        id: "omni-desktop",
        displayName: "Omni Desktop",
        canonicalPath: projectRoot,
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      const neighboringProject = await registerRealProject(store, {
        id: "omni-workspace",
        displayName: "Omni workspace",
        canonicalPath: workspaceRoot,
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      const personalSource = await registerRealSource(store, {
        id: "personal-omni-source",
        displayName: "Personal Omni source",
        canonicalPath: projectRoot,
        ownership: "personal",
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      const externalSource = await registerRealSource(store, {
        id: "external-omni-source",
        displayName: "External workspace source",
        canonicalPath: workspaceRoot,
        ownership: "external",
        createdAt: "2026-09-09T12:00:00.000Z",
      });

      const persisted = parseRegistryState(JSON.parse(await readFile(registryPath, "utf8")) as unknown);
      expect(persisted.projects.map(({ id }) => id)).toEqual([omniProject.id, neighboringProject.id]);
      expect(persisted.sources.map(({ id }) => id)).toEqual([personalSource.id, externalSource.id]);

      const projectObservation = await observe(persisted, omniProject, projectRoot, "omni-desktop");
      const neighboringObservation = await observe(persisted, neighboringProject, workspaceRoot, "omni-workspace");
      const personalObservation = await observe(persisted, personalSource, projectRoot, "omni-desktop");
      const externalObservation = await observe(persisted, externalSource, workspaceRoot, "omni-workspace");

      for (const result of [projectObservation, neighboringObservation, personalObservation, externalObservation]) {
        expect(result.status).toBe("observed");
        if (result.status === "observed") {
          expect(result.observation.subject).toBeDefined();
          expect(result.observation.inventory.rootHandle).not.toContain("/");
          expect(
            result.observation.inventory.artifacts.every(
              (artifact) => artifact.scope === result.observation.subject.kind,
            ),
          ).toBe(true);
        }
      }

      if (projectObservation.status === "observed" && personalObservation.status === "observed") {
        const projectSkill = projectObservation.observation.inventory.artifacts.find((artifact) =>
          artifact.displayPath.includes(".cursor/skills"),
        );
        const sourceSkill = personalObservation.observation.inventory.artifacts.find((artifact) =>
          artifact.displayPath.includes(".cursor/skills"),
        );
        expect(projectSkill).toBeDefined();
        expect(sourceSkill).toBeDefined();
        expect(projectSkill?.id).not.toBe(sourceSkill?.id);
      }

      const archivedState = await readyState(store);
      const archived = await store.mutate(archivedState.revision, (state) => ({
        ...state,
        sources: state.sources.map((source) =>
          source.id === externalSource.id ? { ...source, archivedAt: "2026-09-09T12:01:00.000Z" } : source,
        ),
      }));
      expect(archived.status).toBe("ready");

      const reactivatedState = await readyState(store);
      const reactivated = registerSource(reactivatedState, {
        id: externalSource.id,
        displayName: "External workspace source",
        canonicalPath: workspaceRoot,
        ownership: "external",
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      expect(reactivated.result).toMatchObject({
        status: "ready",
        outcome: "reactivated",
        entry: { ref: externalSource },
      });
      const reactivationMutation = await store.mutate(reactivatedState.revision, () => reactivated.nextState);
      expect(reactivationMutation.status).toBe("ready");
      if (reactivationMutation.status !== "ready") throw new Error("Source reactivation did not persist.");

      const redactedView = createRegistryView(reactivationMutation.state);
      expect(JSON.stringify(redactedView)).not.toContain(projectRoot);
      expect(JSON.stringify(redactedView)).not.toContain(workspaceRoot);
      expect(JSON.stringify(redactedView)).toContain("omni-desktop");

      const afterPackage = await readFile(join(projectRoot, "package.json"), "utf8");
      const afterGit = await runGit(projectRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
      expect(afterPackage).toBe(beforePackage);
      expect(afterGit).toBe(beforeGit);
      expect(await readFile(registryPath, "utf8")).toContain("personal-omni-source");
    } finally {
      await rm(registryTempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a registered root visible when the real directory disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-registry-missing-"));
    const vanishedRoot = join(root, "vanished-project");
    await mkdir(vanishedRoot, { recursive: true });
    const canonicalVanishedRoot = await realpath(vanishedRoot);
    const store = createLocalJsonRegistryStore(join(root, "registry.json"));

    try {
      const missingProject = await registerRealProject(store, {
        id: "vanished-project",
        displayName: "Vanished project",
        canonicalPath: canonicalVanishedRoot,
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      await rm(vanishedRoot, { recursive: true, force: true });
      const result = await observe(await readyState(store), missingProject, canonicalVanishedRoot, "vanished-project");
      expect(result).toEqual({
        status: "inaccessible",
        subject: missingProject,
        diagnostic: "The registered root could not be observed.",
      });
      const stateAfterObservation = await readyState(store);
      expect(stateAfterObservation.projects.find(({ id }) => id === missingProject.id)?.archivedAt).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
