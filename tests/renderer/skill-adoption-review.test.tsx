// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import type { Binding } from "../../src/domain/assignment-plan";
import type { SkillLocationKey, SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import { ChangesDiff } from "../../src/renderer/canvas/changes/ChangesDiff";
import { AdoptionSummary } from "../../src/renderer/canvas/changes/AdoptionSummary";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import { render } from "./skill-copy-comparison-fixtures";

const location: SkillLocationKey = {
  projectId: "project-one",
  harnessId: "codex",
  folderPath: ".agents/skills/review",
};
const revision: SkillRevision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 8 }],
};
const use = {
  skillId: "123e4567-e89b-42d3-a456-426614174000",
  bindingId: "binding-one",
  location,
  source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
  baseRevisionId: "d3477a13-4514-4de2-b9c9-f567fbb7e511",
};
const binding: Binding = {
  bindingId: use.bindingId,
  sourceId: use.source.sourceId,
  packageId: use.source.packageId,
  artifactPath: use.source.artifactPath,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: revision.hash,
  ownedHash: revision.hash,
  createdAt: "2026-10-08T10:00:00.000Z",
};
const preview: SkillPreview = {
  status: "ready",
  intentId: "adoption-intent-one",
  planId: "adoption-plan-one",
  effectFingerprint: "c".repeat(64),
  scope: {
    sourceId: use.source.sourceId,
    packageId: use.source.packageId,
    artifactPath: use.source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: binding.bindingId }],
  },
  steps: [
    {
      stepId: "adoption-step-one",
      scope: {
        sourceId: use.source.sourceId,
        packageId: use.source.packageId,
        artifactPath: use.source.artifactPath,
        targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: binding.bindingId }],
      },
      plan: {
        planId: "adoption-plan-one",
        kind: "adopt-skill",
        displayTarget: location.folderPath,
        actions: [],
        git: { mode: "disabled", warnings: [] },
      },
      bindingEffects: [{ bindingId: binding.bindingId, after: binding }],
      files: [],
      metadataEffects: [{ skillId: use.skillId, location, after: use }],
      baseReferences: [{ baseRevisionId: use.baseRevisionId, revision }],
      adoptionEvidence: {
        storeRevision: 0,
        source: { ref: use.source, rootIdentity: "d".repeat(64), revision },
        locals: [{ location, rootIdentity: "e".repeat(64), revision }],
      },
    },
  ],
};
const result: SkillResult = {
  intentId: preview.intentId,
  operationId: preview.intentId,
  status: "applied",
  source: { status: "unchanged", sourceId: use.source.sourceId },
  targets: [
    {
      projectId: location.projectId,
      harnessId: location.harnessId,
      bindingId: binding.bindingId,
      artifactPath: location.folderPath,
      status: "applied",
    },
  ],
  receiptIds: ["adoption-receipt-one"],
  receipts: [
    {
      operationId: "adoption-receipt-one",
      kind: "adopt-skill",
      status: "applied",
      appliedAt: "2026-10-08T10:00:00.000Z",
      displayTarget: location.folderPath,
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      project: { id: location.projectId },
      adoption: { intentId: preview.intentId, stepId: "adoption-step-one" },
    },
  ],
  issues: [],
  recoveryAvailable: true,
  resolution: {
    skillId: use.skillId,
    choice: "adopt-exact",
    targets: [{ location, bindingId: binding.bindingId, status: "applied" }],
  },
};

