// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import type { SkillUnboundResolutionRequest } from "../../src/shared/skill-unbound-resolution-request";
import { render } from "./skill-copy-comparison-fixtures";
import { useI18n } from "../../src/renderer/i18n";
import { UnboundResolutionSummary } from "../../src/renderer/canvas/changes/UnboundResolutionSummary";
import { ChangesResult } from "../../src/renderer/canvas/changes/ChangesResult";

const location = { projectId: "project-one", harnessId: "codex" as const, folderPath: ".agents/skills/review" };
const source = { sourceId: "source-one", packageId: "packages/tools", artifactPath: "skills/review" };
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const bindingId = "223e4567-e89b-42d3-a456-426614174000";
const intent: SkillUnboundResolutionRequest = {
  choice: "link-canonical",
  skillId,
  source,
  locations: [location],
};

const preview: SkillPreview = {
  status: "ready",
  intentId: "323e4567-e89b-42d3-a456-426614174000",
  planId: "423e4567-e89b-42d3-a456-426614174000",
  effectFingerprint: "a".repeat(64),
  scope: {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ ...location, bindingId }],
  },
  steps: [
    {
      stepId: "523e4567-e89b-42d3-a456-426614174000",
      scope: {
        sourceId: source.sourceId,
        packageId: source.packageId,
        artifactPath: source.artifactPath,
        targets: [{ ...location, bindingId }],
      },
      plan: {
        planId: "523e4567-e89b-42d3-a456-426614174000",
        kind: "link-skill",
        displayTarget: location.folderPath,
        actions: [
          {
            kind: "write-file",
            relativePath: `${location.folderPath}/support/source-only.md`,
            beforeHash: "b".repeat(64),
            afterHash: "c".repeat(64),
          },
        ],
        git: { mode: "disabled", warnings: [] },
      },
      bindingEffects: [],
      metadataEffects: [],
      baseReferences: [],
      files: [
        {
          rootId: location.projectId,
          relativePath: `${location.folderPath}/support/source-only.md`,
          change: "change",
          byteLength: 14,
          beforeHash: "b".repeat(64),
          afterHash: "c".repeat(64),
          diff: "--- local\n+++ source\n@@ -1 +1 @@\n-local\n+canonical\n",
        },
      ],
      unboundResolutionEvidence: {
        choice: "link-canonical",
        skillId,
        storeRevision: 4,
        record: { skillId, label: "review", evidence: "observed-equivalence", locations: [location] },
        source: {
          ref: source,
          rootIdentity: "d".repeat(64),
          revision: { algorithm: "omni-tree-v1", hash: "c".repeat(64), files: [] },
        },
        local: {
          location,
          rootIdentity: "e".repeat(64),
          revision: { algorithm: "omni-tree-v1", hash: "b".repeat(64), files: [] },
        },
        priorManagement: { use: "absent", binding: "absent", base: "unknown" },
      },
      unboundResolutionEnvelope: { source: [], local: [] },
    },
  ],
};

const result: SkillResult = {
  intentId: preview.intentId,
  operationId: preview.intentId,
  status: "applied",
  source: { status: "unchanged", sourceId: source.sourceId },
  targets: [
    {
      projectId: location.projectId,
      harnessId: location.harnessId,
      bindingId,
      artifactPath: source.artifactPath,
      status: "applied",
    },
  ],
  receiptIds: ["623e4567-e89b-42d3-a456-426614174000"],
  receipts: [
    {
      operationId: "623e4567-e89b-42d3-a456-426614174000",
      kind: "link-skill",
      status: "applied",
      appliedAt: "2026-10-09T08:00:00.000Z",
      displayTarget: location.folderPath,
      actions: [
        { kind: "write-file", relativePath: `${location.folderPath}/support/source-only.md`, status: "applied" },
      ],
      git: { mode: "disabled" },
      registered: null,
      source: { kind: "source", id: source.sourceId, relativePath: source.artifactPath },
      project: { id: location.projectId },
      link: { intentId: preview.intentId, stepId: preview.planId },
    },
  ],
  link: { choice: "link-canonical", skillId, source, location, bindingId, status: "applied" },
  issues: [],
  recoveryAvailable: true,
};

