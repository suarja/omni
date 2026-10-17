// @vitest-environment jsdom

import { act } from "react";
import { type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCanvasRoot,
  project,
  registryView,
  renderResourceCanvas,
  resourceSnapshot,
  setupInputs,
  source,
} from "./workspace-setup-fixtures";

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLDivElement, selector: string): void {
  act(() => container.querySelector<HTMLButtonElement>(selector)?.click());
}

describe("workspace setup recovery", () => {
  let rendered: Readonly<{ container: HTMLDivElement; root: Root }>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rendered = createCanvasRoot();
  });

  afterEach(() => {
    act(() => rendered.root.unmount());
    vi.restoreAllMocks();
  });

  it("treats picker cancellation as no registration and no scan", async () => {
    const setup = setupInputs();
    const registerSource = vi.spyOn(setup.commands, "registerSource").mockResolvedValue({ status: "cancelled" });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-connect-marketplace']");
    click(rendered.container, "[data-testid='canvas-setup-choice-external']");
    click(rendered.container, "[data-testid='canvas-setup-connect-source']");
    await flush();
    expect(registerSource).toHaveBeenCalledWith("external");
    expect(rendered.container.querySelector("[data-testid='canvas-setup-registration-result']")).toBeNull();
    expect(setup.commands.refreshRegistry).not.toHaveBeenCalled();
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();
  });

  it("requires explicit choice before reading a folder with an ownership conflict", async () => {
    const existing = source("already-personal", "Shared Marketplace", "personal");
    const setup = setupInputs({ snapshot: resourceSnapshot(registryView([], [existing])) });
    const registerSource = vi.spyOn(setup.commands, "registerSource").mockResolvedValue({
      status: "classification-conflict",
      entry: existing,
      requestedOwnership: "external",
    });
    const observeEntry = vi.spyOn(setup.commands, "observeEntry");
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='canvas-setup-menu-trigger']");
    const addMarketplace = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='canvas-setup-add-marketplace']",
    );
    await act(async () => addMarketplace?.click());
    click(rendered.container, "[data-testid='canvas-setup-choice-external']");
    click(rendered.container, "[data-testid='canvas-setup-connect-source']");
    await flush();
    expect(registerSource).toHaveBeenCalledWith("external");
    expect(rendered.container.textContent).toContain("already registered with another ownership type");
    expect(observeEntry).not.toHaveBeenCalled();

    const readExisting = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Read the already-connected folder"),
    );
    await act(async () => readExisting?.click());
    await flush();
    expect(observeEntry).toHaveBeenCalledWith({ kind: "source", id: "already-personal" });
  });

  it("offers registry refresh for revision conflicts without repeating registration", async () => {
    const setup = setupInputs();
    const registerProject = vi.spyOn(setup.commands, "registerProject").mockResolvedValue({
      status: "revision-conflict",
      expected: 1,
      actual: 2,
    });
    const refreshRegistry = vi.spyOn(setup.commands, "refreshRegistry").mockResolvedValue({
      status: "ready",
      registry: registryView(),
    });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-project']");
    click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
    await flush();
    click(rendered.container, "[data-testid='canvas-setup-register-project']");
    await flush();
    expect(rendered.container.textContent).toContain("registry changed during setup");
    click(rendered.container, "[data-testid='canvas-setup-refresh-conflict']");
    await flush();
    expect(refreshRegistry).toHaveBeenCalledTimes(1);
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();
  });

  it("keeps a denied read as a registered entry with an explicit retry", async () => {
    const entry = source("denied-source", "Needs permission");
    const availableSnapshot = resourceSnapshot(registryView([], [entry]));
    const deniedSnapshot = {
      ...availableSnapshot,
      roots: availableSnapshot.roots.map((root) => ({
        ...root,
        evidence: { status: "unavailable" as const, reason: "denied" as const },
      })),
    };
    const setup = setupInputs();
    vi.spyOn(setup.commands, "registerSource").mockResolvedValue({
      status: "ready",
      outcome: "existing",
      entry,
      grantHandle: "grant",
      registryRevision: 2,
    });
    const observeEntry = vi.spyOn(setup.commands, "observeEntry").mockResolvedValue(undefined);
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-connect-marketplace']");
    click(rendered.container, "[data-testid='canvas-setup-choice-existing']");
    click(rendered.container, "[data-testid='canvas-setup-connect-source']");
    await flush();
    await act(async () => renderResourceCanvas(rendered.root, { ...setup, snapshot: deniedSnapshot }));
    await flush();
    expect(observeEntry).toHaveBeenCalledWith({ kind: "source", id: "denied-source" });
    expect(rendered.container.textContent).toContain("Check its access and retry the read");
    expect(rendered.container.querySelector("[data-testid='canvas-setup-retry-read']")).not.toBeNull();
  });

  it("reports registration transport failures without inventing a resource", async () => {
    const setup = setupInputs();
    const registerProject = vi
      .spyOn(setup.commands, "registerProject")
      .mockRejectedValue(new Error("private transport data"));
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-project']");
    click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
    await flush();
    click(rendered.container, "[data-testid='canvas-setup-register-project']");
    await flush();
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain("folder could not be registered");
    expect(rendered.container.textContent).not.toContain("private transport data");
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();
  });

  it("refreshes only registry state, then offers an explicit read retry when evidence is absent", async () => {
    const setup = setupInputs();
    const projectEntry = project("project-late");
    const registerProject = vi.spyOn(setup.commands, "registerProject").mockResolvedValue({
      status: "ready",
      outcome: "created",
      entry: projectEntry,
      grantHandle: "grant",
      registryRevision: 2,
    });
    const refreshRegistry = vi.spyOn(setup.commands, "refreshRegistry").mockResolvedValue({
      status: "ready",
      registry: registryView([projectEntry]),
    });
    const observeEntry = vi.spyOn(setup.commands, "observeEntry").mockResolvedValue(undefined);
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-project']");
    click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
    await flush();
    click(rendered.container, "[data-testid='canvas-setup-register-project']");
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-refresh-registry']")).not.toBeNull();
    click(rendered.container, "[data-testid='canvas-setup-refresh-registry']");
    await flush();
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(refreshRegistry).toHaveBeenCalledTimes(1);
    expect(observeEntry).not.toHaveBeenCalled();

    await act(async () =>
      renderResourceCanvas(rendered.root, { ...setup, snapshot: resourceSnapshot(registryView([projectEntry])) }),
    );
    await flush();
    expect(observeEntry).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector("[data-testid='canvas-setup-retry-read']")).not.toBeNull();
    click(rendered.container, "[data-testid='canvas-setup-retry-read']");
    await flush();
    expect(observeEntry).toHaveBeenCalledTimes(2);
    expect(registerProject).toHaveBeenCalledTimes(1);
  });

  it("leaves a late inspection unregistered after the sheet is cancelled", async () => {
    const setup = setupInputs();
    const inspection = deferred<Awaited<ReturnType<NonNullable<NonNullable<typeof setup.api>["inspectProject"]>>>>();
    vi.mocked(setup.api!.inspectProject!).mockReturnValue(inspection.promise);
    const registerProject = vi.spyOn(setup.commands, "registerProject");
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='workspace-setup-project']");
    click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
    click(rendered.container, ".add-resource-sheet .sh-close");
    expect(rendered.container.querySelector("[data-testid='canvas-setup-sheet']")).toBeNull();
    await act(async () =>
      inspection.resolve({
        status: "inspected",
        grantHandle: "late-grant",
        displayName: "Late folder",
        displayRoot: "late-folder",
        inventory: {
          rootHandle: "late-grant",
          displayRoot: "late-folder",
          observedAt: "2026-10-12T00:00:00.000Z",
          harnesses: [],
          artifacts: [],
          diagnostics: [],
          gitScopes: [],
        },
      }),
    );
    await flush();
    expect(registerProject).not.toHaveBeenCalled();
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-sheet']")).toBeNull();
  });
});
