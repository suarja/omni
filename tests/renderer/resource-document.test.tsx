// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResourceDocument } from "../../src/renderer/canvas/use-resource-document";
import type { EntryRef } from "../../src/domain/project-source-registry";
import type { ReadArtifactResponse } from "../../src/shared/artifact-ipc";

const entry: EntryRef = { kind: "source", id: "source-one" };
function Harness(
  props: Readonly<{
    readArtifact: (request: {
      kind: "source";
      id: string;
      grantHandle: string;
      relativePath: string;
    }) => Promise<ReadArtifactResponse>;
    ensure: () => Promise<string | null>;
  }>,
): React.ReactElement {
  const document = useResourceDocument({ api: { readArtifact: props.readArtifact }, onEnsureGrant: props.ensure });
  return (
    <div>
      <button onClick={() => document.read(entry, "README.md")}>read</button>
      <button onClick={document.cancel}>close</button>
      <span data-status={document.state.status}>
        {document.state.status === "result"
          ? `${document.state.document.relativePath}:${document.state.document.response.status}`
          : document.state.status}
      </span>
    </div>
  );
}

describe("resource document reads", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("renews a denied grant once and retries the same qualified path", async () => {
    const readArtifact = vi
      .fn()
      .mockResolvedValueOnce({ status: "denied" })
      .mockResolvedValueOnce({ status: "read", content: "# Safe", byteLength: 6, truncated: false });
    const ensure = vi.fn().mockResolvedValueOnce("expired").mockResolvedValueOnce("fresh");
    await act(async () => root.render(<Harness readArtifact={readArtifact} ensure={ensure} />));
    await act(async () => container.querySelector("button")?.click());
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(readArtifact.mock.calls.map(([request]) => request)).toEqual([
      { ...entry, grantHandle: "expired", relativePath: "README.md" },
      { ...entry, grantHandle: "fresh", relativePath: "README.md" },
    ]);
    expect(container.textContent).toContain("README.md:read");
  });

  it("does not publish an older read after a newer selection completes", async () => {
    let resolveOld!: (value: ReadArtifactResponse) => void;
    let resolveNew!: (value: ReadArtifactResponse) => void;
    const readArtifact = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReadArtifactResponse>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ReadArtifactResponse>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const ensure = vi.fn().mockResolvedValue("grant");
    function Dual(): React.ReactElement {
      const document = useResourceDocument({ api: { readArtifact }, onEnsureGrant: ensure });
      return (
        <div>
          <button onClick={() => document.read(entry, "old.md")}>old</button>
          <button onClick={() => document.read(entry, "new.md")}>new</button>
          <span>
            {document.state.status === "result" ? document.state.document.relativePath : document.state.status}
          </span>
        </div>
      );
    }
    await act(async () => root.render(<Dual />));
    await act(async () => {
      container.querySelectorAll("button")[0]?.click();
      await Promise.resolve();
      container.querySelectorAll("button")[1]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveNew({ status: "read", content: "new", byteLength: 3, truncated: false });
      await Promise.resolve();
    });
    await act(async () => {
      resolveOld({ status: "read", content: "old", byteLength: 3, truncated: false });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("new.md");
    expect(container.textContent).not.toContain("old.md");
  });

  it("cancels a pending read when the sheet closes", async () => {
    let resolve!: (value: ReadArtifactResponse) => void;
    const readArtifact = vi.fn(
      () =>
        new Promise<ReadArtifactResponse>((done) => {
          resolve = done;
        }),
    );
    const ensure = vi.fn().mockResolvedValue("grant");
    await act(async () => root.render(<Harness readArtifact={readArtifact} ensure={ensure} />));
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    await act(async () => container.querySelectorAll("button")[1]?.click());
    await act(async () => {
      resolve({ status: "read", content: "late", byteLength: 4, truncated: false });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("idle");
  });
});

it("keeps an already read document visible while the same path refreshes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const readArtifact = vi
    .fn()
    .mockResolvedValueOnce({ status: "read", content: "# Safe", byteLength: 6, truncated: false })
    .mockImplementationOnce(() => new Promise(() => {}));
  const ensure = vi.fn().mockResolvedValue("grant");
  try {
    await act(async () => root.render(<Harness readArtifact={readArtifact} ensure={ensure} />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("[data-status]")?.textContent).toBe("README.md:read");
    await act(async () => container.querySelector("button")!.click());
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-status]")?.textContent).toBe("README.md:read");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
