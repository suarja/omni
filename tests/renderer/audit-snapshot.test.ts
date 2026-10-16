import { describe, expect, it } from "vitest";

import {
  readCurrentAuditReport,
  registryObservationFingerprint,
  selectedRefsKey,
  type AuditSnapshot,
} from "../../src/renderer/audit/audit-snapshot";
import type { AuditReport } from "../../src/renderer/audit/audit-report";
import type { RegistryView } from "../../src/domain/project-source-registry";

const report: AuditReport = { observations: [], findings: [], unavailable: [] };
const registry: RegistryView = {
  revision: 4,
  projects: [
    {
      ref: { kind: "project", id: "project-one" },
      displayName: "Project",
      displayRoot: "project",
      availability: "available",
    },
  ],
  sources: [
    {
      ref: { kind: "source", id: "source-one" },
      displayName: "Source",
      displayRoot: "source",
      availability: "available",
      ownership: "personal",
      capabilities: { observe: true, write: false },
    },
  ],
};

function snapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    report,
    registryFingerprint: registryObservationFingerprint(registry),
    selectedRefsKey: "all",
    ...overrides,
  };
}

describe("audit snapshot currency", () => {
  it("retains a report after a same-revision registry refresh", () => {
    expect(readCurrentAuditReport(snapshot(), registry)).toBe(report);
  });

  it("invalidates a report after registration changes the registry revision", () => {
    expect(readCurrentAuditReport(snapshot(), { ...registry, revision: 5 })).toBeNull();
  });

  it("invalidates a report after archive or reactivation changes the registry revision", () => {
    expect(readCurrentAuditReport(snapshot(), { ...registry, revision: 5 })).toBeNull();
  });

  it("invalidates a report when the semantic selected scope changes", () => {
    const project = { kind: "project" as const, id: "project-one" };
    const scoped = snapshot({ selectedRefsKey: selectedRefsKey([project]) });
    expect(readCurrentAuditReport(scoped, registry, [project])).toBe(report);
    expect(readCurrentAuditReport(scoped, registry)).toBeNull();
  });

  it("invalidates same-revision reports when availability changes", () => {
    expect(
      readCurrentAuditReport(snapshot(), {
        ...registry,
        projects: [{ ...registry.projects[0], availability: "missing" }],
      }),
    ).toBeNull();
  });

  it("invalidates same-revision reports when source ownership changes", () => {
    expect(
      readCurrentAuditReport(snapshot(), { ...registry, sources: [{ ...registry.sources[0], ownership: "external" }] }),
    ).toBeNull();
  });

  it("invalidates same-revision reports when an entry is archived", () => {
    expect(
      readCurrentAuditReport(snapshot(), {
        ...registry,
        sources: [{ ...registry.sources[0], archivedAt: "2026-09-11T12:00:00.000Z" }],
      }),
    ).toBeNull();
  });
});
