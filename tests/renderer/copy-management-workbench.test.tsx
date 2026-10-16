// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

import type { SkillLocationKey } from "../../src/domain/skill-reconciliation/types";
import { CopyManagementWorkbench } from "../../src/renderer/canvas/changes/CopyManagementWorkbench";
import type { DesktopApi } from "../../src/shared/ipc";
import type { SkillIntent, SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import { snapshot } from "../fixtures/resource-catalogue";
import {
  deferred,
  locationA,
  locationB,
  node,
  readyForRequest,
  ref,
  render,
  skillId,
} from "./skill-copy-comparison-fixtures";

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

const locationC: SkillLocationKey = {
  projectId: locationA.projectId,
  harnessId: "cursor",
  folderPath: ".cursor/skills/review",
};

function nodeWithCursorCopy() {
  const member = node.members[0]!;
  const copy = node.locations[0]!;
  return {
    ...node,
    members: [...node.members, { ...member, location: locationC }],
    locations: [...node.locations, { ...copy, location: locationC }],
  };
}

function readyPreview(intent: SkillIntent): SkillPreview {
  const targets =
    intent.kind === "reconcile"
      ? intent.request.locations.map((location) => ({ projectId: location.projectId, harnessId: location.harnessId }))
      : [];
  return {
    status: "ready",
    intentId: "11111111-1111-4111-8111-111111111111",
    planId: "22222222-2222-4222-8222-222222222222",
    effectFingerprint: "a".repeat(64),
    scope: { targets },
    steps: [],
  };
}

function appliedResult(): SkillResult {
  return {
    intentId: "11111111-1111-4111-8111-111111111111",
    operationId: "33333333-3333-4333-8333-333333333333",
    status: "applied",
    source: { status: "unchanged" },
    targets: [],
    receiptIds: [],
    issues: [],
    recoveryAvailable: false,
  };
}

function createApi() {
  const api: Pick<
    DesktopApi,
    | "compareSkillCopies"
    | "previewSkillOperation"
    | "refreshSkillOperation"
    | "applySkillOperation"
    | "readSkillOperationResult"
  > = {
    compareSkillCopies: vi.fn(async (request) => readyForRequest(request, request.a.folderPath)),
    previewSkillOperation: vi.fn(async ({ intent }) => readyPreview(intent)),
    refreshSkillOperation: vi.fn(async () => readyPreview({ kind: "restore", operationId: "restore" })),
    applySkillOperation: vi.fn(async () => appliedResult()),
    readSkillOperationResult: vi.fn(async () => undefined),
  };
  return api;
}

function renderWorkbench(
  overrides: Readonly<{
    node?: typeof node;
    target?: SkillLocationKey;
    api?: ReturnType<typeof createApi>;
  }> = {},
) {
  const api = overrides.api ?? createApi();
  const onRefresh = vi.fn(async () => undefined);
  const rendered = render(
    <CopyManagementWorkbench
      api={api}
      initialTarget={overrides.target ?? locationA}
      hasReader={false}
      managedUses={[]}
      managedUsesStatus="ready"
      node={overrides.node ?? node}
      onApplyingChange={() => undefined}
      onBack={() => undefined}
      onClose={() => undefined}
      onEnsureGrant={async () => "project-grant"}
      onRefresh={onRefresh}
      snapshot={snapshot}
      workflowKey={JSON.stringify([ref.entry.id, "root", skillId])}
    />,
  );
  return { ...rendered, api, onRefresh };
}

async function choose(label: string, value: string, container: HTMLElement): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, `${label} selector`).not.toBeNull();
  await act(async () => {
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(label: string, container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `${label} button`).toBeDefined();
  await act(async () => button!.click());
}

test("keeps the reader-selected target and lets the user retarget a three-copy comparison", async () => {
  const rendered = renderWorkbench({ node: nodeWithCursorCopy(), target: locationA });
  try {
    await act(settle);
    const target = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy to manage"]')!;
    const reference = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
    expect(JSON.parse(target.value)).toEqual([locationA.projectId, locationA.harnessId, locationA.folderPath]);
    expect(JSON.parse(reference.value)).toEqual([locationB.projectId, locationB.harnessId, locationB.folderPath]);
    expect(rendered.api.compareSkillCopies).toHaveBeenLastCalledWith(
      expect.objectContaining({ a: locationB, b: locationA }),
    );

    await choose(
      "Copy to manage",
      JSON.stringify([locationC.projectId, locationC.harnessId, locationC.folderPath]),
      rendered.container,
    );
    await act(settle);
    expect(JSON.parse(target.value)).toEqual([locationC.projectId, locationC.harnessId, locationC.folderPath]);
    expect(rendered.api.compareSkillCopies).toHaveBeenLastCalledWith(
      expect.objectContaining({ a: locationB, b: locationC }),
    );
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("a single copy can be kept without a comparison request or file operation", async () => {
  const singleNode = { ...node, members: [node.members[0]!], locations: [node.locations[0]!] };
  const rendered = renderWorkbench({ node: singleNode });
  try {
    await act(settle);
    expect(rendered.container.textContent).toContain("This skill has one observed project copy.");
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')?.disabled).toBe(
      true,
    );
    expect(rendered.api.compareSkillCopies).not.toHaveBeenCalled();
    await choose("Management action", "keep", rendered.container);
    await click("Review effects", rendered.container);
    expect(rendered.container.querySelector('[data-testid="copy-management-effects"]')).not.toBeNull();
    expect(rendered.api.previewSkillOperation).not.toHaveBeenCalled();
    await click("Keep this copy", rendered.container);
    expect(rendered.container.querySelector('[data-testid="copy-management-result"]')?.textContent).toContain(
      "Copy kept",
    );
    expect(rendered.api.applySkillOperation).not.toHaveBeenCalled();
    expect(rendered.onRefresh).not.toHaveBeenCalled();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("an unreadable selected copy does not display a successful comparison", async () => {
  const unreadable = {
    ...node,
    members: node.members.map((member) =>
      member.location.folderPath === locationA.folderPath
        ? { ...member, read: { status: "unavailable" as const, reason: "io" as const } }
        : member,
    ),
    locations: node.locations.map((copy) =>
      copy.location.folderPath === locationA.folderPath
        ? { ...copy, read: { status: "unavailable" as const, reason: "io" as const } }
        : copy,
    ),
  };
  const rendered = renderWorkbench({ node: unreadable });
  try {
    await act(settle);
    expect(rendered.container.textContent).toContain("The selected copy could not be read.");
    expect(rendered.container.querySelector('[aria-label="Compared files"]')).toBeNull();
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Review effects",
      )?.disabled,
    ).toBe(true);
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("an explicit Marketplace skill choice is previewed and applied to the selected copy once", async () => {
  const rendered = renderWorkbench();
  try {
    await act(settle);
    await choose("Management action", "link", rendered.container);
    const source = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')!;
    expect(source.value).toBe("");
    const sourceValue = [...source.options].find((option) => option.value.includes('"pstack"'))?.value;
    expect(sourceValue).toBeDefined();
    await choose("Marketplace skill", sourceValue!, rendered.container);
    await click("Review effects", rendered.container);
    await act(settle);

    const expectedIntent: SkillIntent = {
      kind: "reconcile",
      request: {
        choice: "link-canonical",
        skillId,
        source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
        locations: [locationA],
      },
    };
    expect(rendered.api.previewSkillOperation).toHaveBeenCalledOnce();
    expect(rendered.api.previewSkillOperation).toHaveBeenCalledWith({ intent: expectedIntent });
    expect(rendered.api.applySkillOperation).not.toHaveBeenCalled();
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Apply to this copy",
      )?.disabled,
    ).toBe(false);

    await click("Apply to this copy", rendered.container);
    await act(settle);
    expect(rendered.api.applySkillOperation).toHaveBeenCalledOnce();
    expect(rendered.api.applySkillOperation).toHaveBeenCalledWith({
      intentId: "11111111-1111-4111-8111-111111111111",
      effectFingerprint: "a".repeat(64),
    });
    expect(rendered.container.querySelector('[data-testid="copy-management-result"]')).not.toBeNull();
    expect(rendered.onRefresh).toHaveBeenCalledOnce();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("requires an explicit action before reviewing the selected copy", async () => {
  const rendered = renderWorkbench();
  try {
    await act(settle);
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Management action"]')?.value).toBe(
      "",
    );
    const review = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Review effects",
    );
    expect(review?.disabled).toBe(true);
    expect(rendered.api.previewSkillOperation).not.toHaveBeenCalled();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("explains an invalid capture name while review remains disabled", async () => {
  const rendered = renderWorkbench();
  try {
    await act(settle);
    await choose("Management action", "capture", rendered.container);
    const field = rendered.container.querySelector<HTMLInputElement>("input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "../invalid");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("safe, available skill name");
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Review effects",
      )?.disabled,
    ).toBe(true);
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("keeps compared paths and hashes inside closed Details", async () => {
  const rendered = renderWorkbench();
  try {
    await act(settle);
    const details = rendered.container.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(locationA.folderPath);
    expect(details?.textContent).toContain(locationB.folderPath);
    expect(rendered.container.querySelector(".changes-provenance")?.closest("details")).not.toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("comparison lists only differing files in the management sheet", async () => {
  const api = createApi();
  vi.mocked(api.compareSkillCopies!).mockImplementation(async (request) => {
    const response = readyForRequest(request, "diff");
    if (response.status !== "ready") throw new Error("Expected a readable comparison fixture.");
    return {
      ...response,
      files: [
        ...response.files,
        {
          path: "notes/matching.md",
          change: "unchanged",
          left: { hash: "a".repeat(64), byteLength: 8 },
          right: { hash: "a".repeat(64), byteLength: 8 },
        },
      ],
    };
  });
  const view = renderWorkbench({ api });
  try {
    await act(settle);
    expect(view.container.querySelector(".changes-comparison-list")?.textContent).not.toContain("notes/matching.md");
  } finally {
    act(() => view.root.unmount());
  }
});

test("applying disables every step tab until the result is acknowledged", async () => {
  const pending = deferred<SkillResult>();
  const api = createApi();
  vi.mocked(api.applySkillOperation!).mockImplementation(async () => pending.promise);
  const view = renderWorkbench({ api });
  try {
    await act(settle);
    await choose("Management action", "link", view.container);
    const source = view.container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace skill"]')!;
    await choose(
      "Marketplace skill",
      [...source.options].find((option) => option.value.includes('"pstack"'))!.value,
      view.container,
    );
    await click("Review effects", view.container);
    await act(settle);
    await click("Apply to this copy", view.container);
    expect([...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].every((tab) => tab.disabled)).toBe(
      true,
    );
    await act(async () => pending.resolve(appliedResult()));
    await act(settle);
    expect(view.container.querySelector('[data-testid="copy-management-result"]')).not.toBeNull();
  } finally {
    act(() => view.root.unmount());
  }
});
