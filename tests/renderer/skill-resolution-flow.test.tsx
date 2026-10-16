// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import type { Binding } from "../../src/domain/assignment-plan";
import type { ManagedSkillUse, SkillLocationKey, SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import type { SkillManagedResolutionChoice } from "../../src/shared/skill-reconciliation-request";
import type { SkillManagementPreviewRequest, SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import { render } from "./skill-copy-comparison-fixtures";

const location: SkillLocationKey = {
  projectId: "project-one",
  harnessId: "codex",
  folderPath: ".agents/skills/review",
};
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const source = { sourceId: "source-one", packageId: "packages/tools", artifactPath: "skills/review" };
const localRevision = revision("b");
const canonicalRevision = revision("c");
const baseRevisionId = "d3477a13-4514-4de2-b9c9-f567fbb7e511";
const canonicalBaseId = "e3477a13-4514-4de2-b9c9-f567fbb7e511";
const use: ManagedSkillUse = { skillId, bindingId: "binding-one", location, source, baseRevisionId };
const binding: Binding = {
  bindingId: use.bindingId,
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: source.artifactPath,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: localRevision.hash,
  ownedHash: localRevision.hash,
  createdAt: "2026-10-09T08:00:00.000Z",
};

function revision(digit: string): SkillRevision {
  const hash = digit.repeat(64);
  const paths =
    digit === "b" ? ["support/payload.bin", "local-only.md"] : ["support/payload.bin", "support/source-only.md"];
  return {
    algorithm: "omni-tree-v1",
    hash,
    files: paths.map((path) => ({ path, hash, byteLength: path.endsWith(".md") ? 8 : 4 })),
  };
}

function previewFor(choice: SkillManagedResolutionChoice): SkillPreview {
  const canonical = choice === "use-canonical";
  const afterUse = canonical ? { ...use, baseRevisionId: canonicalBaseId } : use;
  const afterBinding = canonical
    ? { ...binding, boundHash: canonicalRevision.hash, ownedHash: canonicalRevision.hash }
    : binding;
  const changedFile = {
    rootId: location.projectId,
    relativePath: `${location.folderPath}/support/payload.bin`,
    change: "change" as const,
    byteLength: 4,
    beforeHash: localRevision.files[0]!.hash,
    afterHash: canonicalRevision.files[0]!.hash,
    diff: "--- local\n+++ canonical\n@@ -1 +1 @@\n-local\n+canonical\n",
  };
  const addedFile = {
    rootId: location.projectId,
    relativePath: `${location.folderPath}/support/source-only.md`,
    change: "add" as const,
    byteLength: 8,
    afterHash: canonicalRevision.files[1]!.hash,
  };
  const deletedFile = {
    rootId: location.projectId,
    relativePath: `${location.folderPath}/local-only.md`,
    change: "delete" as const,
    byteLength: 8,
    beforeHash: localRevision.files[1]!.hash,
  };
  const files = canonical ? [changedFile, addedFile, deletedFile] : [];
  const scope = {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: binding.bindingId }],
  };
  const stepId = `resolution-${choice}`;
  return {
    status: "ready",
    intentId: `intent-${choice}`,
    planId: stepId,
    effectFingerprint: "a".repeat(64),
    scope,
    steps: [
      {
        stepId,
        scope,
        plan: {
          planId: stepId,
          kind: "resolve-skill",
          displayTarget: location.folderPath,
          actions: files.map((file) => {
            if (file.change === "add")
              return {
                kind: "write-file" as const,
                relativePath: file.relativePath,
                byteLength: file.byteLength,
                afterHash: file.afterHash,
              };
            if (file.change === "delete")
              return {
                kind: "delete-file" as const,
                relativePath: file.relativePath,
                byteLength: file.byteLength,
                beforeHash: file.beforeHash,
              };
            return {
              kind: "write-file" as const,
              relativePath: file.relativePath,
              byteLength: file.byteLength,
              beforeHash: file.beforeHash,
              afterHash: file.afterHash,
            };
          }),
          git: { mode: "disabled", warnings: [] },
        },
        bindingEffects: canonical ? [{ bindingId: binding.bindingId, before: binding, after: afterBinding }] : [],
        files,
        ...(canonical
          ? { metadataEffects: [{ skillId, location, before: use, after: afterUse }] }
          : { metadataEffects: [] }),
        baseReferences: [
          { baseRevisionId, revision: { ...localRevision } },
          ...(canonical ? [{ baseRevisionId: canonicalBaseId, revision: canonicalRevision }] : []),
        ],
        resolutionEvidence: {
          choice,
          skillId,
          storeRevision: 1,
          source,
          ...(canonical ? { sourceTree: { rootIdentity: "d".repeat(64), revision: canonicalRevision } } : {}),
          local: { location, rootIdentity: "e".repeat(64), revision: localRevision },
          use,
          binding,
          base: { baseRevisionId, revision: localRevision },
        },
      },
    ],
  };
}

