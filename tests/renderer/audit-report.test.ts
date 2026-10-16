import { describe, expect, it, vi } from "vitest";

import type { Observation, RegistryEntryView, RegistryView } from "../../src/domain/project-source-registry";
import { composeAuditReport, selectAuditEntries } from "../../src/renderer/audit/audit-report";
import { runReadOnlyAudit, type AuditProgress } from "../../src/renderer/audit/use-audit-session";
import type { DesktopApi } from "../../src/shared/ipc";
import type { ArtifactIdentity } from "../../src/domain/identity";

const projectA = {
  ref: { kind: "project" as const, id: "project-a" },
  displayName: "Project A",
  displayRoot: "project-a",
  availability: "available" as const,
};
const projectZ = {
  ref: { kind: "project" as const, id: "project-z" },
  displayName: "Project Z",
  displayRoot: "project-z",
  availability: "available" as const,
};
const sourceA = {
  ref: { kind: "source" as const, id: "source-a" },
  displayName: "Source A",
  displayRoot: "source-a",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};

const registry: RegistryView = {
  revision: 4,
  projects: [projectZ, projectA],
  sources: [sourceA],
};

function observation(
  subject: Observation["subject"],
  diagnostics: Observation["inventory"]["diagnostics"] = [],
): Observation {
  return {
    subject,
    observedAt: "2026-09-11T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-11T10:00:00.000Z",
      harnesses: [],
      artifacts: [],
      diagnostics,
      gitScopes: [],
    },
  };
}

function apiFor(handlers: Partial<DesktopApi> = {}): Parameters<typeof runReadOnlyAudit>[0]["api"] {
  return {
    listRegistry: vi.fn(),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockImplementation(async (entry) => ({
      status: "granted" as const,
      entry: entry.kind === "project" ? projectA : sourceA,
      grantHandle: `${entry.kind}-grant`,
    })),
    observeProject: vi.fn().mockResolvedValue({ status: "observed", observation: observation(projectA.ref) }),
    observeSource: vi.fn().mockResolvedValue({ status: "observed", observation: observation(sourceA.ref) }),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
    ...handlers,
  } as DesktopApi;
}

