// @vitest-environment jsdom

import { act } from "react";
import { type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntryRef } from "../../src/domain/project-source-registry";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../src/shared/operations-ipc";
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

describe("workspace setup flow", () => {
  let rendered: Readonly<{ container: HTMLDivElement; root: Root }>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rendered = createCanvasRoot();
  });

  afterEach(() => {
    act(() => rendered.root.unmount());
    vi.restoreAllMocks();
  });

  it.each(["rail", "empty"] as const)(
    "closes the %s project registration result and opens Settings on Agents",
    async (entryPoint) => {
      const personal = source("source-one", "Personal skills");
      const registered = project("project-one", "Demo project");
      const setup = setupInputs({
        snapshot: resourceSnapshot(registryView([], entryPoint === "rail" ? [personal] : [])),
      });
      vi.mocked(setup.commands.registerProject).mockResolvedValue({
        status: "ready",
        outcome: "created",
        entry: registered,
        grantHandle: "picker-grant",
        registryRevision: 2,
      });
      await act(async () => renderResourceCanvas(rendered.root, setup));
      if (entryPoint === "rail") {
        click(rendered.container, "[data-testid='canvas-setup-menu-trigger']");
        click(rendered.container, "[data-testid='canvas-setup-add-project']");
      } else click(rendered.container, "[data-testid='canvas-setup-empty-project']");
      click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
      await flush();
      click(rendered.container, "[data-testid='canvas-setup-register-project']");
      await flush();
      await act(async () =>
        renderResourceCanvas(rendered.root, {
          ...setup,
          snapshot: resourceSnapshot(registryView([registered], [personal]), [registered.ref, personal.ref]),
        }),
      );
      await flush();
      const connect = rendered.container.querySelector<HTMLButtonElement>(
        "[data-testid='canvas-setup-connect-agents']",
      );
      expect(connect).not.toBeNull();
      act(() => connect!.click());
      await flush();
      expect(rendered.container.querySelector("[data-testid='canvas-setup-sheet']")).toBeNull();
      const settings = rendered.container.querySelector("[data-testid='canvas-settings-sheet']");
      expect(settings?.querySelector("[data-testid='settings-agents']")).not.toBeNull();
      expect(settings?.querySelector(".settings-groups")?.firstElementChild?.getAttribute("data-testid")).toBe(
        "settings-agents",
      );
    },
  );

  it.each(["loading", "unobserved"] as const)(
    "shows neutral loading while an otherwise healthy workspace has a %s root",
    async (pending) => {
      const personal = source("source-one", "Personal skills");
      const waiting = project("project-one");
      const registry = registryView([waiting], [personal]);
      await act(async () =>
        renderResourceCanvas(
          rendered.root,
          setupInputs({
            snapshot: resourceSnapshot(registry, [personal.ref], pending === "loading" ? [waiting.ref] : []),
          }),
        ),
      );
      const heading = rendered.container.querySelector(".canvas-stage-heading");
      expect(heading?.textContent).not.toContain("Some locations could not be observed.");
      expect(heading?.textContent).toContain("Loading registered resources");
      await act(async () =>
        renderResourceCanvas(
          rendered.root,
          setupInputs({
            snapshot: resourceSnapshot(registry, [personal.ref, waiting.ref]),
          }),
        ),
      );
      expect(heading?.textContent).not.toContain("Loading registered resources");
      expect(heading?.textContent).not.toContain("Some locations could not be observed.");
    },
  );

  it("keeps a real observation failure visible while another root loads", async () => {
    const personal = source("source-one", "Personal skills");
    const waiting = project("project-one");
    const failed = project("project-failed", "Unreadable project");
    const snapshot = resourceSnapshot(registryView([waiting, failed], [personal]), [personal.ref], [waiting.ref]);
    await act(async () =>
      renderResourceCanvas(
        rendered.root,
        setupInputs({
          snapshot: {
            ...snapshot,
            roots: snapshot.roots.map((root) =>
              root.entry.id === failed.ref.id
                ? { ...root, evidence: { status: "unavailable", reason: "failed" } }
                : root,
            ),
          },
        }),
      ),
    );
    const heading = rendered.container.querySelector(".canvas-stage-heading");
    expect(heading?.textContent).toContain("Some locations could not be observed.");
    expect(heading?.textContent).toContain("Unreadable project");
  });

  it("registers a project, waits for its qualified entry, then requires matching scan evidence", async () => {
    const setup = setupInputs();
    const observed = deferred<void>();
    vi.spyOn(setup.commands, "observeEntry").mockImplementation((_entry: EntryRef) => observed.promise);
    const projectEntry = project("project-one", "Acme Web");
    vi.spyOn(setup.commands, "registerProject").mockResolvedValue({
      status: "ready",
      outcome: "created",
      entry: projectEntry,
      grantHandle: "picker-grant",
      registryRevision: 2,
    });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    expect(rendered.container.querySelector("[data-testid='canvas-setup-empty-marketplace']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-empty-project']")).not.toBeNull();

    click(rendered.container, "[data-testid='canvas-setup-empty-project']");
    click(rendered.container, "[data-testid='canvas-setup-inspect-project']");
    await flush();
    click(rendered.container, "[data-testid='canvas-setup-register-project']");
    await flush();
    expect(setup.commands.registerProject).toHaveBeenCalledTimes(1);
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();

    await act(async () =>
      renderResourceCanvas(rendered.root, { ...setup, snapshot: resourceSnapshot(registryView([projectEntry])) }),
    );
    await flush();
    expect(setup.commands.observeEntry).toHaveBeenCalledWith({ kind: "project", id: "project-one" });
    expect(rendered.container.textContent).toContain("Reading the selected folder");

    await act(async () =>
      renderResourceCanvas(rendered.root, {
        ...setup,
        snapshot: resourceSnapshot(registryView([projectEntry]), [{ kind: "project", id: "project-one" }]),
      }),
    );
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-observed-summary']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-add-marketplace']")).not.toBeNull();

    await act(async () => observed.resolve());
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-observed-summary']")).not.toBeNull();
  });

  it("does not match a similarly named source to a pending connection", async () => {
    const setup = setupInputs();
    const sourceA = source("source-a", "Same marketplace name");
    const sourceB = source("source-b", "Same marketplace name");
    const observed = deferred<void>();
    vi.spyOn(setup.commands, "observeEntry").mockImplementation((_entry: EntryRef) => observed.promise);
    vi.spyOn(setup.commands, "registerSource").mockResolvedValue({
      status: "ready",
      outcome: "created",
      entry: sourceA,
      grantHandle: "picker-grant-a",
      registryRevision: 2,
    });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='canvas-setup-empty-marketplace']");
    click(rendered.container, "[data-testid='canvas-setup-choice-existing']");
    click(rendered.container, "[data-testid='canvas-setup-connect-source']");
    await flush();

    await act(async () =>
      renderResourceCanvas(rendered.root, { ...setup, snapshot: resourceSnapshot(registryView([], [sourceB])) }),
    );
    await flush();
    expect(setup.commands.observeEntry).not.toHaveBeenCalled();

    await act(async () =>
      renderResourceCanvas(rendered.root, {
        ...setup,
        snapshot: resourceSnapshot(registryView([], [sourceA, sourceB])),
      }),
    );
    await flush();
    expect(setup.commands.observeEntry).toHaveBeenCalledTimes(1);
    expect(setup.commands.observeEntry).toHaveBeenCalledWith({ kind: "source", id: "source-a" });

    await act(async () =>
      renderResourceCanvas(rendered.root, {
        ...setup,
        snapshot: resourceSnapshot(registryView([], [sourceA, sourceB]), [{ kind: "source", id: "source-b" }]),
      }),
    );
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-observed-summary']")).toBeNull();
    await act(async () =>
      renderResourceCanvas(rendered.root, {
        ...setup,
        snapshot: resourceSnapshot(registryView([], [sourceA, sourceB]), [
          { kind: "source", id: "source-a" },
          { kind: "source", id: "source-b" },
        ]),
      }),
    );
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-observed-summary']")).not.toBeNull();
    await act(async () => observed.resolve());
  });

  it("opens the agent connection popover from Settings and cancels without a write", async () => {
    const setup = setupInputs({
      snapshot: resourceSnapshot(registryView([project("project-one")], [source("source-one", "Personal skills")])),
    });
    vi.mocked(setup.api!.getAgentStatus!).mockResolvedValue({
      socketPath: "socket",
      tokenCreatedAt: "2026-10-11T00:00:00Z",
      counts: { pending: 0, today: 0, total: 0 },
      harnesses: [
        {
          harness: "claude-code",
          detected: true,
          registered: false,
          current: false,
          guard: false,
          settingsPath: "~/.claude.json",
          skillsPath: "~/.claude/skills",
          skills: [],
        },
      ],
    });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, 'button[aria-label="Settings"]');
    await flush();
    const connect = rendered.container.querySelector<HTMLButtonElement>('[data-agent="claude-code"] button');
    await act(async () => connect?.click());
    const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"].canvas-pop');
    expect(dialog).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="canvas-settings-sheet"]')).not.toBeNull();
    expect(setup.api?.previewOperation).not.toHaveBeenCalled();
    expect(setup.api?.applyOperation).not.toHaveBeenCalled();
    const cancel = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(rendered.container.querySelector(".canvas-pop")).toBeNull();
    expect(rendered.container.querySelector('[data-testid="canvas-settings-sheet"]')).not.toBeNull();
  });

  it("previews exact create effects, applies once, and follows the receipt source identity", async () => {
    const setup = setupInputs();
    const api = setup.api as Required<Pick<DesktopApi, "pickOperationParent" | "previewOperation" | "applyOperation">>;
    const plan: OperationPlan = {
      planId: "marketplace-plan",
      kind: "create-marketplace",
      displayTarget: "Scratch/skills",
      actions: [
        { kind: "create-directory", relativePath: "." },
        { kind: "write-file", relativePath: "marketplace.json", byteLength: 240 },
      ],
      git: { mode: "init-and-commit", warnings: ["Git identity is unavailable."] },
    };
    const receipt: OperationReceipt = {
      operationId: "marketplace-operation",
      kind: "create-marketplace",
      status: "applied",
      appliedAt: "2026-10-04T12:00:00.000Z",
      displayTarget: "Scratch/skills",
      actions: [{ kind: "write-file", relativePath: "marketplace.json", status: "applied" }],
      git: { mode: "init-and-commit" },
      registered: { sourceId: "source-created" },
    };
    vi.spyOn(api, "pickOperationParent").mockResolvedValue({
      status: "picked",
      parentToken: "opaque-parent",
      displayParent: "Scratch",
    });
    vi.spyOn(api, "previewOperation").mockResolvedValue({ status: "ready", plan });
    const applyOperation = vi.spyOn(api, "applyOperation").mockResolvedValue({ status: "applied", receipt });
    const refreshRegistry = vi.spyOn(setup.commands, "refreshRegistry");
    const observeEntry = vi.spyOn(setup.commands, "observeEntry");
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click(rendered.container, "[data-testid='canvas-setup-empty-marketplace']");
    click(rendered.container, "[data-testid='canvas-setup-choice-existing']");
    click(rendered.container, "[data-testid='canvas-setup-choice-create']");
    await flush();
    click(rendered.container, "[data-testid='canvas-setup-marketplace-pick-parent']");
    await flush();
    const preview = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='canvas-setup-marketplace-preview']",
    );
    await act(async () => preview?.click());
    await flush();
    expect(rendered.container.textContent).toContain("Scratch/skills");
    expect(rendered.container.textContent).toContain("Git identity is unavailable.");
    expect(rendered.container.textContent).toContain("marketplace.json");
    click(rendered.container, "[data-testid='canvas-setup-marketplace-apply']");
    await flush();
    expect(applyOperation).toHaveBeenCalledTimes(1);
    expect(applyOperation).toHaveBeenCalledWith({ planId: "marketplace-plan" });
    expect(refreshRegistry).toHaveBeenCalledTimes(1);
    expect(setup.commands.registerSource).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Scratch/skills");
    expect(rendered.container.querySelector("[data-testid='canvas-setup-create-form']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-registration-result'] details")).not.toBeNull();

    const created = source("source-created", "Scratch/skills");
    await act(async () =>
      renderResourceCanvas(rendered.root, { ...setup, snapshot: resourceSnapshot(registryView([], [created])) }),
    );
    await flush();
    expect(observeEntry).toHaveBeenCalledWith({ kind: "source", id: "source-created" });
  });
});
