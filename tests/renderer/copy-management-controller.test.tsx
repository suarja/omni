// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { expect, test, vi } from "vitest";
import type { ManagedSkillUse } from "../../src/domain/skill-reconciliation/types";
import type { Binding } from "../../src/domain/assignment-plan";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import type { SkillIntent, SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { useCopyManagement } from "../../src/renderer/canvas/changes/use-copy-management";
import { CopyManagementResult } from "../../src/renderer/canvas/changes/CopyManagementResult";
import { snapshot } from "../fixtures/resource-catalogue";
import {
  deferred,
  locationA,
  locationB,
  node,
  readyForRequest,
  render,
  skillId,
} from "./skill-copy-comparison-fixtures";

const source = { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" };
const use: ManagedSkillUse = {
  skillId,
  location: locationA,
  source,
  bindingId: "binding-one",
  baseRevisionId: "base-one",
};
const binding: Binding = {
  ...source,
  artifactPath: "skills/review/SKILL.md",
  bindingId: use.bindingId,
  kind: "skill",
  projectId: locationA.projectId,
  harnessId: locationA.harnessId,
  boundHash: "a".repeat(64),
  createdAt: "2026-10-10T09:00:00Z",
};
const managedSnapshot: ResourceSnapshot = {
  ...snapshot,
  uses: { status: "ready", bindings: [binding] },
  roots: snapshot.roots.map((root) =>
    root.entry.kind === "source" && root.evidence.status === "observed"
      ? {
          ...root,
          evidence: {
            ...root.evidence,
            observation: {
              ...root.evidence.observation,
              inventory: {
                ...root.evidence.observation.inventory,
                packages: root.evidence.observation.inventory.packages?.map((pkg) =>
                  pkg.id === "pstack"
                    ? { ...pkg, format: "omni" as const, manifestPaths: ["plugins/pstack/omni.plugin.json"] }
                    : pkg,
                ),
              },
            },
          },
        }
      : root,
  ),
};
function preview(intent: SkillIntent): SkillPreview {
  return {
    status: "ready",
    intentId: "intent-one",
    planId: "plan-one",
    effectFingerprint: "a".repeat(64),
    scope: { targets: intent.kind === "reconcile" ? intent.request.locations : [] },
    steps: [],
  };
}
const result: SkillResult = {
  intentId: "intent-one",
  operationId: "operation-one",
  status: "applied",
  source: { status: "unchanged" },
  targets: [],
  receiptIds: ["receipt-one"],
  receipts: [
    {
      operationId: "receipt-one",
      kind: "detach-skill",
      status: "applied",
      appliedAt: "2026-10-10T09:00:00Z",
      displayTarget: locationA.folderPath,
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      source: { kind: "source", id: source.sourceId, relativePath: source.artifactPath },
      project: { id: locationA.projectId },
      detachment: { intentId: "intent-one", stepId: "step-one" },
    },
  ],
  issues: [],
  recoveryAvailable: false,
  detachment: {
    choice: "detach-managed",
    skillId,
    source,
    location: locationA,
    bindingId: use.bindingId,
    status: "detached",
  },
};
function api() {
  return {
    compareSkillCopies: vi.fn(async (request: Parameters<typeof readyForRequest>[0]) =>
      readyForRequest(request, "diff"),
    ),
    previewSkillOperation: vi.fn(async ({ intent }: { intent: SkillIntent }) => preview(intent)),
    refreshSkillOperation: vi.fn(async () => preview({ kind: "restore", operationId: "operation-one" })),
    applySkillOperation: vi.fn(async () => result),
    readSkillOperationResult: vi.fn(async () => undefined),
  };
}
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
function mount(overrides: { pending?: Promise<SkillPreview> } = {}) {
  const service = api();
  if (overrides.pending) service.previewSkillOperation.mockImplementation(async () => overrides.pending!);
  let controller!: ReturnType<typeof useCopyManagement>;
  const onRefresh = vi.fn(async () => undefined);
  function Probe(props: { currentNode: typeof node }): ReactElement {
    controller = useCopyManagement({
      api: service,
      snapshot: managedSnapshot,
      node: props.currentNode,
      managedUses: [use],
      managedUsesStatus: "ready",
      initialTarget: locationA,
      workflowKey: "current-copy",
      onEnsureGrant: async () => "grant",
      onRefresh,
    });
    return <p>{controller.stage}</p>;
  }
  const rendered = render(<Probe currentNode={node} />);
  return {
    ...rendered,
    service,
    onRefresh,
    get: () => controller,
    updateNode: (currentNode: typeof node) =>
      rendered.root.render(
        <I18nProvider>
          <Probe currentNode={currentNode} />
        </I18nProvider>,
      ),
  };
}

test.each([
  ["keep", "keep-local"],
  ["canonical", "use-canonical"],
  ["detach", "detach-managed"],
] as const)("managed %s previews and applies only the selected copy", async (action, choice) => {
  const view = mount();
  try {
    await settle();
    await act(async () => view.get().setAction(action));
    await act(async () => view.get().reviewEffects());
    expect(view.service.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "reconcile", request: { choice, skillId, locations: [locationA] } },
    });
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).toHaveBeenCalledOnce();
    expect(view.get().stage).toBe("result");
    expect(view.get().result?.operationId).toBe("operation-one");
    expect(view.onRefresh).toHaveBeenCalledOnce();
  } finally {
    act(() => view.root.unmount());
  }
});

