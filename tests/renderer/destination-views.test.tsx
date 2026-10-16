// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";
import {
  archivedSource,
  artifact,
  audit,
  external,
  inaccessibleSource,
  observation,
  personal,
  project,
  registry,
  render,
  report,
  type Rendered,
} from "./helpers/destination-fixtures";

describe("audit-backed destination views", () => {
  let rendered: Rendered | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("observes the available personal source once when opening it from Library", async () => {
    const api: DesktopApi = {
      listRegistry: vi.fn().mockResolvedValue({ status: "ready", registry: registry() }),
      registerProject: vi.fn(),
      registerSource: vi.fn(),
      archiveEntry: vi.fn(),
      reactivateEntry: vi.fn(),
      openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: personal, grantHandle: "source-grant" }),
      observeProject: vi.fn(),
      observeSource: vi
        .fn()
        .mockResolvedValue({ status: "observed", observation: observation(personal.ref, { artifacts: [artifact] }) }),
    };
    window.omni = api;
    rendered = render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() =>
      rendered?.container
        .querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-personal-source']")
        ?.click(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.openEntry).toHaveBeenCalledOnce();
    expect(api.observeSource).toHaveBeenCalledOnce();
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    expect(rendered.container.textContent).toContain("My Skills");
  });
});
