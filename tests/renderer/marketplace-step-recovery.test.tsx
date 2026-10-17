// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createCanvasRoot,
  renderResourceCanvas,
  setupInputs,
  resourceSnapshot,
  registryView,
  project,
  source,
} from "./workspace-setup-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rendered = new Set<ReturnType<typeof createCanvasRoot>>();
afterEach(() => {
  for (const item of rendered) act(() => item.root.unmount());
  rendered.clear();
});

it("explains and offers recovery after a local marketplace was added as an external source", async () => {
  const view = createCanvasRoot();
  rendered.add(view);
  const external = source("own-repo", "Acme skills", "external");
  const setup = setupInputs({ snapshot: resourceSnapshot(registryView([project("app")], [external])) });
  vi.mocked(setup.api!.getAgentStatus!).mockResolvedValue({
    socketPath: "socket",
    tokenCreatedAt: "now",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [
      {
        harness: "codex",
        detected: true,
        registered: true,
        current: true,
        guard: false,
        settingsPath: "config",
        skillsPath: "skills",
        skills: [],
      },
    ],
  });
  vi.mocked(setup.api!.previewOperation!).mockResolvedValue({
    status: "ready",
    plan: {
      planId: "recovery",
      kind: "connect-marketplace",
      displayTarget: "Acme skills",
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
  });
  await act(async () => renderResourceCanvas(view.root, setup));
  const progress = view.container.querySelector("[data-testid=workspace-setup-progress]");
  expect(progress?.textContent).toContain("Setup · 2 of 3 · Next: your marketplace");
  expect(view.container.textContent).toContain("Acme skills was added as an external source");
  const recover = view.container.querySelector<HTMLButtonElement>("[data-testid=workspace-use-marketplace]");
  expect(recover).not.toBeNull();
  const card = view.container.querySelector<HTMLElement>("[data-setup-step=marketplace]")!;
  expect([...card.querySelectorAll("button.is-primary")]).toEqual([recover]);
  const alternatives = card.querySelector(".workspace-setup-place-actions")!;
  expect([...alternatives.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Create my marketplace",
    "Connect existing",
  ]);
  expect(alternatives.querySelector(".is-primary")).toBeNull();
  expect(card.style.minHeight).toBe("");

  await act(async () => view.container.querySelector<HTMLButtonElement>("[data-testid=workspace-setup-next]")!.click());
  expect(document.activeElement?.getAttribute("data-setup-step")).toBe("marketplace");
  vi.mocked(setup.api!.applyOperation!).mockResolvedValue({
    status: "applied",
    receipt: {
      operationId: "recovery",
      kind: "connect-marketplace",
      status: "applied",
      appliedAt: "2026-10-17T12:00:00.000Z",
      displayTarget: "Acme skills",
      actions: [],
      git: { mode: "disabled" },
      registered: { sourceId: "mine" },
    },
  });
  await act(async () => recover!.click());
  const complete = setupInputs({
    ...setup,
    snapshot: resourceSnapshot(
      registryView(
        [project("app")],
        [{ ...external, archivedAt: "2026-10-17T12:00:00.000Z" }, source("mine", "Acme skills")],
      ),
    ),
  });
  await act(async () => renderResourceCanvas(view.root, complete));
  expect(view.container.querySelector("[data-testid=workspace-setup-progress]")).toBeNull();
  expect(view.container.querySelector("[data-setup-step=marketplace]")).toBeNull();
});

function freshView() {
  const view = createCanvasRoot();
  rendered.add(view);
  return view;
}
it.each([false, true])("opens Add Marketplace on the expected tab with a workshop: %s", async (workshop) => {
  const view = freshView();
  const setup = setupInputs({ snapshot: resourceSnapshot(registryView([], workshop ? [source("mine", "Mine")] : [])) });
  await act(async () => renderResourceCanvas(view.root, setup));
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>("[data-testid=canvas-setup-menu-trigger]")!.click(),
  );
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>("[data-testid=canvas-setup-add-marketplace]")!.click(),
  );
  expect(
    view.container
      .querySelector(`[data-testid=canvas-setup-choice-${workshop ? "external" : "existing"}]`)
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});
it.each(["en", "fr"] as const)("names every remaining step in %s and focuses its card", async (language) => {
  for (const remaining of ["marketplace", "project", "agents"] as const) {
    const view = freshView();
    const setup = setupInputs({
      snapshot: resourceSnapshot(
        registryView(
          remaining === "project" ? [] : [project("app")],
          remaining === "marketplace" ? [] : [source("mine", "Mine")],
        ),
      ),
    });
    if (remaining !== "agents")
      vi.mocked(setup.api!.getAgentStatus!).mockResolvedValue({
        socketPath: "socket",
        tokenCreatedAt: "now",
        counts: { pending: 0, today: 0, total: 0 },
        harnesses: [
          {
            harness: "codex",
            detected: true,
            registered: true,
            current: true,
            guard: false,
            settingsPath: "config",
            skillsPath: "skills",
            skills: [],
          },
        ],
      });
    await act(async () => renderResourceCanvas(view.root, setup, language));
    const label =
      language === "en"
        ? { marketplace: "Next: your marketplace", project: "Next: your projects", agents: "Next: your agents" }[
            remaining
          ]
        : {
            marketplace: "Ensuite : votre marketplace",
            project: "Ensuite : vos projets",
            agents: "Ensuite : vos agents",
          }[remaining];
    expect(view.container.querySelector("[data-testid=workspace-setup-next]")?.textContent).toContain(label);
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>("[data-testid=workspace-setup-next]")!.click(),
    );
    expect(document.activeElement?.getAttribute("data-setup-step")).toBe(remaining);
  }
});
it("does not offer an invalid folder or an external source when a workshop exists", async () => {
  for (const workshop of [false, true]) {
    const view = freshView();
    const setup = setupInputs({
      snapshot: resourceSnapshot(
        registryView([], [source("external", "Invalid", "external"), ...(workshop ? [source("mine", "Mine")] : [])]),
      ),
    });
    vi.mocked(setup.api!.previewOperation!).mockResolvedValue({
      status: "blocked",
      reason: "marketplace-not-repository",
      diagnostic: "This folder is not a Git repository root.",
    });
    await act(async () => renderResourceCanvas(view.root, setup));
    expect(view.container.querySelector("[data-testid=workspace-use-marketplace]")).toBeNull();
    if (workshop) expect(setup.api!.previewOperation).not.toHaveBeenCalled();
  }
});
it("applies recovery once and keeps Undo accessible in its result toast", async () => {
  const view = freshView();
  const setup = setupInputs({
    snapshot: resourceSnapshot(registryView([project("app")], [source("own", "Own skills", "external")])),
  });
  vi.mocked(setup.api!.previewOperation!).mockImplementation(async (request) => ({
    status: "ready",
    plan: {
      planId: request.kind === "restore-import" ? "undo" : "connect",
      kind: request.kind === "restore-import" ? "undo-connect-marketplace" : "connect-marketplace",
      displayTarget: "Own skills",
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
  }));
  vi.mocked(setup.api!.applyOperation!).mockImplementation(async (request) => ({
    status: "applied",
    receipt: {
      operationId: request.planId,
      kind: request.planId === "undo" ? "undo-connect-marketplace" : "connect-marketplace",
      status: "applied",
      displayTarget: "Own skills",
      actions: [],
      git: { mode: "disabled" },
      registered: { sourceId: "workshop" },
      appliedAt: "2026-10-17T12:00:00.000Z",
    },
  }));
  let release!: () => void;
  const refreshed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(setup.commands.refreshRegistry).mockImplementationOnce(async () => {
    await refreshed;
    return { status: "ready", registry: registryView() };
  });
  await act(async () => renderResourceCanvas(view.root, setup));
  await act(async () => {
    view.container.querySelector<HTMLButtonElement>("[data-testid=workspace-use-marketplace]")!.click();
    view.container.querySelector<HTMLButtonElement>("[data-testid=workspace-use-marketplace]")!.click();
  });
  expect(setup.api!.applyOperation).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector(".canvas-toast")).toBeNull();
  await act(async () => release());
  const undo = [...view.container.querySelectorAll<HTMLButtonElement>(".canvas-toast button")].find(
    (button) => button.textContent === "Undo",
  );
  expect(undo).toBeDefined();
  await act(async () => undo!.click());
  expect(setup.api!.applyOperation).toHaveBeenLastCalledWith({ planId: "undo" });
  expect(setup.commands.refreshRegistry).toHaveBeenCalledTimes(2);
});
