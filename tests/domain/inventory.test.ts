import { describe, expect, it } from "vitest";

import {
  createGitScope,
  createInventoryDiagnostic,
  createInventorySnapshot,
  createObservedArtifact,
  createProviderStateEvidence,
  stableInventoryId,
} from "../../src/domain/inventory";

const providerState = {
  packageState: "unknown",
  activationState: "unknown",
  authenticationPolicy: "unknown",
  authenticationState: "unknown",
  revision: "observed-revision",
} as const;

const artifactInput = {
  kind: "skill",
  relativePath: "project/.cursor/skills/review/SKILL.md",
  displayPath: "project/.cursor/skills/review/SKILL.md",
  providerIds: ["cursor"],
  scope: "project",
  confidence: "exact",
  symlinkState: "none",
  providerState,
} as const;

function createArtifact(overrides: Record<string, unknown> = {}) {
  return createObservedArtifact({ ...artifactInput, ...overrides });
}

describe("inventory domain records", () => {
  it("derives the same stable id for the same observed identity", () => {
    const first = createArtifact({ displayPath: "project/redacted/SKILL.md" });
    const second = createArtifact({ displayPath: "project/other-redaction/SKILL.md" });

    expect(first.id).toBe(second.id);
    expect(
      stableInventoryId({
        scope: "project",
        kind: "skill",
        relativePath: artifactInput.relativePath,
        providerIds: ["cursor"],
      }),
    ).toBe(first.id);
  });

  it("keeps inventory artifacts separate from package records and file contents", () => {
    const artifact = createArtifact();

    expect(artifact).not.toHaveProperty("content");
    expect(artifact).not.toHaveProperty("artifacts");
    expect(artifact).toMatchObject({
      kind: "skill",
      relativePath: artifactInput.relativePath,
      scope: "project",
    });
  });

  it.each([
    ["scope", "scope", "workspace"],
    ["confidence", "confidence", "certain"],
    ["artifact kind", "kind", "package"],
    ["symlink state", "symlinkState", "linked"],
  ])("rejects an invalid %s", (_label, field, value) => {
    expect(() => createArtifact({ [field]: value })).toThrow();
  });

  it("rejects unsafe artifact ids and paths", () => {
    expect(() => createObservedArtifact({ ...artifactInput, id: "/tmp/secret" })).toThrow();
    expect(() => createArtifact({ relativePath: "../outside/SKILL.md" })).toThrow();
    expect(() => createArtifact({ relativePath: "C:/outside/SKILL.md" })).toThrow();
  });

  it("rejects absolute display paths and diagnostic locations", () => {
    expect(() => createArtifact({ displayPath: "/Users/example/project/SKILL.md" })).toThrow();
    expect(() =>
      createInventoryDiagnostic({
        location: "/Users/example/project/.cursor",
        code: "unreadable",
        severity: "warning",
        message: "Location could not be inspected.",
      }),
    ).toThrow();
  });

  it.each([
    "inaccessible",
    "malformed",
    "oversized",
    "broken-link",
    "outside-root",
    "unsupported",
    "duplicate-projection",
    "git-unavailable",
  ])("accepts diagnostic code %s", (code) => {
    expect(
      createInventoryDiagnostic({
        location: "project/.cursor",
        code,
        severity: "warning",
        message: "Observed diagnostic.",
      }).code,
    ).toBe(code);
  });

  it("rejects an unknown diagnostic code", () => {
    expect(() =>
      createInventoryDiagnostic({
        location: "project/.cursor",
        code: "not-in-the-contract",
        severity: "warning",
        message: "Unknown diagnostic.",
      }),
    ).toThrow();
  });

  it("validates provider states and preserves unknown conclusions", () => {
    expect(createProviderStateEvidence(providerState)).toEqual(providerState);
    expect(createArtifact().providerState).toEqual(providerState);

    expect(() =>
      createProviderStateEvidence({
        ...providerState,
        packageState: "installed",
      }),
    ).toThrow();
    expect(() =>
      createProviderStateEvidence({
        ...providerState,
        authenticationState: "verified",
      }),
    ).toThrow();
  });

  it.each([
    [
      "diagnostic severity",
      () =>
        createInventoryDiagnostic({
          location: "project/.cursor",
          code: "scan",
          severity: "fatal",
          message: "Invalid severity.",
        }),
    ],
    [
      "git dirty state",
      () =>
        createGitScope({
          id: "repo",
          relativeRoot: "project",
          dirty: "yes",
        }),
    ],
  ])("rejects an invalid %s", (_label, createRecord) => {
    expect(createRecord).toThrow();
  });

  it("rejects malformed nested records and duplicate artifact ids", () => {
    const artifact = createArtifact();
    const validInput = {
      rootHandle: "workspace-handle",
      displayRoot: "project",
      observedAt: "2026-09-08T10:00:00.000Z",
      harnesses: ["codex"],
      artifacts: [artifact, artifact],
      diagnostics: [],
      gitScopes: [],
    };

    expect(() => createInventorySnapshot(validInput)).toThrow();
    expect(() =>
      createInventorySnapshot({
        ...validInput,
        artifacts: [{ ...artifact, relativePath: "../outside" }],
      }),
    ).toThrow();
  });

  it("normalizes absent origins and rejects evidence outside exact skill projection paths", () => {
    const observed = createArtifact({
      id: "skill-1",
      relativePath: ".agents/skills/review/SKILL.md",
      displayPath: ".agents/skills/review/SKILL.md",
      projectionPaths: [".agents/skills/review/SKILL.md"],
      physicalIdentity: "project/.agents/skills/review/SKILL.md",
    });
    const snapshot = createInventorySnapshot({
      rootHandle: "workspace-handle",
      displayRoot: "project",
      observedAt: "2026-09-08T10:00:00.000Z",
      harnesses: ["codex"],
      artifacts: [observed],
      diagnostics: [],
      gitScopes: [],
    });
    const origin = {
      artifactId: "skill-1",
      relativePath: ".agents/skills/review/SKILL.md",
      source: { kind: "github", locator: "owner/tools" },
      lockPath: "skills-lock.json",
      recordedHash: "a".repeat(64),
      verification: "unverified",
      verificationReason: "unavailable",
    };

    expect(snapshot.skillOrigins).toEqual([]);
    expect(
      createInventorySnapshot({
        ...snapshot,
        skillOrigins: [origin],
      }).skillOrigins,
    ).toHaveLength(1);
    expect(() =>
      createInventorySnapshot({
        ...snapshot,
        skillOrigins: [{ ...origin, relativePath: ".claude/skills/other/SKILL.md" }],
      }),
    ).toThrow("Skill origin evidence must point to an observed skill location.");
  });

  it("rejects duplicate stable identities even when caller ids differ", () => {
    const first = createArtifact({ id: "caller-id-a" });
    const second = createArtifact({ id: "caller-id-b" });

    expect(first.id).not.toBe(second.id);
    expect(() =>
      createInventorySnapshot({
        rootHandle: "workspace-handle",
        displayRoot: "project",
        observedAt: "2026-09-08T10:00:00.000Z",
        harnesses: ["codex"],
        artifacts: [first, second],
        diagnostics: [],
        gitScopes: [],
      }),
    ).toThrow("Inventory artifact identities must be unique.");
  });

  it.each(["/absolute/provider", "../provider", "provider/../other", "C:/provider", "provider\\..\\other", ".", ".."])(
    "rejects unsafe provider id %s",
    (providerId) => {
      expect(() => createArtifact({ providerIds: [providerId] })).toThrow();
    },
  );

  it.each(["/absolute/harness", "../harness", "harness/../other", "C:/harness", "harness\\..\\other", ".", ".."])(
    "rejects unsafe harness alias %s",
    (harness) => {
      expect(() =>
        createInventorySnapshot({
          rootHandle: "workspace-handle",
          displayRoot: "project",
          observedAt: "2026-09-08T10:00:00.000Z",
          harnesses: [harness],
          artifacts: [createArtifact()],
          diagnostics: [],
          gitScopes: [],
        }),
      ).toThrow();
    },
  );

  it("trims valid provider ids and harness aliases", () => {
    const snapshot = createInventorySnapshot({
      rootHandle: "workspace-handle",
      displayRoot: "project",
      observedAt: "2026-09-08T10:00:00.000Z",
      harnesses: [" codex ", "claude"],
      artifacts: [createArtifact({ providerIds: [" cursor ", "community-marketplace"] })],
      diagnostics: [],
      gitScopes: [],
    });

    expect(snapshot.harnesses).toEqual(["codex", "claude"]);
    expect(snapshot.artifacts[0].providerIds).toEqual(["cursor", "community-marketplace"]);
  });

  it("preserves opaque namespaced provider ids without path rewriting", () => {
    const artifact = createArtifact({
      providerIds: ["@scope/provider", "provider:variant", "vendor\\provider"],
    });

    expect(artifact.providerIds).toEqual(["@scope/provider", "provider:variant", "vendor\\provider"]);
  });

  it("defaults physical identity and projection paths for ordinary files", () => {
    const artifact = createArtifact();

    expect(artifact.physicalIdentity).toBe(artifactInput.relativePath);
    expect(artifact.projectionPaths).toEqual([artifactInput.relativePath]);
  });

  it("uses physical identity for multiple symlink projections", () => {
    const firstProjection = createArtifact({
      relativePath: "project/.cursor/skills/review/SKILL.md",
      displayPath: "project/.cursor/skills/review/SKILL.md",
      physicalIdentity: "source/skills/review/SKILL.md",
      projectionPaths: ["project/.cursor/skills/review/SKILL.md"],
      symlinkState: "inside-root",
    });
    const secondProjection = createArtifact({
      relativePath: "project/.claude/skills/review/SKILL.md",
      displayPath: "project/.claude/skills/review/SKILL.md",
      physicalIdentity: "source/skills/review/SKILL.md",
      projectionPaths: ["project/.claude/skills/review/SKILL.md"],
      symlinkState: "inside-root",
    });
    const combined = createArtifact({
      physicalIdentity: "source/skills/review/SKILL.md",
      projectionPaths: ["project/.cursor/skills/review/SKILL.md", "project/.claude/skills/review/SKILL.md"],
      symlinkState: "inside-root",
    });

    expect(firstProjection.id).toBe(secondProjection.id);
    expect(combined.projectionPaths).toEqual([
      "project/.cursor/skills/review/SKILL.md",
      "project/.claude/skills/review/SKILL.md",
    ]);
  });

  it("rejects unsafe physical identities and projection paths", () => {
    expect(() => createArtifact({ physicalIdentity: "../outside/SKILL.md" })).toThrow();
    expect(() => createArtifact({ projectionPaths: ["/absolute/SKILL.md"] })).toThrow();
  });

  it("rejects conflicting duplicate physical identities in one snapshot", () => {
    const first = createArtifact({
      relativePath: "project/skill.md",
      displayPath: "project/skill.md",
      physicalIdentity: "source/shared.md",
    });
    const conflict = createArtifact({
      kind: "rule",
      relativePath: "project/rule.md",
      displayPath: "project/rule.md",
      physicalIdentity: "source/shared.md",
    });

    expect(first.id).not.toBe(conflict.id);
    expect(() =>
      createInventorySnapshot({
        rootHandle: "workspace-handle",
        displayRoot: "project",
        observedAt: "2026-09-08T10:00:00.000Z",
        harnesses: ["codex"],
        artifacts: [first, conflict],
        diagnostics: [],
        gitScopes: [],
      }),
    ).toThrow("Inventory physical identities must be unique.");
  });

  it("accepts partial diagnostics and multiple git scopes in a valid snapshot", () => {
    const projectArtifact = createArtifact();
    const userArtifact = createArtifact({
      scope: "user",
      relativePath: "user/.config/agent/rules.md",
      displayPath: "user/.config/agent/rules.md",
      confidence: "heuristic",
      providerIds: [],
      providerState: undefined,
    });
    const snapshot = createInventorySnapshot({
      rootHandle: "workspace-handle",
      displayRoot: "project",
      observedAt: "2026-09-08T10:00:00.000Z",
      harnesses: ["codex", "claude"],
      artifacts: [projectArtifact, userArtifact],
      diagnostics: [
        createInventoryDiagnostic({
          location: "user/.config/agent",
          code: "inaccessible",
          severity: "warning",
          message: "A location could not be inspected.",
        }),
      ],
      gitScopes: [
        createGitScope({ id: "project-repo", relativeRoot: "project", dirty: false }),
        createGitScope({
          id: "nested-repo",
          relativeRoot: "project/packages/tool",
          head: "abc123",
          dirty: "unknown",
        }),
      ],
    });

    expect(snapshot.artifacts).toHaveLength(2);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.gitScopes).toHaveLength(2);
    expect(snapshot.artifacts[1].providerState).toBeUndefined();
  });
});