function resultFor(choice: SkillManagedResolutionChoice): SkillResult {
  const targetStatus = choice === "keep-local" ? "retained-local" : "applied";
  return {
    intentId: `intent-${choice}`,
    operationId: `intent-${choice}`,
    status: "applied",
    source: { status: "unchanged", sourceId: source.sourceId },
    targets: [
      {
        projectId: location.projectId,
        harnessId: location.harnessId,
        bindingId: binding.bindingId,
        artifactPath: source.artifactPath,
        status: targetStatus,
      },
    ],
    receiptIds: [`receipt-${choice}`],
    receipts: [
      {
        operationId: `receipt-${choice}`,
        kind: "resolve-skill",
        status: "applied",
        appliedAt: "2026-10-09T08:00:00.000Z",
        displayTarget: location.folderPath,
        actions:
          choice === "keep-local"
            ? []
            : [{ kind: "write-file", relativePath: `${location.folderPath}/support/payload.bin`, status: "applied" }],
        git: { mode: "disabled" },
        registered: null,
        source: { kind: "source", id: source.sourceId, relativePath: source.artifactPath },
        project: { id: location.projectId },
        reconciliation: { intentId: `intent-${choice}`, stepId: `resolution-${choice}` },
      },
    ],
    issues: [],
    recoveryAvailable: false,
    resolution: { skillId, choice, targets: [{ location, bindingId: binding.bindingId, status: targetStatus }] },
  };
}

function workbench(
  api: Pick<
    DesktopApi,
    "previewSkillOperation" | "refreshSkillOperation" | "applySkillOperation" | "readSkillOperationResult"
  > &
    Partial<Pick<DesktopApi, "listSkillOperationRecoveries" | "onReviewChanged">>,
  initialJourney: "draft" | "assign" = "draft",
) {
  return render(
    <OperationChangesWorkbench
      api={api}
      artifacts={[]}
      initialJourney={initialJourney}
      initialManagedResolution={{ skillId, location }}
      onClose={() => undefined}
      onSourceChanged={() => undefined}
      packages={[]}
      projects={[{ id: location.projectId, name: "Project One", available: true, harnesses: ["codex"] }]}
      sources={[{ id: source.sourceId, name: "Personal Skills" }]}
    />,
  );
}

function createApi(): Pick<
  DesktopApi,
  "previewSkillOperation" | "refreshSkillOperation" | "applySkillOperation" | "readSkillOperationResult"
