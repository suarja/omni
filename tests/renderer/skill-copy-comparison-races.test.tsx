// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ChangesWorkbench } from "../../src/renderer/canvas/changes/ChangesWorkbench";
import type { SkillLocationKey } from "../../src/domain/skill-reconciliation/types";
import type { DesktopApi } from "../../src/shared/ipc";
import type {
  SkillCopyComparisonRequest,
  SkillCopyComparisonResponse,
} from "../../src/shared/skill-copy-comparison-ipc";
import {
  deferred,
  locationA,
  locationB,
  locations,
  readyForRequest,
  ref,
  render,
  revision,
  skillId,
} from "./skill-copy-comparison-fixtures";

test("a stale pair response cannot replace a newer pair", async () => {
  const locationC: SkillLocationKey = {
    projectId: ref.entry.id,
    harnessId: "codex",
    folderPath: ".zeta/skills/review",
  };
  const initial = deferred<SkillCopyComparisonResponse>();
  const latest = deferred<SkillCopyComparisonResponse>();
  const requests: SkillCopyComparisonRequest[] = [];
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>((request) => {
    requests.push(request);
    return requests.length === 1 ? initial.promise : latest.promise;
  });
  const rendered = render(
    <ChangesWorkbench
      api={{ compareSkillCopies: compare }}
      initialLeft={locationB}
      locations={[locationA, locationB, locationC]}
      mode="comparison"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onEnsureGrant={async () => "grant"}
      projectId={ref.entry.id}
      skillId={skillId}
    />,
  );
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  };
  try {
    await act(settle);
    const copyA = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="Copy A"]');
    await act(async () => {
      copyA!.value = JSON.stringify(locationA);
      copyA!.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ a: locationA, b: locationC });
    await act(async () => {
      latest.resolve(readyForRequest(requests[1]!, "latest pair"));
      await settle();
    });
    expect(rendered.container.textContent).toContain("latest pair");
    await act(async () => {
      initial.resolve({ status: "unavailable", reason: "root" });
      await settle();
    });
    expect(rendered.container.textContent).toContain("latest pair");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("file refresh clears failures and retries the exact selected support path", async () => {
  const fileRead = deferred<SkillCopyComparisonResponse>();
  const refresh = deferred<SkillCopyComparisonResponse>();
  const requests: SkillCopyComparisonRequest[] = [];
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>((request) => {
    requests.push(request);
    if (requests.length === 1) return Promise.resolve(readyForRequest(request, "initial file"));
    if (requests.length === 2) return fileRead.promise;
    if (requests.length === 3) return refresh.promise;
    if (requests.length === 4) return Promise.resolve({ status: "unavailable", reason: "read" });
    return Promise.resolve(readyForRequest(request, "retried support"));
  });
  const rendered = render(
    <ChangesWorkbench
      api={{ compareSkillCopies: compare }}
      initialLeft={locationB}
      locations={locations}
      mode="comparison"
      onBack={vi.fn()}
      onClose={vi.fn()}
      onEnsureGrant={async () => "grant"}
      projectId={ref.entry.id}
      skillId={skillId}
    />,
  );
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  };
  try {
    await act(settle);
    const supportFile = [...rendered.container.querySelectorAll<HTMLButtonElement>(".changes-comparison-file")].find(
      (button) => button.textContent?.includes("guides/only-a.md"),
    );
    await act(async () => {
      supportFile!.click();
      await settle();
    });
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(".changes-actions .changes-secondary")!.click();
      await settle();
    });
    expect(requests[2]?.filePath).toBe("guides/only-a.md");
    await act(async () => {
      refresh.resolve(readyForRequest(requests[2]!, "fresh support"));
      await settle();
    });
    await act(async () => {
      fileRead.resolve(readyForRequest(requests[1]!, "stale support"));
      await settle();
    });
    expect(rendered.container.textContent).toContain("fresh support");
    expect(rendered.container.textContent).not.toContain("stale support");

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(".changes-actions .changes-secondary")!.click();
      await settle();
    });
    expect(requests[3]?.filePath).toBe("guides/only-a.md");
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("fresh support");
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(".changes-actions .changes-secondary")!.click();
      await settle();
    });
    expect(requests[4]?.filePath).toBe("guides/only-a.md");
    expect(rendered.container.textContent).toContain("retried support");
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("closing the comparison invalidates a pending response", async () => {
  const pending = deferred<SkillCopyComparisonResponse>();
  const request = deferred<SkillCopyComparisonRequest>();
  const compare = vi.fn<NonNullable<DesktopApi["compareSkillCopies"]>>(async (input) => {
    request.resolve(input);
    return pending.promise;
  });
  function Closeable(): ReactElement | null {
    const [open, setOpen] = useState(true);
    return open ? (
      <ChangesWorkbench
        api={{ compareSkillCopies: compare }}
        initialLeft={locationB}
        locations={locations}
        mode="comparison"
        onBack={vi.fn()}
        onClose={() => setOpen(false)}
        onEnsureGrant={async () => "grant"}
        projectId={ref.entry.id}
        skillId={skillId}
      />
    ) : null;
  }
  const rendered = render(<Closeable />);
  try {
    await act(async () => {
      await request.promise;
    });
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Close comparison"]')?.click());
    expect(rendered.container.querySelector('[data-testid="skill-copy-comparison-workbench"]')).toBeNull();
    await act(async () => {
      pending.resolve(readyForRequest(await request.promise, "late response"));
      await Promise.resolve();
    });
    expect(rendered.container.querySelector('[data-testid="skill-copy-comparison-workbench"]')).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});
