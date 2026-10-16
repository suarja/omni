// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import type { Binding } from "../../src/domain/assignment-plan";
import type { ManagedSkillUse, SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import { ChangesResult } from "../../src/renderer/canvas/changes/ChangesResult";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import { snapshot } from "../fixtures/resource-catalogue";
import { group, locationA, locationB, node, render, skillId } from "./skill-copy-comparison-fixtures";

const source = { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" };
function completeRevision(): SkillRevision {
  const read = node.members[0]!.read;
  if (read.status !== "complete") throw new Error("The detachment fixture must contain a complete copy.");
  return read.revision;
}

const revision = completeRevision();
const use: ManagedSkillUse = {
  skillId,
  bindingId: "binding-one",
  location: locationA,
  source,
  baseRevisionId: "d3477a13-4514-4de2-b9c9-f567fbb7e511",
};
const binding: Binding = {
  bindingId: use.bindingId,
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: source.artifactPath,
  kind: "skill",
  projectId: locationA.projectId,
  harnessId: locationA.harnessId,
  boundHash: revision.hash,
  ownedHash: revision.hash,
  createdAt: "2026-10-09T08:00:00.000Z",
};

function previewFor(restoring: boolean): SkillPreview {
  const stepId = restoring ? "restore-step" : "detach-step";
  const intentId = restoring ? "restore-intent" : "detach-intent";
  const scope = {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ projectId: locationA.projectId, harnessId: locationA.harnessId, bindingId: binding.bindingId }],
  };
  return {
    status: "ready",
    intentId,
    planId: stepId,
    effectFingerprint: "f".repeat(64),
    scope,
    steps: [
      {
        stepId,
        scope,
        plan: {
          planId: stepId,
          kind: "detach-skill",
          displayTarget: locationA.folderPath,
          actions: [],
          git: { mode: "disabled", warnings: [] },
        },
        bindingEffects: [
          restoring
            ? { bindingId: binding.bindingId, after: binding }
            : { bindingId: binding.bindingId, before: binding },
        ],
        files: [],
        metadataEffects: [
          restoring ? { skillId, location: locationA, after: use } : { skillId, location: locationA, before: use },
        ],
        detachmentEvidence: {
          choice: "detach-managed",
          skillId,
          storeRevision: 4,
          record: node.record,
          local: {
            location: locationA,
            rootIdentity: "a".repeat(64),
            revision,
            envelope: [],
          },
          use,
          binding,
          base: { baseRevisionId: use.baseRevisionId, revision },
        },
        ...(restoring ? { detachmentRestoreOrigin: { intentId: "detach-intent", stepId: "detach-step" } } : {}),
      },
    ],
  };
}