> &
  Partial<Pick<DesktopApi, "listSkillOperationRecoveries" | "onReviewChanged">> {
  const selected = (request: SkillManagementPreviewRequest): SkillManagedResolutionChoice => {
    if (
      request.intent.kind !== "reconcile" ||
      request.intent.request.choice === "adopt-exact" ||
      request.intent.request.choice === "keep-variant" ||
      request.intent.request.choice === "link-canonical" ||
      request.intent.request.choice === "detach-managed"
    )
      throw new Error("Expected an explicit managed resolution choice.");
    return request.intent.request.choice;
  };
  return {
    previewSkillOperation: vi.fn(async (request: SkillManagementPreviewRequest) => previewFor(selected(request))),
    refreshSkillOperation: vi.fn(async (request: { intentId: string }) =>
      previewFor(request.intentId.endsWith("keep-local") ? "keep-local" : "use-canonical"),
    ),
    applySkillOperation: vi.fn(async (request: { intentId: string }) =>
      resultFor(request.intentId.endsWith("keep-local") ? "keep-local" : "use-canonical"),
    ),
    readSkillOperationResult: vi.fn(async () => undefined),
    listSkillOperationRecoveries: vi.fn(async () => []),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

async function selectChoice(container: HTMLElement, choice: SkillManagedResolutionChoice): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${choice}"]`);
  expect(input).not.toBeNull();
  await act(async () => input!.click());
  await settle();
}

test("the managed-copy canvas entrance opens only resolution choices on Diff", async () => {
  const rendered = workbench(createApi(), "assign");
  try {
    await settle();
    expect(rendered.container.querySelector('.changes-tabs [aria-selected="true"]')?.textContent).toBe("Diff");
    expect(rendered.container.querySelector(".changes-assignment-targets")).toBeNull();
    expect(rendered.container.textContent).not.toContain("Owned marketplace");
    expect(rendered.container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(rendered.container.querySelector('input[type="radio"][value="keep-variant"]')).not.toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("resolution review waits for one explicit choice and summarizes only that managed copy", async () => {
  const api = createApi();
  const rendered = workbench(api);
  try {
    await settle();
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    expect(
      [...rendered.container.querySelectorAll<HTMLInputElement>("input[type=radio]")].every((input) => !input.checked),
    ).toBe(true);

    await selectChoice(rendered.container, "use-canonical");
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "reconcile", request: { choice: "use-canonical", skillId, locations: [location] } },
    });
    expect(rendered.container.textContent).toContain(`${location.folderPath}/support/payload.bin`);
    expect(rendered.container.textContent).toContain(`${location.folderPath}/support/source-only.md`);
    expect(rendered.container.textContent).toContain(`${location.folderPath}/local-only.md`);
    const targets = [...rendered.container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (tab) => tab.textContent === "Targets",
    );
    await act(async () => targets?.click());
    expect(rendered.container.textContent).toContain("Other copies remain unchanged.");
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Apply reviewed resolution",
    );
    expect(confirm?.disabled).toBe(false);

    await selectChoice(rendered.container, "keep-local");
    expect(api.previewSkillOperation).toHaveBeenCalledTimes(2);
    expect(rendered.container.textContent).not.toContain(`${location.folderPath}/support/source-only.md`);
    expect(rendered.container.textContent).toContain("Keep local");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("Keep local records retained content without offering an impossible inverse restore", async () => {
  const api = createApi();
  const rendered = workbench(api);
  try {
    await selectChoice(rendered.container, "keep-local");
    expect(rendered.container.textContent).toContain(
      "Retain the current project files and keep the recorded managed use and binding unchanged.",
    );
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Apply reviewed resolution",
    );
    expect(confirm?.disabled).toBe(false);
    await act(async () => confirm!.click());
    await settle();
    expect(rendered.container.textContent).toContain("Local content retained");
    expect(rendered.container.querySelector(".changes-result > header strong")?.textContent).toBe(
      "Local content retained",
    );
    expect(rendered.container.querySelector(".changes-result .changes-secondary")).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("inverse review hides the original forward-resolution choices", async () => {
  const api = createApi();
  const rendered = workbench(api);
  try {
    await selectChoice(rendered.container, "use-canonical");
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Apply reviewed resolution",
    )!;
    await act(async () => confirm.click());
    await settle();
    const restore = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Review restore",
    )!;
    await act(async () => restore.click());
    await settle();
    expect(rendered.container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  } finally {
    act(() => rendered.root.unmount());
  }
});