test("adoption review explains metadata-only effects and preserves the exact restore path", async () => {
  const onAdoptionChanged = vi.fn(async () => undefined);
  const api = {
    previewSkillOperation: vi.fn(async () => preview),
    refreshSkillOperation: vi.fn(async () => preview),
    applySkillOperation: vi.fn(async () => result),
    readSkillOperationResult: vi.fn(async () => result),
    listSkillOperationRecoveries: vi.fn(async () => []),
  };
  const rendered = render(
    <OperationChangesWorkbench
      api={api}
      artifacts={[]}
      initialJourney="draft"
      initialSkillIntent={{
        kind: "reconcile",
        request: {
          choice: "adopt-exact",
          skillId: use.skillId,
          source: use.source,
          locations: [location],
        },
      }}
      onAdoptionChanged={onAdoptionChanged}
      onBack={() => undefined}
      onClose={() => undefined}
      onSourceChanged={() => undefined}
      packages={[]}
      projects={[{ id: location.projectId, name: "Project One", available: true, harnesses: ["codex"] }]}
      sources={[{ id: "source-one", name: "Personal Skills" }]}
    />,
  );

  try {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("No skill files will be changed.");
    expect(rendered.container.textContent).toContain("Omni will link the selected source skill to the existing copy.");
    expect(rendered.container.textContent).toContain("binding-one");
    expect(rendered.container.textContent).toContain(use.baseRevisionId);
    expect(rendered.container.textContent).toContain(".agents/skills/review");

    const targets = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (tab) => tab.textContent === "Targets",
    );
    await act(async () => targets?.click());
    expect(rendered.container.textContent).toContain("Other copies remain unchanged.");
    expect(rendered.container.textContent).toContain("Project One · codex");

    const confirm = rendered.container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary");
    expect(confirm?.textContent).toBe("Adopt exact skill");
    await act(async () => confirm?.click());
    expect(onAdoptionChanged).toHaveBeenCalledOnce();
    expect(rendered.container.textContent).toContain("adoption-intent-one");
    expect(rendered.container.textContent).toContain("Review restore");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("adoption review keeps technical management identifiers inside closed details", () => {
  if (preview.status !== "ready") throw new Error("Expected an adoption fixture.");
  const rendered = render(
    <AdoptionSummary variant="diff" scope={preview.scope} steps={preview.steps} nameFor={(id) => id} />,
  );
  try {
    const details = rendered.container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(use.bindingId);
    expect(details?.textContent).toContain(use.baseRevisionId);
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("metadata restore describes removing management and retaining the historical snapshot", () => {
  const original = preview.status === "ready" ? preview.steps[0]! : undefined;
  if (!original) throw new Error("Missing adoption fixture.");
  const inverse = {
    ...original,
    bindingEffects: [{ bindingId: binding.bindingId, before: binding }],
    metadataEffects: [{ skillId: use.skillId, location, before: use }],
  };
  const rendered = render(
    <AdoptionSummary variant="diff" scope={inverse.scope} steps={[inverse]} nameFor={(id) => id} />,
  );
  try {
    expect(rendered.container.textContent).toContain("Omni will remove the managed use for this copy.");
    expect(rendered.container.textContent).toContain("Omni will remove this assignment binding.");
    expect(rendered.container.textContent).toContain("Retained history snapshot");
    expect(rendered.container.textContent).not.toContain("Omni will link the selected source");
    expect(rendered.container.textContent).not.toContain("Omni will refresh the existing managed use");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("withheld adoption explains its reason once and retains distinct recovery details", async () => {
  const reason = "Every selected copy must match the complete source tree, including support files.";
  const detail = "Refresh the source and selected copy before reviewing again.";
  const withheld: SkillPreview = {
    status: "needs-input",
    intentId: "withheld-adoption",
    reason,
    details: [
      { code: "unequal-copy", message: reason, recoveryAction: "refresh" },
      { code: "refresh-evidence", message: detail, recoveryAction: "refresh" },
    ],
  };
  const api = {
    previewSkillOperation: vi.fn(async () => withheld),
    refreshSkillOperation: vi.fn(async () => withheld),
    applySkillOperation: vi.fn(async () => result),
    readSkillOperationResult: vi.fn(async () => result),
  };
  const rendered = render(
    <OperationChangesWorkbench
      api={api}
      artifacts={[]}
      initialJourney="draft"
      initialSkillIntent={{
        kind: "reconcile",
        request: {
          choice: "adopt-exact",
          skillId: use.skillId,
          source: use.source,
          locations: [location],
        },
      }}
      onClose={() => undefined}
      onSourceChanged={() => undefined}
      packages={[]}
      projects={[]}
      sources={[]}
    />,
  );
  try {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(rendered.container.textContent?.split(reason).length).toBe(2);
    expect(rendered.container.textContent).toContain(detail);
    expect(rendered.container.querySelector<HTMLButtonElement>(".changes-primary")?.disabled).toBe(true);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("interrupted adoption review shows the binding inverse before a managed use was written", () => {
  const original = preview.status === "ready" ? preview.steps[0]! : undefined;
  if (!original) throw new Error("Missing adoption fixture.");
  const { metadataEffects: _uses, baseReferences: _bases, adoptionEvidence: _evidence, ...step } = original;
  const inverse = { ...step, bindingEffects: [{ bindingId: binding.bindingId, before: binding }] };
  const rendered = render(<ChangesDiff steps={[inverse]} t={(key) => key} />);
  try {
    expect(rendered.container.textContent).toContain("Omni will remove this assignment binding.");
    expect(rendered.container.textContent).toContain(binding.bindingId);
    expect(rendered.container.textContent).toContain("No skill files will be changed.");
  } finally {
    act(() => rendered.root.unmount());
  }
});