describe("read-only audit composition", () => {
  it("hashes each successful observation and stores identities and skipped artifacts", async () => {
    const artifact = {
      id: "artifact-a",
      physicalIdentity: "skills/review/SKILL.md",
      projectionPaths: ["skills/review/SKILL.md"],
      kind: "skill" as const,
      relativePath: "skills/review/SKILL.md",
      displayPath: "skills/review/SKILL.md",
      providerIds: [],
      scope: "source" as const,
      confidence: "exact" as const,
      symlinkState: "none" as const,
    };
    const identity: ArtifactIdentity = {
      artifactId: artifact.id,
      logicalId: "loose:skills/review",
      contentHash: "a".repeat(64),
      byteLength: 20,
      executionClass: "static",
      kind: "skill",
      provenance: { root: sourceA.ref, relativePath: artifact.relativePath },
    };
    const hashArtifacts = vi.fn().mockResolvedValue({
      status: "hashed" as const,
      subject: sourceA.ref,
      identities: [identity],
      skipped: [{ artifactId: "missing", reason: "unavailable" as const }],
    });
    const observed = observation(sourceA.ref);
    const observeSource = vi.fn().mockResolvedValue({
      status: "observed" as const,
      observation: { ...observed, inventory: { ...observed.inventory, artifacts: [artifact] } },
    });
    const result = await runReadOnlyAudit({
      api: apiFor({ observeSource, hashArtifacts }),
      registry: { status: "ready", registry: { ...registry, projects: [], sources: [sourceA] } },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(hashArtifacts).toHaveBeenCalledWith({
      kind: "source",
      id: sourceA.ref.id,
      grantHandle: "source-grant",
      artifacts: [{ artifactId: artifact.id, relativePath: artifact.relativePath, kind: artifact.kind }],
    });
    expect(result.report.observations[0]).toMatchObject({
      identities: [identity],
      skipped: [{ artifactId: "missing", reason: "unavailable" }],
    });
  });

  it("appends identity findings from hashed observation entries", () => {
    const artifact = {
      id: "loose-a",
      physicalIdentity: "AGENTS.md",
      projectionPaths: ["AGENTS.md"],
      kind: "instruction" as const,
      relativePath: "AGENTS.md",
      displayPath: "AGENTS.md",
      providerIds: [],
      scope: "source" as const,
      confidence: "exact" as const,
      symlinkState: "none" as const,
    };
    const identity: ArtifactIdentity = {
      artifactId: artifact.id,
      logicalId: "loose:AGENTS.md",
      contentHash: "b".repeat(64),
      byteLength: 8,
      executionClass: "static",
      kind: "instruction",
      provenance: { root: sourceA.ref, relativePath: artifact.relativePath },
    };

    const report = composeAuditReport({
      observations: [
        {
          ...observation(sourceA.ref),
          inventory: { ...observation(sourceA.ref).inventory, artifacts: [artifact] },
          identities: [identity],
          skipped: [],
        },
      ],
      findings: [],
      unavailable: [],
      registry,
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ entry: sourceA.ref, kind: "loose", severity: "info", examples: ["AGENTS"] }),
    );
    expect(report.findings.find((finding) => finding.kind === "loose")?.message).toContain("Source A");
  });

  it("selects active entries in deterministic kind and id order", () => {
    const archived = { ...projectA, archivedAt: "2026-09-10T10:00:00.000Z" };
    const selected = selectAuditEntries({
      ...registry,
      projects: [archived, projectZ, projectA],
      sources: [{ ...sourceA, ref: { kind: "source", id: "source-z" } }, sourceA],
    });

    expect(selected.map(({ ref }) => `${ref.kind}:${ref.id}`)).toEqual([
      "project:project-a",
      "project:project-z",
      "source:source-a",
      "source:source-z",
    ]);
  });

  it("preserves successful roots when another root is unavailable", async () => {
    const openEntry = vi
      .fn()
      .mockImplementation(async (entry) =>
        entry.id === "project-a"
          ? { status: "missing" as const, entry: projectA, diagnostic: "The project root is missing." }
          : { status: "granted" as const, entry: sourceA, grantHandle: "source-grant" },
      );
    const observeSource = vi.fn().mockResolvedValue({
      status: "observed" as const,
      observation: observation(sourceA.ref),
    });
    const result = await runReadOnlyAudit({
      api: apiFor({ openEntry, observeSource }),
      registry: { status: "ready", registry: { ...registry, projects: [projectA], sources: [sourceA] } },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.report.observations.map(({ subject }) => subject)).toEqual([sourceA.ref]);
    expect(result.report.unavailable).toEqual([projectA.ref]);
    expect(result.report.findings).toContainEqual({
      entry: projectA.ref,
      kind: "availability",
      severity: "warning",
      message: "The project root is missing.",
    });
    expect(observeSource).toHaveBeenCalledWith({ sourceId: "source-a", grantHandle: "source-grant" });
  });

  it("stops before opening any entry when the registry is corrupt", async () => {
    const openEntry = vi.fn();
    const result = await runReadOnlyAudit({
      api: apiFor({ openEntry }),
      registry: { status: "corrupt", diagnostic: "The registry is corrupt.", recoveryAvailable: true },
    });

    expect(result).toEqual({ status: "corrupt", diagnostic: "The registry is corrupt." });
    expect(openEntry).not.toHaveBeenCalled();
  });

  it("copies inventory diagnostics without inferring a stronger conclusion", () => {
    const report = composeAuditReport({
      observations: [
        observation(projectA.ref, [
          {
            location: "skills/review/SKILL.md",
            code: "malformed",
            severity: "warning",
            message: "The documented metadata is malformed.",
          },
        ]),
      ],
      findings: [],
      unavailable: [],
      registry,
    });

    expect(report.findings).toEqual([
      {
        entry: projectA.ref,
        kind: "diagnostic",
        severity: "warning",
        message: "The documented metadata is malformed.",
      },
    ]);
    expect(report.findings[0]?.message).not.toContain("duplicate");
  });

  it("calls openEntry before the matching observation method and reports progress", async () => {
    const calls: string[] = [];
    const progress: AuditProgress[] = [];
    const observeProject = vi.fn().mockImplementation(async (request) => {
      calls.push(`observe:project:${request.projectId}:${request.grantHandle}`);
      return { status: "observed" as const, observation: observation({ kind: "project", id: request.projectId }) };
    });
    const observeSource = vi.fn().mockImplementation(async (request) => {
      calls.push(`observe:source:${request.sourceId}:${request.grantHandle}`);
      return { status: "observed" as const, observation: observation(sourceA.ref) };
    });
    const entryViews = new Map<string, RegistryEntryView>([
      [projectA.ref.id, projectA],
      [projectZ.ref.id, projectZ],
      [sourceA.ref.id, sourceA],
    ]);
    const openEntry = vi.fn().mockImplementation(async (entry) => {
      calls.push(`open:${entry.kind}:${entry.id}`);
      return { status: "granted" as const, entry: entryViews.get(entry.id), grantHandle: `${entry.id}-grant` };
    });

    const result = await runReadOnlyAudit({
      api: apiFor({ openEntry, observeProject, observeSource }),
      registry: { status: "ready", registry },
      onProgress: (next) => progress.push(next),
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "open:project:project-a",
      "observe:project:project-a:project-a-grant",
      "open:project:project-z",
      "observe:project:project-z:project-z-grant",
      "open:source:source-a",
      "observe:source:source-a:source-a-grant",
    ]);
    expect(progress).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it("suppresses the stale run after cancellation", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const run = runReadOnlyAudit({
      api: apiFor({
        openEntry: vi.fn().mockImplementation(async () => {
          await pending;
          return { status: "granted" as const, entry: projectA, grantHandle: "project-grant" };
        }),
      }),
      registry: { status: "ready", registry: { ...registry, projects: [projectA], sources: [] } },
      onProgress,
      signal: controller.signal,
    });

    controller.abort();
    release();

    await expect(run).resolves.toEqual({ status: "cancelled" });
    expect(onProgress).toHaveBeenCalledWith({ completed: 0, total: 1 });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
