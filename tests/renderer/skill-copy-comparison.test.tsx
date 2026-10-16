// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { ChangesWorkbench } from "../../src/renderer/canvas/changes/ChangesWorkbench";
import { createCanvasSession } from "../../src/renderer/canvas/spatial/canvas-session";
import type { SkillLocationKey } from "../../src/domain/skill-reconciliation/types";
import type { LogicalSkillNode } from "../../src/renderer/canvas/spatial/spatial-types";
import type { ProjectSkillGroup } from "../../src/domain/resource-catalogue";
import type { DesktopApi } from "../../src/shared/ipc";
import type { ObserveSkillCopiesRequest } from "../../src/shared/skill-reconciliation-ipc";
import type {
  SkillCopyComparisonRequest,
  SkillCopyComparisonResponse,
} from "../../src/shared/skill-copy-comparison-ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { resourceFixture } from "../fixtures/resource-catalogue";
import {
  canvasCopySnapshot,
  comparisonResponse,
  deferred,
  group,
  locationA,
  locationB,
  locations,
  node,
  observedCopies,
  ReaderToComparison,
  readyForRequest,
  ref,
  render,
  revision,
  skillId,
  snapshot,
} from "./skill-copy-comparison-fixtures";

test("the reader opens the management route with the selected copy", async () => {
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>(async (request) =>
    comparisonResponse(request.filePath),
  );
  const operations = {
    previewSkillOperation: vi.fn(),
    refreshSkillOperation: vi.fn(),
    applySkillOperation: vi.fn(),
    readSkillOperationResult: vi.fn(),
    listSkillOperationRecoveries: vi.fn(),
    onReviewChanged: vi.fn(),
    saveSkillReconciliation: vi.fn(),
    writeFile: vi.fn(),
  };
  const api = { compareSkillCopies: compare, ...operations } as unknown as DesktopApi;
  const rendered = render(<ReaderToComparison api={api} />);
  try {
    const location = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Location"]');
    expect(location).not.toBeNull();
    await act(async () => {
      location!.value = JSON.stringify([ref, locationB]);
      location!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const filesTab = [...rendered.container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")].find(
      (button) => button.textContent === "Files",
    );
    act(() => filesTab!.click());
    const compareButton = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Compare and manage",
    );
    expect(compareButton?.disabled).toBe(false);
    await act(async () => compareButton!.click());

    expect(rendered.container.querySelector('[aria-label="Copy A"]')).toBeTruthy();
    expect(rendered.container.querySelector('[aria-label="Copy B"]')).toBeTruthy();
    expect(rendered.container.textContent).toContain(".claude/skills/review");
    expect(rendered.container.textContent).toContain(".agents/skills/review");
    expect(rendered.container.textContent).toContain("Diff");
    expect(rendered.container.textContent).toContain("Targets");
    expect(
      rendered.container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]:disabled')
        ?.textContent,
    ).toBe("Result");
    expect(rendered.container.textContent).toContain("old");
    const targetsTab = [...rendered.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (button) => button.textContent === "Targets",
    );
    act(() => targetsTab?.click());
    expect(rendered.container.textContent).toContain("Source relationship: unknown.");
    expect(rendered.container.textContent).toContain("Common base: unknown.");
    const diffTab = [...rendered.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (button) => button.textContent === "Diff",
    );
    act(() => diffTab?.click());

    const binaryFile = [...rendered.container.querySelectorAll<HTMLButtonElement>(".changes-comparison-file")].find(
      (button) => button.textContent?.includes("assets/preview.bin"),
    );
    expect(binaryFile?.textContent).toContain("~");
    await act(async () => binaryFile!.click());
    expect(rendered.container.textContent).toContain("Binary file; text preview is unavailable.");
    const supportFile = [...rendered.container.querySelectorAll<HTMLButtonElement>(".changes-comparison-file")].find(
      (button) => button.textContent?.includes("guides/only-a.md"),
    );
    expect(supportFile?.querySelector(".changes-sign")?.textContent).toBe("+");

    const matchingFile = [...rendered.container.querySelectorAll<HTMLButtonElement>(".changes-comparison-file")].find(
      (button) => button.textContent?.includes("notes/matching.md"),
    );
    expect(matchingFile?.textContent).toContain("·");
    await act(async () => matchingFile!.click());
    expect(rendered.container.textContent).toContain("Both copies have identical content.");

    const back = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Back to copies",
    );
    act(() => back!.click());
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Location"]')?.value).toBe(
      JSON.stringify([ref, locationB]),
    );
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")]
        .find((button) => button.textContent === "Files")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    expect(compare).toHaveBeenCalled();
    expect(Object.values(operations).every((operation) => operation.mock.calls.length === 0)).toBe(true);
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("the current location starts A and B follows the next lexical location among larger sets", async () => {
  const locationC: SkillLocationKey = {
    projectId: ref.entry.id,
    harnessId: "codex",
    folderPath: ".zeta/skills/review",
  };
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>(async (request) => ({
    status: "ready",
    projectId: request.projectId,
    skillId: request.skillId,
    a: { location: request.a, read: revision() },
    b: { location: request.b, read: revision() },
    files: [],
    evidence: { source: "unknown", base: "unknown", relationship: "observed-equivalence" },
  }));
  const rendered = render(
    <ChangesWorkbench
      api={{ compareSkillCopies: compare }}
      initialLeft={locationB}
      locations={[locationC, locationB, locationA]}
      mode="comparison"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onEnsureGrant={async () => "grant"}
      projectId={ref.entry.id}
      skillId={skillId}
    />,
  );
  try {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy A"]')?.value).toBe(
      JSON.stringify(locationB),
    );
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy B"]')?.value).toBe(
      JSON.stringify(locationC),
    );
    const copyB = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy B"]');
    await act(async () => {
      copyB!.value = JSON.stringify(locationA);
      copyB!.dispatchEvent(new Event("change", { bubbles: true }));
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(compare).toHaveBeenLastCalledWith(expect.objectContaining({ a: locationB, b: locationA }));
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("an explicit target and reference are preserved even when three copies exist", async () => {
  const locationC: SkillLocationKey = {
    projectId: ref.entry.id,
    harnessId: "cursor",
    folderPath: ".cursor/skills/review",
  };
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>(async (request) => ({
    status: "ready",
    projectId: request.projectId,
    skillId: request.skillId,
    a: { location: request.a, read: revision() },
    b: { location: request.b, read: revision() },
    files: [],
    evidence: { source: "unknown", base: "unknown", relationship: "observed-equivalence" },
  }));
  const rendered = render(
    <ChangesWorkbench
      api={{ compareSkillCopies: compare }}
      initialLeft={locationB}
      initialPair={{ a: locationB, b: locationA }}
      locations={[locationC, locationB, locationA]}
      mode="comparison"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onEnsureGrant={async () => "grant"}
      projectId={ref.entry.id}
      skillId={skillId}
    />,
  );
  try {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy A"]')?.value).toBe(
      JSON.stringify(locationB),
    );
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy B"]')?.value).toBe(
      JSON.stringify(locationA),
    );
    expect(compare).toHaveBeenLastCalledWith(expect.objectContaining({ a: locationB, b: locationA }));
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("changing the canvas context unmounts copy management before a late response can return", async () => {
  const fixture = canvasCopySnapshot();
  const observe = vi.fn(async (request: ObserveSkillCopiesRequest) => observedCopies(request));
  const pending = deferred<SkillCopyComparisonResponse>();
  const requests: SkillCopyComparisonRequest[] = [];
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>((request) => {
    requests.push(request);
    return pending.promise;
  });
  const api = {
    observeSkillCopies: observe,
    compareSkillCopies: compare,
    readArtifact: vi.fn().mockResolvedValue({ status: "read", content: "# Skill", byteLength: 7, truncated: false }),
  } as unknown as DesktopApi;
  const onEnsureGrant = async (): Promise<string> => "grant";
  const onNavigate = vi.fn();
  const onNavigateDestination = vi.fn();
  const onRefresh = vi.fn();
  const rendered = render(
    <ResourceCanvas
      api={api}
      context={{ kind: "entry", entry: resourceFixture.projectOneRef }}
      initialSkillCopy={{
        ref: { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "compare-review" },
        relativePath: ".claude/skills/review/SKILL.md",
      }}
      onEnsureGrant={onEnsureGrant}
      onNavigate={onNavigate}
      onNavigateDestination={onNavigateDestination}
      onRefresh={onRefresh}
      snapshot={fixture}
    />,
  );
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  };
  try {
    await act(settle);
    const compareButton = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Compare and manage",
    );
    await act(async () => {
      compareButton?.click();
      await settle();
    });
    expect(requests).toHaveLength(1);
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).not.toBeNull();

    await act(async () => {
      rendered.root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            context={{ kind: "workspace" }}
            onEnsureGrant={onEnsureGrant}
            onNavigate={onNavigate}
            onNavigateDestination={onNavigateDestination}
            onRefresh={onRefresh}
            snapshot={fixture}
          />
        </I18nProvider>,
      );
      await settle();
    });
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).toBeNull();
    await act(async () => {
      pending.resolve(readyForRequest(requests[0]!, "late context response"));
      await settle();
    });
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("late context response");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("the manager remains available when only one copy is known", () => {
  const rendered = render(
    <SkillCopiesSheet
      api={{ readArtifact: vi.fn() }}
      group={group}
      initialTab="metadata"
      node={node}
      onClose={vi.fn()}
      onCompare={vi.fn()}
      onEnsureGrant={async () => "grant"}
      snapshot={snapshot}
    />,
  );
  try {
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Compare and manage",
      )?.disabled,
    ).toBe(false);
  } finally {
    act(() => rendered.root.unmount());
  }
  const retainedNode: LogicalSkillNode = {
    ...node,
    members: [node.members[0]!],
    locations: [node.locations[0]!],
    record: { ...node.record, locations: [node.locations[0]!.location] },
  };
  const retainedGroup: ProjectSkillGroup = { ...group, locations: [group.locations[0]!] };
  const retained = render(
    <SkillCopiesSheet
      api={{ readArtifact: vi.fn() }}
      group={retainedGroup}
      initialTab="metadata"
      node={retainedNode}
      onClose={vi.fn()}
      onCompare={vi.fn()}
      onEnsureGrant={async () => "grant"}
      snapshot={snapshot}
    />,
  );
  try {
    expect(
      [...retained.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Compare and manage",
      )?.disabled,
    ).toBe(false);
  } finally {
    act(() => retained.root.unmount());
  }
});

test("the canvas controller preserves the reader and camera on Back, then Escape returns to its original trigger", async () => {
  const fixture = canvasCopySnapshot();
  const observe = vi.fn(async (request: ObserveSkillCopiesRequest) => observedCopies(request));
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>(async (request) => ({
    status: "ready",
    projectId: request.projectId,
    skillId: request.skillId,
    a: { location: request.a, read: revision() },
    b: { location: request.b, read: revision() },
    files: [],
    evidence: { source: "unknown", base: "unknown", relationship: "observed-equivalence" },
  }));
  const api = {
    observeSkillCopies: observe,
    compareSkillCopies: compare,
    readArtifact: vi.fn().mockResolvedValue({ status: "read", content: "# Skill", byteLength: 7, truncated: false }),
  } as unknown as DesktopApi;
  const session = createCanvasSession();
  const baseKey = "entry:project:project-one";
  const camera = { x: 111, y: 222, scale: 1.1 };
  session.write(baseKey, {
    groupId: null,
    cameras: { [baseKey]: camera },
  });
  const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  const rendered = render(
    <ResourceCanvas
      api={api}
      context={{ kind: "entry", entry: resourceFixture.projectOneRef }}
      initialSkillCopy={{
        ref: { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "compare-review" },
        relativePath: ".claude/skills/review/SKILL.md",
      }}
      onEnsureGrant={async () => "grant"}
      onNavigate={vi.fn()}
      onNavigateDestination={vi.fn()}
      onRefresh={vi.fn()}
      session={session}
      snapshot={fixture}
    />,
  );
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  };
  try {
    await act(settle);
    const originalTrigger = rendered.container.querySelector<HTMLButtonElement>(".canvas-search-trigger");
    expect(originalTrigger).toBeDefined();
    const location = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Location"]');
    expect(location?.options.length).toBe(2);
    await act(async () => {
      location!.value = location!.options[1]!.value;
      location!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const filesTab = [...rendered.container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")].find(
      (button) => button.textContent === "Files",
    );
    act(() => filesTab?.click());
    const readerState = session.read(baseKey);
    const compareButton = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Compare and manage",
    );
    await act(async () => {
      compareButton?.click();
      await settle();
    });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="skill-copies-sheet"]')?.hasAttribute("inert")).toBe(true);
    expect(session.read(baseKey)).toEqual(readerState);

    const back = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Back to copies",
    );
    act(() => back?.click());
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).toBeNull();
    expect(rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Location"]')?.value).toBe(
      location!.options[1]!.value,
    );
    expect(
      [...rendered.container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")]
        .find((button) => button.textContent === "Files")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    expect(document.activeElement).toBe(compareButton);
    expect(session.read(baseKey)).toEqual(readerState);

    await act(async () => {
      compareButton?.click();
      await settle();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(rendered.container.querySelector('[data-testid="skill-copies-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(originalTrigger);
    expect(session.read(baseKey)).toEqual(readerState);
  } finally {
    act(() => rendered.root.unmount());
    requestAnimationFrame.mockRestore();
  }
});