test("refreshing changed copy evidence permits a new confirmation", async () => {
  const view = mount();
  try {
    await settle();
    await act(async () => view.get().setAction("canonical"));
    await act(async () => view.get().reviewEffects());
    const changed = {
      ...node,
      members: node.members.map((member) =>
        member.read.status === "complete"
          ? { ...member, read: { ...member.read, revision: { ...member.read.revision, hash: "b".repeat(64) } } }
          : member,
      ),
    };
    await act(async () => view.updateNode(changed));
    expect(view.get().reviewCurrent).toBe(false);
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).not.toHaveBeenCalled();
    await act(async () => {
      await view.get().refreshPreview();
    });
    expect(view.get().reviewCurrent).toBe(true);
    expect(view.get().stage).toBe("effects");
    expect(view.get().operation.intent).toEqual({
      kind: "reconcile",
      request: { choice: "use-canonical", skillId, locations: [locationA] },
    });
    expect(view.get().operation.preview?.status).toBe("ready");
    expect(view.service.applySkillOperation).not.toHaveBeenCalled();
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).toHaveBeenCalledOnce();
  } finally {
    act(() => view.root.unmount());
  }
});

test("a late preview cannot authorize the newly selected target", async () => {
  const pending = deferred<SkillPreview>();
  const view = mount({ pending: pending.promise });
  try {
    await settle();
    await act(async () => view.get().setAction("canonical"));
    await act(async () => view.get().reviewEffects());
    await act(async () => view.get().selectTarget(locationB));
    await act(async () => pending.resolve(preview({ kind: "restore", operationId: "unused" })));
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).not.toHaveBeenCalled();
    expect(view.get().operation.busy).toBe(false);
    expect(view.get().target).toEqual(locationB);
    expect(view.get().action).toBe("");
    expect(view.get().stage).toBe("compare");
  } finally {
    act(() => view.root.unmount());
  }
});

test("restore review uses the acknowledged parent receipt in the same controller", async () => {
  const view = mount();
  try {
    await settle();
    await act(async () => view.get().setAction("detach"));
    await act(async () => view.get().reviewEffects());
    await act(async () => {
      await view.get().apply();
    });
    await act(async () => view.get().reviewRestore());
    expect(view.get().stage).toBe("effects");
    expect(view.service.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: { kind: "restore", operationId: "operation-one" },
    });
    expect(view.service.applySkillOperation).toHaveBeenCalledOnce();
  } finally {
    act(() => view.root.unmount());
  }
});

test("result paths stay in closed Details while the outcome remains visible", () => {
  const view = render(
    <CopyManagementResult result={result} localNoWrite={false} target={locationA} snapshot={snapshot} />,
  );
  try {
    const path = [...view.container.querySelectorAll("code")].find((code) => code.textContent === locationA.folderPath);
    expect(path?.closest("details")).not.toBeNull();
    expect(path?.closest("details")?.open).toBe(false);
    expect(view.container.textContent).toContain("Management stopped");
  } finally {
    act(() => view.root.unmount());
  }
});

test("capture uses the explicit personal destination and keeps the selected location", async () => {
  const view = mount();
  try {
    await settle();
    await act(async () => view.get().setAction("capture"));
    const destination = view.get().destinations[0]!;
    expect(destination).toBeDefined();
    await act(async () => view.get().selectDestination(`${destination.sourceId}:${destination.packageId}`));
    await act(async () => view.get().setSkillKey("review-personal"));
    await act(async () => view.get().reviewEffects());
    expect(view.service.previewSkillOperation).toHaveBeenCalledWith({
      intent: {
        kind: "reconcile",
        request: {
          choice: "keep-variant",
          skillId,
          locations: [locationA],
          destination: {
            sourceId: destination.sourceId,
            packageId: destination.packageId,
            skillKey: "review-personal",
          },
        },
      },
    });
    expect(view.service.applySkillOperation).not.toHaveBeenCalled();
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).toHaveBeenCalledOnce();
  } finally {
    act(() => view.root.unmount());
  }
});

test("an unreadable comparison peer does not block a readable managed copy", async () => {
  const view = mount();
  try {
    await settle();
    const peerUnavailable = {
      ...node,
      members: node.members.map((member) =>
        member.location.harnessId === locationB.harnessId
          ? { ...member, read: { status: "unavailable" as const, reason: "io" as const } }
          : member,
      ),
    };
    await act(async () => view.updateNode(peerUnavailable));
    await act(async () => view.get().setAction("detach"));
    await act(async () => view.get().reviewEffects());
    expect(view.service.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "reconcile", request: { choice: "detach-managed", skillId, locations: [locationA] } },
    });
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).toHaveBeenCalledOnce();
  } finally {
    act(() => view.root.unmount());
  }
});

test("a failed refresh cannot authorize changed copy evidence", async () => {
  const view = mount();
  try {
    await settle();
    await act(async () => view.get().setAction("canonical"));
    await act(async () => view.get().reviewEffects());
    const changed = {
      ...node,
      members: node.members.map((member) =>
        member.read.status === "complete"
          ? { ...member, read: { ...member.read, revision: { ...member.read.revision, hash: "b".repeat(64) } } }
          : member,
      ),
    };
    await act(async () => view.updateNode(changed));
    view.service.refreshSkillOperation.mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () => {
      await view.get().refreshPreview();
    });
    expect(view.get().reviewCurrent).toBe(false);
    await act(async () => {
      await view.get().apply();
    });
    expect(view.service.applySkillOperation).not.toHaveBeenCalled();
  } finally {
    act(() => view.root.unmount());
  }
});
