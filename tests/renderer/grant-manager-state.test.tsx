// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type { DesktopApi } from "../../src/shared/ipc";
import { useGrantManager } from "../../src/renderer/grant-manager";

const binding = (bindingId: string): Binding => ({
  bindingId,
  sourceId: "source-one",
  packageId: "plugin",
  artifactPath: "skills/review",
  kind: "skill",
  projectId: "project-one",
  harnessId: "codex",
  boundHash: "hash",
  createdAt: "2026-10-04T10:00:00.000Z",
});

describe("binding evidence state", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("publishes only the latest binding read and treats API failures as unavailable", async () => {
    const pending: Array<(value: { status: "ready"; bindings: readonly Binding[] }) => void> = [];
    const api = {
      listBindings: vi.fn(
        () => new Promise<{ status: "ready"; bindings: readonly Binding[] }>((resolve) => pending.push(resolve)),
      ),
    } as unknown as DesktopApi;
    let snapshot: ReturnType<typeof useGrantManager>["bindingsSnapshot"];
    let refresh = (): void => undefined;
    function Probe(): null {
      const state = useGrantManager(api, vi.fn());
      snapshot = state.bindingsSnapshot;
      refresh = state.refreshBindings;
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(snapshot!).toEqual({ status: "loading" });
    await act(async () => {
      refresh();
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]({ status: "ready", bindings: [binding("new")] });
    });
    expect(snapshot!).toEqual({ status: "ready", bindings: [binding("new")] });
    await act(async () => {
      pending[0]({ status: "ready", bindings: [binding("stale")] });
    });
    expect(snapshot!).toEqual({ status: "ready", bindings: [binding("new")] });
  });

  it("marks an unavailable bindings API as unavailable instead of loading forever", async () => {
    let snapshot: ReturnType<typeof useGrantManager>["bindingsSnapshot"];
    function Probe(): null {
      snapshot = useGrantManager(null, vi.fn()).bindingsSnapshot;
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(snapshot!).toEqual({ status: "unavailable" });
  });
});