function RestoreSummary() {
  const { t } = useI18n();
  const forward = preview.status === "ready" ? preview.steps[0]! : undefined;
  if (!forward) throw new Error("Expected a link fixture.");
  return (
    <UnboundResolutionSummary
      step={{ ...forward, plan: { ...forward.plan, kind: "restore-apply" } }}
      nameFor={(id) => id}
      t={t}
      variant="diff"
    />
  );
}

test("restore preview describes proposed recovery without claiming completion or absent current management", () => {
  const rendered = render(<RestoreSummary />);
  try {
    expect(rendered.container.querySelector("h3")?.textContent).toBe("Review restore");
    expect(rendered.container.textContent).not.toContain("No current managed use");
    expect(rendered.container.textContent).toContain("Restore the selected copy's previous files");
  } finally {
    act(() => rendered.root.unmount());
  }
});

function EqualLinkResult() {
  const { t } = useI18n();
  return (
    <ChangesResult
      result={{
        ...result,
        resolution: { skillId, choice: "adopt-exact", targets: [{ location, bindingId, status: "applied" }] },
      }}
      t={t}
      onRestore={() => undefined}
    />
  );
}

test("equal-copy linking keeps one result summary and states that no skill files changed", () => {
  const rendered = render(<EqualLinkResult />);
  try {
    expect(rendered.container.querySelector(".changes-result-adoption")).toBeNull();
    expect(rendered.container.querySelector(".changes-result-unbound")?.textContent).toContain("No skill files");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("canonical link review shows the actual file delta, one exact target, unknown history, and public restore", async () => {
  const requests: unknown[] = [];
  const onAdoptionChanged = vi.fn(async () => undefined);
  const api = {
    previewSkillOperation: vi.fn(async (request) => {
      requests.push(request);
      return preview;
    }),
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
      initialSkillIntent={{ kind: "reconcile", request: intent }}
      onAdoptionChanged={onAdoptionChanged}
      onBack={() => undefined}
      onClose={() => undefined}
      onSourceChanged={() => undefined}
      packages={[]}
      projects={[{ id: location.projectId, name: "Project One", available: true, harnesses: ["codex"] }]}
      sources={[{ id: source.sourceId, name: "Personal Skills" }]}
    />,
  );

  try {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(requests[0]).toMatchObject({ intent: { kind: "reconcile", request: { choice: "link-canonical" } } });
    expect(rendered.container.querySelector(".changes-header h2")?.textContent).toBe("Review canonical link");
    expect(rendered.container.textContent).toContain("Historical common baseUnknown");
    expect(rendered.container.textContent).toContain("Unknown — no historical common base is recorded.");
    expect(rendered.container.textContent).toContain("support/source-only.md");
    expect(rendered.container.textContent).toContain("Only the selected project copy can change.");
    expect(rendered.container.textContent).not.toContain("Managed skill resolution");

    const targets = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (tab) => tab.textContent === "Targets",
    );
    await act(async () => targets?.click());
    expect(rendered.container.textContent).toContain("Project One · Codex");
    expect(rendered.container.textContent).toContain(".agents/skills/review");
    expect(rendered.container.textContent).not.toContain("2 targets");

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(".changes-primary")?.click();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(onAdoptionChanged).toHaveBeenCalledOnce();
    expect(rendered.container.textContent).toContain("The selected canonical source remains unchanged.");
    expect(rendered.container.textContent).toContain("Review restore");
    expect(rendered.container.textContent).toContain("Unknown — no historical common base is recorded.");
    const targetOutcomes = rendered.container.querySelector(".changes-target-results")?.textContent ?? "";
    expect(targetOutcomes).toContain("Linked");
    expect(targetOutcomes).not.toContain("Assigned");
  } finally {
    act(() => rendered.root.unmount());
  }
});