function resultFor(status: "detached" | "unknown" = "detached"): SkillResult {
  const recovery = status === "unknown";
  return {
    intentId: "detach-intent",
    operationId: "parent-operation",
    status: recovery ? "recovery-required" : "applied",
    source: { status: "unchanged", sourceId: source.sourceId },
    targets: [
      {
        projectId: locationA.projectId,
        harnessId: locationA.harnessId,
        bindingId: binding.bindingId,
        artifactPath: source.artifactPath,
        status: recovery ? "unknown" : "removed",
      },
    ],
    receiptIds: ["receipt-detach"],
    receipts: [
      {
        operationId: "receipt-detach",
        kind: "detach-skill",
        status: "applied",
        appliedAt: "2026-10-09T08:00:00.000Z",
        displayTarget: locationA.folderPath,
        actions: [],
        git: { mode: "disabled" },
        registered: null,
        source: { kind: "source", id: source.sourceId, relativePath: source.artifactPath },
        project: { id: locationA.projectId },
        detachment: { intentId: "detach-intent", stepId: "detach-step" },
      },
    ],
    issues: [],
    recoveryAvailable: recovery,
    detachment: {
      choice: "detach-managed",
      skillId,
      location: locationA,
      source,
      bindingId: binding.bindingId,
      status,
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

test("the copy reader routes detachment through the unified manager", async () => {
  const rendered = render(
    <SkillCopiesSheet
      api={null}
      group={group}
      initialTab="metadata"
      node={node}
      onCompare={() => undefined}
      onClose={() => undefined}
      onEnsureGrant={async () => "grant"}
      snapshot={snapshot}
    />,
  );
  try {
    const button = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Stop managing this copy",
    );
    expect(button).toBeUndefined();
    expect(rendered.container.textContent).toContain("Compare and manage");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("the Changes review shows metadata scope, result, and the matching restore action", async () => {
  const onAdoptionChanged = vi.fn(async () => undefined);
  const api: Pick<
    DesktopApi,
    "previewSkillOperation" | "refreshSkillOperation" | "applySkillOperation" | "readSkillOperationResult"
  > = {
    previewSkillOperation: vi.fn(async (request) => previewFor(request.intent.kind === "restore")),
    refreshSkillOperation: vi.fn(async () => previewFor(false)),
    applySkillOperation: vi.fn(async () => resultFor()),
    readSkillOperationResult: vi.fn(async () => undefined),
  };
  const rendered = render(
    <OperationChangesWorkbench
      api={api}
      artifacts={[]}
      initialJourney="draft"
      initialSkillIntent={{
        kind: "reconcile",
        request: { choice: "detach-managed", skillId, locations: [locationA] },
      }}
      onAdoptionChanged={onAdoptionChanged}
      onClose={() => undefined}
      onSourceChanged={() => undefined}
      packages={[]}
      projects={[{ id: locationA.projectId, name: "Project One", available: true, harnesses: ["codex"] }]}
      sources={[{ id: source.sourceId, name: "Personal Skills" }]}
    />,
  );
  try {
    await settle();
    expect(rendered.container.querySelector(".changes-header h2")?.textContent).toBe("Stop managing this copy");
    expect(rendered.container.textContent).toContain("No file changes.");
    expect(rendered.container.textContent).toContain("Assignment tracking removed for this copy.");
    expect(rendered.container.querySelector(".changes-file-list")).toBeNull();
    const targetsTab = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (candidate) => candidate.textContent === "Targets",
    );
    await act(async () => targetsTab!.click());
    const targetSummary = rendered.container.querySelector(".changes-detachment-summary");
    expect(targetSummary?.textContent).toContain(locationA.folderPath);
    expect(targetSummary?.textContent).not.toContain(locationB.folderPath);
    expect(targetSummary?.textContent).toContain("Other copies and their membership stay unchanged.");
    const diffTab = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (candidate) => candidate.textContent === "Diff",
    );
    await act(async () => diffTab!.click());
    const details = rendered.container.querySelector<HTMLDetailsElement>(".changes-detachment-summary details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(skillId);
    expect(rendered.container.textContent).not.toContain("project-two");
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Stop managing",
    );
    expect(confirm?.disabled).toBe(false);
    await act(async () => confirm!.click());
    await settle();
    expect(onAdoptionChanged).toHaveBeenCalledOnce();
    expect(rendered.container.textContent).toContain("Management stopped");
    const reviewRestore = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Review restore",
    );
    expect(reviewRestore).toBeDefined();
    await act(async () => reviewRestore!.click());
    await settle();
    expect(rendered.container.querySelector(".changes-header h2")?.textContent).toBe("Review restore");
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Restore management",
      ),
    ).toBeDefined();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("an unverified detachment result is never labeled as stopped", () => {
  const rendered = render(
    <ChangesResult result={resultFor("unknown")} onRestore={() => undefined} t={(key) => String(key)} />,
  );
  try {
    expect(rendered.container.textContent).toContain("skillManagement.detachmentUnknown");
    expect(rendered.container.textContent).not.toContain("skillManagement.detachmentStopped");
    expect(rendered.container.textContent).toContain("skillManagement.restoreReview");
  } finally {
    act(() => rendered.root.unmount());
  }
});
