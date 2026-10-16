// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

import type { SkillLocationKey, SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import type { SkillVariantCaptureEvidence } from "../../src/shared/skill-variant-effects";
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
const source = { sourceId: "source-one", packageId: "omni-tools", artifactPath: "skills/review-project-one" };
const request = {
  choice: "keep-variant" as const,
  skillId: "d4c8d2a7-11c1-4c71-9d13-3b06a4a37e81",
  locations: [location] as const,
  destination: { sourceId: source.sourceId, packageId: source.packageId, skillKey: "review-project-one" },
};
const evidence: SkillVariantCaptureEvidence = {
  request,
  storeRevision: 2,
  record: { skillId: request.skillId, label: "review", evidence: "individual", locations: [location] },
  local: { rootIdentity: "c".repeat(64), revision },
  destination: {
    source,
    rootIdentity: "d".repeat(64),
    packageRoot: "packages/tools",
    manifest: { relativePath: "packages/tools/omni.plugin.json", beforeHash: "e".repeat(64) },
    absent: true,
  },
  origin: {
    schemaVersion: 1,
    variantId: "123e4567-e89b-42d3-a456-426614174000",
    forkOf: request.skillId,
    capturedAt: "2026-10-09T10:00:00.000Z",
    capturedFrom: { location, revision },
  },
};
const step = {
  stepId: "capture-step-one",
  scope: {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId }],
  },
  plan: {
    planId: "capture-step-one",
    kind: "capture-skill" as const,
    displayTarget: `${source.packageId}/${source.artifactPath}`,
    actions: [],
    git: { mode: "disabled" as const, warnings: [] },
  },
  bindingEffects: [],
  files: [
    {
      rootId: source.sourceId,
      relativePath: "packages/tools/skills/review-project-one/SKILL.md",
      change: "add" as const,
      byteLength: 8,
      afterHash: "b".repeat(64),
      diff: "--- absent\n+++ captured\n@@ -0,0 +1 @@\n+# Review\n",
    },
    {
      rootId: source.sourceId,
      relativePath: "packages/tools/skills/review-project-one/support/payload.bin",
      change: "add" as const,
      byteLength: 4,
      afterHash: "f".repeat(64),
      summary: "Binary file; complete byte length and hash are shown.",
    },
    {
      rootId: source.sourceId,
      relativePath: "packages/tools/omni.plugin.json",
      change: "change" as const,
      byteLength: 180,
      beforeHash: "e".repeat(64),
      afterHash: "1".repeat(64),
      diff: "--- current manifest\n+++ proposed manifest\n",
    },
  ],
  variantCaptureEvidence: evidence,
};
const preview: SkillPreview = {
  status: "ready",
  intentId: "capture-intent-one",
  planId: step.stepId,
  effectFingerprint: "2".repeat(64),
  scope: step.scope,
  steps: [step],
};
const result: SkillResult = {
  intentId: preview.intentId,
  operationId: preview.intentId,
  status: "applied",
  source: { status: "updated", sourceId: source.sourceId },
  targets: [],
  receiptIds: [step.stepId],
  receipts: [
    {
      operationId: step.stepId,
      kind: "capture-skill",
      status: "applied",
      appliedAt: "2026-10-09T10:01:00.000Z",
      displayTarget: `${source.packageId}/${source.artifactPath}`,
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      source: { kind: "source", id: source.sourceId, relativePath: "packages/tools" },
      capture: { intentId: preview.intentId, stepId: step.stepId },
    },
  ],
  issues: [],
  recoveryAvailable: true,
  capture: {
    choice: "keep-variant",
    skillId: request.skillId,
    variantId: evidence.origin.variantId,
    location,
    destination: source,
    status: "applied",
  },
};

test("managed review offers capture, shows real effects and source-only targets, then opens and restores the variant", async () => {
  const api = {
    previewSkillOperation: vi.fn(async () => preview),
    refreshSkillOperation: vi.fn(async () => preview),
    applySkillOperation: vi.fn(async () => result),
    readSkillOperationResult: vi.fn(async () => result),
    listSkillOperationRecoveries: vi.fn(async () => []),
  };
  const onSourceChanged = vi.fn();
  const onAdoptionChanged = vi.fn(async () => undefined);
  const openVariant = vi.fn();
  const rendered = render(
    <OperationChangesWorkbench
      api={api}
      artifacts={[]}
      initialJourney="draft"
      initialManagedResolution={{ skillId: request.skillId, location }}
      onAdoptionChanged={onAdoptionChanged}
      onClose={() => undefined}
      onOpenVariant={openVariant}
      onSourceChanged={onSourceChanged}
      packages={[]}
      projects={[{ id: location.projectId, name: "Project One", available: true, harnesses: ["codex"] }]}
      sources={[{ id: source.sourceId, name: "Personal" }]}
      variantDestinations={[
        { sourceId: source.sourceId, sourceName: "Personal", packageId: source.packageId, packageName: "Tools" },
      ]}
    />,
  );
  const settle = async () =>
    act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  const radio = rendered.container.querySelector<HTMLInputElement>('input[value="keep-variant"]');
  try {
    expect(radio).not.toBeNull();
    expect(rendered.container.textContent).toContain("Keep as a personal variant");
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    await act(async () => radio!.click());
    const destination = rendered.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Personal source and plugin"]',
    )!;
    const key = rendered.container.querySelector<HTMLInputElement>('input[aria-label="New skill key"]')!;
    const review = (): HTMLButtonElement =>
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Review personal copy",
      )!;
    expect(review().disabled).toBe(true);
    await act(async () => {
      destination.value = `${source.sourceId}:${source.packageId}`;
      destination.dispatchEvent(new Event("change", { bubbles: true }));
      review().click();
    });
    await settle();
    expect(api.previewSkillOperation).toHaveBeenCalledWith({ intent: { kind: "reconcile", request } });
    expect(rendered.container.querySelector<HTMLDetailsElement>(".changes-resolution-configuration")?.open).toBe(false);
    expect(rendered.container.textContent).toContain("packages/tools/skills/review-project-one/SKILL.md");
    expect(rendered.container.textContent).toContain("packages/tools/omni.plugin.json");
    expect(rendered.container.textContent).toContain("Binary file; complete byte length and hash are shown.");

    const targets = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (tab) => tab.textContent === "Targets",
    )!;
    await act(async () => targets.click());
    expect(rendered.container.textContent).toContain("Destination");
    expect(rendered.container.textContent).toContain("The original project copy remains unchanged.");
    expect(rendered.container.querySelector(".changes-reviewed-target")).toBeNull();
    expect(rendered.container.querySelector(".changes-primary")?.textContent).toBe("Capture personal copy");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(key, "review-project-one-copy");
      key.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rendered.container.querySelector(".changes-primary")).toBeNull();
    await act(async () => review().click());
    await settle();
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: {
        kind: "reconcile",
        request: { ...request, destination: { ...request.destination, skillKey: key.value } },
      },
    });
    const confirm = rendered.container.querySelector<HTMLButtonElement>(".changes-primary")!;
    await act(async () => confirm.click());
    await settle();
    expect(onSourceChanged).toHaveBeenCalledOnce();
    expect(onAdoptionChanged).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Review restore");
    expect(rendered.container.textContent).not.toContain("Recovery is available.");
    expect(rendered.container.querySelector(".changes-resolution-configuration")?.parentElement?.hidden).toBe(true);
    const open = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Open variant",
    )!;
    await act(async () => open.click());
    expect(openVariant).toHaveBeenCalledWith(source);
  } finally {
    act(() => rendered.root.unmount());
  }
});
