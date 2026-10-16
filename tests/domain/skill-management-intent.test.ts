import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fingerprintSkillEffects,
  normalizeSkillIntent,
  type SkillEffectFingerprint,
} from "../../src/domain/skill-management-intent";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("skill management effect identity", () => {
  it("fingerprints decoded binary source bytes rather than their base64 spelling", () => {
    const intent = {
      kind: "write" as const,
      request: {
        kind: "write-skill" as const,
        sourceId: "source-a",
        packageId: "packages/tools",
        mode: "update" as const,
        folderName: "tool",
        files: [{ path: "assets/icon.bin", content: "AP8=", encoding: "base64" as const }],
      },
    };
    const effects: SkillEffectFingerprint = {
      scope: { sourceId: "source-a", targets: [] },
      files: [],
      bindings: [],
    };

    const fingerprint = fingerprintSkillEffects(intent, effects);
    expect(fingerprint).toBe(fingerprintSkillEffects({ ...intent }, effects));
    expect(fingerprint).not.toBe(
      fingerprintSkillEffects(
        {
          ...intent,
          request: { ...intent.request, files: [{ path: "assets/icon.bin", content: "AP4=", encoding: "base64" }] },
        },
        effects,
      ),
    );
  });

  it("normalizes targets while keeping equal-length content changes distinct", () => {
    const request = {
      kind: "write" as const,
      request: {
        kind: "write-skill" as const,
        sourceId: "personal-source",
        packageId: "packages/tools",
        mode: "update" as const,
        folderName: "release-notes",
        files: [{ path: "SKILL.md", content: "# A\n" }],
      },
    };
    const targets = [
      { projectId: "project-b", harnessId: "codex" as const, relativePath: ".agents/skills/release-notes" },
      { projectId: "project-a", harnessId: "claude-code" as const, relativePath: ".claude/skills/release-notes" },
    ];
    const left = normalizeSkillIntent(request);
    const same = normalizeSkillIntent({ ...request });
    const base: SkillEffectFingerprint = {
      scope: { sourceId: "personal-source", packageId: "packages/tools", targets },
      files: [
        {
          rootId: "source:personal-source",
          relativePath: "skills/release-notes/SKILL.md",
          change: "change",
          beforeHash: hash("# Old\n"),
          afterHash: hash("# A\n"),
        },
      ],
      bindings: [],
    };
    const reordered: SkillEffectFingerprint = {
      ...base,
      scope: { ...base.scope, targets: [...targets].reverse() },
      files: [...base.files].reverse(),
    };
    const changed: SkillEffectFingerprint = {
      ...base,
      files: [{ ...base.files[0]!, afterHash: hash("# B\n") }],
    };

    expect(left).toEqual(same);
    expect(fingerprintSkillEffects(left, base)).toBe(fingerprintSkillEffects(same, reordered));
    expect(fingerprintSkillEffects(left, base)).not.toBe(fingerprintSkillEffects(same, changed));
    expect("# A\n".length).toBe("# B\n".length);
  });

  it("includes exact binding metadata and explicit deletions in the fingerprint", () => {
    const intent = normalizeSkillIntent({ kind: "remove", bindingIds: ["binding-a"] });
    const base: SkillEffectFingerprint = {
      scope: { targets: [{ projectId: "project-a", harnessId: "codex", bindingId: "binding-a" }] },
      files: [
        {
          rootId: "project:project-a",
          relativePath: ".agents/skills/tool/old.md",
          change: "delete",
          beforeHash: hash("old"),
        },
      ],
      bindings: [
        {
          bindingId: "binding-a",
          before: {
            bindingId: "binding-a",
            sourceId: "source-a",
            packageId: "packages/tools",
            artifactPath: "skills/tool/SKILL.md",
            kind: "skill",
            projectId: "project-a",
            harnessId: "codex",
            boundHash: hash("current"),
            createdAt: "2026-10-07T10:00:00.000Z",
          },
        },
      ],
    };
    const changedMetadata: SkillEffectFingerprint = {
      ...base,
      bindings: [{ bindingId: "binding-a", before: { ...base.bindings[0]!.before!, packageId: "packages/other" } }],
    };

    expect(fingerprintSkillEffects(intent, base)).not.toBe(fingerprintSkillEffects(intent, changedMetadata));
    expect(fingerprintSkillEffects(intent, base)).not.toBe(
      fingerprintSkillEffects(intent, { ...base, files: [{ ...base.files[0]!, change: "change" }] }),
    );
  });

  it("includes manifest and directory actions even when no file bytes change", () => {
    const intent = normalizeSkillIntent({
      kind: "write",
      request: {
        kind: "write-skill",
        sourceId: "source-a",
        packageId: "packages/tools",
        mode: "create",
        folderName: "release-notes",
        files: [{ path: "SKILL.md", content: "# Notes\n" }],
      },
    });
    const base: SkillEffectFingerprint = {
      scope: { sourceId: "source-a", packageId: "packages/tools", targets: [] },
      files: [],
      bindings: [],
      actions: [
        {
          rootId: "source-a",
          kind: "write-file",
          relativePath: "packages/tools/omni.plugin.json",
          afterHash: hash("manifest"),
        },
        { rootId: "source-a", kind: "create-directory", relativePath: "packages/tools/skills/release-notes" },
      ],
    };

    expect(fingerprintSkillEffects(intent, base)).not.toBe(
      fingerprintSkillEffects(intent, {
        ...base,
        actions: base.actions!.map((action) =>
          action.relativePath.endsWith("omni.plugin.json") ? { ...action, afterHash: hash("other") } : action,
        ),
      }),
    );
  });

  it("rejects duplicate and unsupported explicit selections at the boundary", () => {
    expect(() => normalizeSkillIntent({ kind: "remove", bindingIds: ["binding-a", "binding-a"] })).toThrow();
    expect(() =>
      normalizeSkillIntent({
        kind: "assign",
        sourceId: "source-a",
        packageId: "packages/tools",
        targets: [{ projectId: "project-a", harnessIds: ["unsupported"] }],
      }),
    ).toThrow();
  });

  it("fingerprints ordered adoption evidence, scoped uses, roots, and immutable base refs", () => {
    const intent = normalizeSkillIntent({
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
        source: { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" },
        locations: [
          { projectId: "project-one", harnessId: "claude-code", folderPath: ".claude/skills/demo" },
          { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
        ],
      },
    });
    const base: SkillEffectFingerprint = {
      scope: {
        sourceId: "personal-source",
        packageId: "owned-package",
        artifactPath: "skills/demo",
        targets: [
          { projectId: "project-one", harnessId: "codex", bindingId: "binding-codex" },
          { projectId: "project-one", harnessId: "claude-code", bindingId: "binding-claude" },
        ],
      },
      files: [],
      bindings: [],
      metadataEffects: [
        {
          skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
          location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
          after: {
            skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
            bindingId: "binding-codex",
            location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
            source: { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" },
            baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
          },
        },
      ],
      baseReferences: [
        {
          baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
          revision: { algorithm: "omni-tree-v1", hash: hash("tree"), files: [] },
        },
      ],
      adoptionEvidence: {
        storeRevision: 2,
        source: {
          ref: { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" },
          rootIdentity: hash("source root"),
          revision: { algorithm: "omni-tree-v1", hash: hash("tree"), files: [] },
        },
        locals: [
          {
            location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
            rootIdentity: hash("project root"),
            revision: { algorithm: "omni-tree-v1", hash: hash("tree"), files: [] },
          },
        ],
      },
    };
    const evidence = base.adoptionEvidence!;
    const metadataEffects = base.metadataEffects ?? [];
    const same = {
      ...base,
      scope: { ...base.scope, targets: [...base.scope.targets].reverse() },
      metadataEffects: [...metadataEffects].reverse(),
      adoptionEvidence: { ...evidence, locals: [...evidence.locals].reverse() },
    };
    const refs = base.baseReferences!;
    expect(fingerprintSkillEffects(intent, base)).toBe(fingerprintSkillEffects(intent, same));
    expect(fingerprintSkillEffects(intent, base)).not.toBe(
      fingerprintSkillEffects(intent, {
        ...base,
        baseReferences: [{ ...refs[0]!, baseRevisionId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18" }],
      }),
    );
    expect(fingerprintSkillEffects(intent, base)).not.toBe(
      fingerprintSkillEffects(intent, {
        ...base,
        adoptionEvidence: { ...evidence, source: { ...evidence.source, rootIdentity: hash("other root") } },
      }),
    );
  });

  it("fingerprints every verified managed resolution input while keeping old effects stable", () => {
    const intent = normalizeSkillIntent({
      kind: "reconcile",
      request: {
        choice: "use-canonical",
        skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
        locations: [{ projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" }],
      },
    });
    const location = { projectId: "project-one", harnessId: "codex" as const, folderPath: ".agents/skills/demo" };
    const source = { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" };
    const revision = {
      algorithm: "omni-tree-v1" as const,
      hash: hash("tree"),
      files: [{ path: "SKILL.md", hash: hash("file"), byteLength: 4 }],
    };
    const evidence = {
      choice: "use-canonical" as const,
      skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
      storeRevision: 2,
      source,
      sourceTree: { rootIdentity: hash("source-root"), revision },
      local: { location, rootIdentity: hash("project-root"), revision },
      use: {
        skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
        bindingId: "binding-codex",
        location,
        source,
        baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
      },
      binding: {
        bindingId: "binding-codex",
        sourceId: source.sourceId,
        packageId: source.packageId,
        artifactPath: "skills/demo/SKILL.md",
        kind: "skill" as const,
        projectId: location.projectId,
        harnessId: location.harnessId,
        boundHash: revision.hash,
        ownedHash: revision.hash,
        createdAt: "2026-10-09T00:00:00.000Z",
      },
      base: { baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa", revision },
    };
    const base: SkillEffectFingerprint = {
      scope: {
        sourceId: source.sourceId,
        packageId: source.packageId,
        artifactPath: source.artifactPath,
        targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: "binding-codex" }],
      },
      files: [],
      bindings: [],
      metadataEffects: [],
      baseReferences: [{ baseRevisionId: evidence.base.baseRevisionId, revision }],
      resolutionEvidence: evidence,
    };
    const changed = [
      { ...evidence, sourceTree: { ...evidence.sourceTree, rootIdentity: hash("other-source-root") } },
      { ...evidence, local: { ...evidence.local, rootIdentity: hash("other-project-root") } },
      { ...evidence, base: { ...evidence.base, baseRevisionId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18" } },
      { ...evidence, use: { ...evidence.use, bindingId: "binding-other" } },
      { ...evidence, binding: { ...evidence.binding, createdAt: "2026-10-08T00:00:00.000Z" } },
    ];
    const fingerprint = fingerprintSkillEffects(intent, base);
    for (const resolutionEvidence of changed) {
      expect(fingerprintSkillEffects(intent, { ...base, resolutionEvidence })).not.toBe(fingerprint);
    }
    expect(fingerprintSkillEffects(intent, base)).toBe(fingerprint);
  });
});
