import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSkillInventoryResponse } from "../../src/shared/skill-inventory";
import { fixture, skill, FIXTURE_TIMEOUT_MS } from "./agent-gateway-audit-fixture";
const client = { name: "test", version: "1" };

describe("read-only skills audit", () => {
  it(
    "keeps readable search matches when one registered root is missing",
    async () => {
      const f = await fixture();
      await expect(f.router.handle("find_skill", { query: "review" }, client)).resolves.toMatchObject({
        status: "partial",
        matches: expect.arrayContaining([expect.objectContaining({ root: { kind: "project", id: f.projectId } })]),
        unreadRoots: [expect.objectContaining({ name: "missing-project", reason: "missing" })],
      });
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "reports an unavailable project without resolving its bindings as conflicts",
    async () => {
      const f = await fixture();
      await expect(f.router.handle("status", {}, client)).resolves.toMatchObject({
        projects: expect.arrayContaining([
          {
            id: f.missingId,
            name: "missing-project",
            root: join(f.project, "..", "missing-project"),
            available: false,
            reason: "missing",
          },
          { id: f.projectId, name: "acme-app", root: f.project, available: true },
        ]),
      });
      await expect(f.router.handle("drift_report", { projectId: f.missingId }, client)).resolves.toMatchObject({
        bindings: [{ bindingId: "unavailable", projectAvailable: false, reason: "missing", state: "unavailable" }],
      });
      expect(f.preview).not.toHaveBeenCalled();
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "collapses linked locations, fingerprints full folders, and exposes identity evidence",
    async () => {
      const f = await fixture();
      const result = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      const review = result.units.filter(
        (unit) =>
          result.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId && unit.name === "review",
      );
      expect(review).toHaveLength(1);
      expect(review[0]).toMatchObject({
        files: 2,
        lines: 5,
        path: ".agents/skills/review/SKILL.md",
        locations: expect.arrayContaining([
          { harness: "claude-code", folder: ".claude/skills/review", linkTo: "../../.agents/skills/review" },
        ]),
      });
      expect(review[0]?.hash).toMatch(/^[a-f0-9]{12}$/u);
      expect(join(result.scopes!.find((scope) => scope.key === review[0]!.scope)!.root, review[0]!.path)).toBe(
        join(f.project, ".agents/skills/review/SKILL.md"),
      );
      expect(result.identity!.byName).toEqual(expect.arrayContaining([expect.objectContaining({ name: "review" })]));
      expect(result.identity!.sameContentDifferentNames).not.toHaveLength(0);
      const finding = result.identity!.byName.find((finding) => finding.name === "review")!;
      expect(finding.kinds).toEqual(["sameNameDifferentContent", "unlinkedCopies", "multipleSources"]);
      expect(finding.hashes[review[0]!.id]).toBe(review[0]!.hash);
      expect(finding.unlinkedCopies).toEqual(
        expect.arrayContaining([expect.objectContaining({ project: review[0]!.id, marketplace: expect.any(String) })]),
      );
      expect(new Set(result.identity!.byName.map((finding) => finding.name)).size).toBe(result.identity!.byName.length);
      expect(result.identity!.byName).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "handoff", kinds: expect.arrayContaining(["multipleSources"]) }),
        ]),
      );
      expect(result.identity!.staleBindings).toEqual([expect.objectContaining({ bindingId: "stale" })]);
      expect(result.unavailable).toEqual([expect.objectContaining({ projectId: f.missingId, reason: "missing" })]);
      expect(f.observe).not.toHaveBeenCalledWith({ kind: "project", id: f.missingId });
      expect(f.observe).not.toHaveBeenCalledWith({ kind: "project", id: f.archivedId });
      expect(JSON.stringify(result).length).toBeLessThan(20_000);
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "reports cached external use state and source path without fetching anything",
    async () => {
      const f = await fixture();
      const first = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      const local = first.units.find(
        (unit) =>
          first.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId && unit.name === "handoff",
      )!;
      expect(local.origin).toEqual({
        kind: "external",
        repo: "example/skills",
        skillPath: "skills/handoff",
        state: "unknown",
      });
      const observation = await f.registry.observeRegisteredEntry({ kind: "project", id: f.projectId });
      if (observation.status !== "observed") throw new Error("Fixture project failed.");
      const copyHash = observation.observation.inventory.skillOrigins!.find(
        (origin) => origin.skillKey === "handoff",
      )!.copyHash!;
      const { publishExternalSnapshot } = await import("../../src/main/external-library/snapshot");
      publishExternalSnapshot(f.userDataPath, {
        sources: [],
        roots: new Map(),
        lockedUses: [],
        diagnostics: [],
        observations: new Map([
          [
            "example/skills",
            {
              skills: [{ path: "skills/handoff", name: "handoff" }],
              hashes: new Map([["skills/handoff", copyHash]]),
              removed: new Set(),
              failed: false,
            },
          ],
        ]),
      } as never);
      const result = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      expect(
        result.units.find(
          (unit) =>
            result.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId &&
            unit.name === "handoff",
        )?.origin,
      ).toMatchObject({
        state: "current",
      });
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "compares managed copies to their recorded base instead of reporting unknown drift",
    async () => {
      const f = await fixture();
      await writeFile(
        join(f.project, ".agents/skills/review/SKILL.md"),
        await readFile(join(f.marketplace, "skills/review/SKILL.md")),
      );
      const handle = await f.registry.getGrantForEntry({ kind: "project", id: f.projectId });
      const grant = f.registry.get(handle!)!;
      const { captureProjectSkillRevision } = await import("../../src/main/skill-management/project-skill-revisions");
      const revision = (await captureProjectSkillRevision(grant, ".agents/skills/review"))!;
      const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
      const baseId = "11111111-1111-4111-8111-111111111111";
      await createSkillBaseStore(f.userDataPath).publish(
        baseId,
        revision,
        new Map([
          ["SKILL.md", await readFile(join(f.project, ".agents/skills/review/SKILL.md"))],
          ["notes.md", await readFile(join(f.project, ".agents/skills/review/notes.md"))],
        ]),
      );
      const observed = await f.registry.observeRegisteredEntry({ kind: "source", id: f.bindings[0]!.sourceId });
      if (observed.status !== "observed") throw new Error("Fixture source was not observed.");
      const artifact = observed.observation.inventory.artifacts.find(
        (artifact) => artifact.relativePath === "skills/review/SKILL.md",
      )!;
      const skillId = "22222222-2222-4222-8222-222222222222";
      const location = { projectId: f.projectId, harnessId: "codex" as const, folderPath: ".agents/skills/review" };
      const use = {
        skillId,
        bindingId: "managed-review",
        location,
        source: { sourceId: f.bindings[0]!.sourceId, packageId: artifact.packageId!, artifactPath: "skills/review" },
        baseRevisionId: baseId,
      };
      const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
      await createSkillRelationshipStore(join(f.userDataPath, "omni/skill-relationships.json")).updateUsesExact(
        0,
        [{ skillId, location, after: use }],
        [{ skillId, after: { skillId, label: "review", evidence: "individual", locations: [location] } }],
      );
      const readState = async (): Promise<unknown> => {
        const result = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
        return result.units.find(
          (unit) =>
            result.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId &&
            unit.name === "review",
        )?.origin;
      };
      expect(await readState()).toMatchObject({ kind: "marketplace", bindingId: "managed-review", state: "current" });
      await writeFile(join(f.marketplace, "skills/review/notes.md"), "Upstream change\n");
      expect(await readState()).toMatchObject({ state: "update" });
      await writeFile(join(f.project, ".agents/skills/review/notes.md"), "Local change\n");
      expect(await readState()).toMatchObject({ state: "conflict" });
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "keeps unsafe trees and capped descriptions explicit without changing project files",
    async () => {
      const f = await fixture();
      const body = `---\nname: review\ndescription: ${"x".repeat(300)}\n---\nBody\n`;
      await writeFile(join(f.project, ".agents/skills/review/SKILL.md"), body);
      const result = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      expect(
        result.units.find(
          (unit) =>
            result.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId &&
            unit.name === "review",
        )?.description,
      ).toHaveLength(160);
      expect(result.limits!.some((limit) => limit.reason === "description-capped-at-160")).toBe(true);
      await symlink("notes.md", join(f.project, ".agents/skills/review/unsafe.md"));
      const unsafe = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      expect(
        unsafe.units.find(
          (unit) =>
            unsafe.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId &&
            unit.name === "review",
        )?.hash,
      ).toBeUndefined();
      expect(unsafe.limits!.some((limit) => limit.reason === "unsafe-tree")).toBe(true);
      expect(await readFile(join(f.project, ".agents/skills/review/SKILL.md"), "utf8")).toBe(body);
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "reaches all 111 skills in at most two bounded pages with whole-scope identity on page one",
    async () => {
      const f = await fixture(true);
      const pages: AgentSkillInventoryResponse[] = [];
      let cursor: string | undefined;
      do {
        const page = (await f.router.handle(
          "skill_inventory",
          cursor ? { cursor } : {},
          client,
        )) as AgentSkillInventoryResponse;
        expect(JSON.stringify(page).length).toBeLessThan(20_000);
        pages.push(page);
        cursor = page.nextCursor;
        expect(pages.length).toBeLessThanOrEqual(2);
      } while (cursor);
      const units = pages.flatMap((page) => page.units);
      const first = pages[0]!;
      expect(units).toHaveLength(111);
      expect(new Set(units.map((unit) => unit.id)).size).toBe(111);
      expect(
        units.filter((unit) => first.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId),
      ).toHaveLength(45);
      expect(
        units.filter((unit) => first.scopes!.find((scope) => scope.key === unit.scope)?.kind === "marketplace"),
      ).toHaveLength(66);
      console.info(
        `Owner-shaped inventory page sizes: ${pages.map((page) => JSON.stringify(page).length).join(", ")}; ${units.length} units`,
      );
      expect(first.limits!.some((limit) => "path" in limit && limit.path === "units")).toBe(false);
      expect(first.identity!.byName.some((finding) => finding.name === "review")).toBe(true);
      for (const finding of [...first.identity!.byName, ...first.identity!.sameContentDifferentNames])
        expect(finding.units.every((id) => typeof id === "string" && units.some((unit) => unit.id === id))).toBe(true);
      expect(
        first
          .identity!.byName.flatMap((finding) => finding.units)
          .some((id) => !first.units.some((unit) => unit.id === id)),
      ).toBe(true);
      for (const pair of first.identity!.byName.flatMap((finding) => finding.unlinkedCopies ?? []))
        expect([pair.project, pair.marketplace].every((id) => units.some((unit) => unit.id === id))).toBe(true);
      for (const page of pages.slice(1)) expect(page.identity).toBeUndefined();
      // A cursor reuses the complete immutable observation instead of rescanning roots.
      expect(f.observe.mock.calls.filter(([ref]) => ref.id === f.projectId)).toHaveLength(1);
      const again = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      expect(again.units.map((unit) => unit.id)).toEqual(first.units.map((unit) => unit.id));
    },
    FIXTURE_TIMEOUT_MS,
  );
  it(
    "supports explicit project and marketplace-only scopes and rejects invalid input",
    async () => {
      const f = await fixture();
      const result = (await f.router.handle(
        "skill_inventory",
        { projectIds: [], includeMarketplace: true },
        client,
      )) as AgentSkillInventoryResponse;
      expect(
        result.units.every((unit) => result.scopes!.find((scope) => scope.key === unit.scope)?.kind === "marketplace"),
      ).toBe(true);
      const project = (await f.router.handle(
        "skill_inventory",
        { projectIds: [f.projectId], includeMarketplace: false },
        client,
      )) as AgentSkillInventoryResponse;
      expect(
        project.units.every(
          (unit) => project.scopes!.find((scope) => scope.key === unit.scope)?.projectId === f.projectId,
        ),
      ).toBe(true);
      for (const params of [
        { projectIds: "x" },
        { projectIds: ["../x"] },
        { includeMarketplace: "yes" },
        { cursor: 2 },
        { cursor: "missing" },
        { bad: true },
      ])
        await expect(f.router.handle("skill_inventory", params, client)).rejects.toThrow();
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "keeps other roots readable when fresh access to one observed project fails",
    async () => {
      const f = await fixture();
      vi.spyOn(f.registry, "getGrantForEntry").mockRejectedValueOnce(new Error("Access changed"));
      const result = (await f.router.handle("skill_inventory", {}, client)) as AgentSkillInventoryResponse;
      expect(result.status).toBe("partial");
      expect(
        result.units.some((unit) => result.scopes!.find((scope) => scope.key === unit.scope)?.kind === "marketplace"),
      ).toBe(true);
      expect(result.unavailable).toContainEqual(expect.objectContaining({ projectId: f.projectId }));
    },
    FIXTURE_TIMEOUT_MS,
  );
});
