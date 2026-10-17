// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { AgentStatus } from "../../src/shared/agents-ipc";
import type { Settings, SettingsSetRequest } from "../../src/shared/settings-ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import {
  createCanvasRoot,
  setupInputs,
  resourceSnapshot,
  registryView,
  project,
  source,
} from "./workspace-setup-fixtures";

let rendered: ReturnType<typeof createCanvasRoot>;
let settings: Settings;
let status: AgentStatus;
const getSettings = vi.fn(async () => settings);
const setSettings = vi.fn(async (request: SettingsSetRequest) => {
  settings = { ...settings, workspaceSetupHidden: request.workspaceSetupHidden };
  return settings;
});
const getAgentStatus = vi.fn(async () => status);
const api = { readArtifact: vi.fn(), getSettings, setSettings, getAgentStatus };
const listeners = new Set<() => void>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rendered = createCanvasRoot();
  vi.clearAllMocks();
  listeners.clear();
  settings = {
    schemaVersion: 8,
    git: { commitChanges: true },
    agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: { warnProjectIds: [] } },
    ai: DEFAULT_AI_SETTINGS,
    features: DEFAULT_FEATURES,
    externalLibrary: { updates: "auto" },
  };
  status = { socketPath: "socket", tokenCreatedAt: "now", counts: { pending: 0, today: 0, total: 0 }, harnesses: [] };
});
afterEach(() => {
  act(() => rendered.root.unmount());
  vi.restoreAllMocks();
});

async function render(
  snapshot = resourceSnapshot(registryView()),
  available = true,
  registryLoading = false,
): Promise<void> {
  const setup = setupInputs({ snapshot, ...(available ? {} : { api: null }) });
  await act(async () =>
    rendered.root.render(
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          api={{
            ...api,
            onReviewChanged: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          }}
          context={{ kind: "workspace" }}
          snapshot={snapshot}
          setup={setup}
          registryLoading={registryLoading}
          onEnsureGrant={vi.fn(async () => null)}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
}
async function click(selector: string): Promise<void> {
  const button = rendered.container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}
function harness(registered = false, detected = true): AgentStatus["harnesses"][number] {
  return {
    harness: "codex",
    detected,
    registered,
    current: registered,
    skills: [],
    guard: false,
    settingsPath: "settings",
    skillsPath: "skills",
  };
}

function mapPositions(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...rendered.container.querySelectorAll<HTMLElement>(".canvas-node-row, .workspace-setup-center")].map((node) => [
      node.dataset.nodeId ?? (node.classList.contains("workspace-setup-center") ? "center" : "agents"),
      node.style.cssText,
    ]),
  );
}

function expectOmniLandmark(): void {
  const center = rendered.container.querySelector<HTMLElement>(".workspace-setup-center");
  expect(center?.getAttribute("role")).toBe("img");
  expect(center?.getAttribute("aria-label")).toBe("Omni");
  expect(center?.tabIndex).toBe(-1);
  expect(center?.querySelector("button, a, [tabindex]")).toBeNull();
}

it("welcomes an empty workspace with three places, ordered actions and only the first step solid", async () => {
  status = { ...status, harnesses: [harness()] };
  await render();
  expect(rendered.container.querySelector("h1")?.textContent).toBe("Welcome to Omni");
  expect(rendered.container.querySelector(".canvas-stage .stage-title")).toBeNull();
  expect(rendered.container.querySelectorAll("[data-setup-step]")).toHaveLength(3);
  expect(rendered.container.querySelector("[data-setup-step='marketplace']")?.getAttribute("data-current")).toBe(
    "true",
  );
  expect(rendered.container.querySelectorAll("[data-current='true']")).toHaveLength(1);
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")?.textContent).toContain("0 of 3");
  expect(
    [...rendered.container.querySelectorAll(".workspace-setup-place button")].map((button) => button.textContent),
  ).toEqual(["Create my marketplace", "Connect existing", "Add a project", "Connect agents"]);
  expect(rendered.container.querySelectorAll(".workspace-setup-agent-chip")).toHaveLength(1);
  expect(rendered.container.querySelector(".workspace-setup-agent-chip")?.textContent).toBe("Codex");
  expect(rendered.container.querySelector("[data-external-library=true]")).toBeNull();
});

it("replaces the marketplace place with its real node and shows compact progress", async () => {
  const mine = source("mine", "My skills");
  await render(resourceSnapshot(registryView([], [mine])));
  expect(rendered.container.querySelector("h1")).toBeNull();
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")?.textContent).toContain(
    "Setup · 1 of 3",
  );
  expect(rendered.container.querySelector("[data-setup-step=marketplace]")).toBeNull();
  expect(rendered.container.querySelector("[data-testid=canvas-entry-source-mine]")).not.toBeNull();
  expect(rendered.container.querySelector("[data-setup-step=project]")?.getAttribute("data-current")).toBe("true");
});

it("allows projects and agents before a marketplace and completes without welcome remnants", async () => {
  const app = project("app");
  status = { ...status, harnesses: [harness(true)] };
  await render(resourceSnapshot(registryView([app])));
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")?.textContent).toContain("2 of 3");
  expect(rendered.container.querySelectorAll("[data-setup-step]")).toHaveLength(1);
  expect(rendered.container.querySelector("[data-testid=canvas-entry-project-app]")).not.toBeNull();
  expect(rendered.container.querySelector("[data-testid=workspace-connected-agents]")?.textContent).toContain("Codex");
  const positions = mapPositions();
  await render(resourceSnapshot(registryView([app], [source("mine", "My skills")])));
  expect(mapPositions()).not.toEqual(positions);
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")).toBeNull();
  expect(rendered.container.querySelector(".workspace-setup-center")).toBeNull();
  expect(rendered.container.querySelector(".stage-title")?.textContent).toBe("Workspace");
  expect(rendered.container.querySelector("[data-setup-step]")).toBeNull();
  expect(rendered.container.querySelectorAll(".canvas-wire")).toHaveLength(1);
  expect(rendered.container.querySelector(".canvas-wire[data-dashed=true]")).toBeNull();
});

it("switches layout once on completion and keeps it fixed on later reads", async () => {
  vi.spyOn(HTMLDivElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockReturnValue(838);
  const snapshot = resourceSnapshot(registryView([project("app")], [source("mine", "My skills")]));
  await render(snapshot);
  const before = mapPositions();
  const camera = rendered.container.querySelector<HTMLElement>(".canvas-world")?.style.transform;
  status = { ...status, harnesses: [harness(true)] };
  await act(async () => listeners.forEach((listener) => listener()));
  expect(mapPositions()).not.toEqual(before);
  expect(rendered.container.querySelector<HTMLElement>(".workspace-connected-agents")?.style.top).toBe("-36px");
  const completed = mapPositions();
  await act(async () => listeners.forEach((listener) => listener()));
  expect(mapPositions()).toEqual(completed);
  expect(rendered.container.querySelector<HTMLElement>(".canvas-world")?.style.transform).toBe(camera);
  expect(rendered.container.querySelector(".workspace-setup-header")).toBeNull();
  expect(rendered.container.querySelector(".workspace-setup-center")).toBeNull();
});

it("does not count archived entries, storefronts, external sources or detection alone as done", async () => {
  status = { ...status, harnesses: [harness()] };
  await render(
    resourceSnapshot(
      registryView(
        [{ ...project("old"), archivedAt: "yesterday" }],
        [
          { ...source("store", "Store"), role: "storefront" },
          source("external", "External", "external"),
          { ...source("old", "Old"), archivedAt: "yesterday" },
        ],
      ),
    ),
  );
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")?.textContent).toContain("0 of 3");
});

it("hides setup durably, keeps real nodes, and restores it from Help", async () => {
  status = { ...status, harnesses: [harness(true)] };
  const snapshot = resourceSnapshot(registryView([project("app")]));
  await render(snapshot);
  const positions = mapPositions();
  await click("[data-testid=workspace-setup-hide]");
  expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ workspaceSetupHidden: true }));
  expect(rendered.container.querySelector("[data-setup-step]")).toBeNull();
  expect(rendered.container.querySelector("[data-testid=canvas-entry-project-app]")).not.toBeNull();
  expect(mapPositions()).not.toEqual(positions);
  expect(rendered.container.querySelector(".workspace-setup-center")).toBeNull();
  expect(rendered.container.querySelector(".workspace-setup-header")).toBeNull();
  expect(rendered.container.querySelector(".stage-title")?.textContent).toBe("Workspace");
  expect(rendered.container.querySelectorAll(".canvas-wire")).toHaveLength(1);
  expect(rendered.container.querySelector(".canvas-wire[data-dashed=true]")).toBeNull();
  await act(async () => rendered.root.unmount());
  rendered = createCanvasRoot();
  await render(snapshot);
  expect(rendered.container.querySelector("[data-setup-step]")).toBeNull();
  await click(".canvas-header-actions button[aria-pressed]");
  await click("[data-testid=workspace-setup-show]");
  expect(settings.workspaceSetupHidden).toBe(false);
  expect(rendered.container.querySelectorAll("[data-setup-step]")).toHaveLength(1);
  expect(mapPositions()).toEqual(positions);
  expectOmniLandmark();
});

it("retains the map and reports a failed Hide instead of pretending it persisted", async () => {
  await render(resourceSnapshot(registryView([project("app")])));
  setSettings.mockRejectedValueOnce(new Error("Unavailable"));
  await click("[data-testid=workspace-setup-hide]");
  expect(rendered.container.querySelectorAll("[data-setup-step]")).toHaveLength(2);
  expect(rendered.container.querySelector("[role=alert]")?.textContent).toContain("setup");
});

it("opens the create, connect, project and agent flows directly", async () => {
  await render();
  await click("[data-testid=workspace-setup-create-marketplace]");
  expect(rendered.container.querySelector("[data-testid=canvas-setup-choice-create]")).toBeNull();
  expect(rendered.container.querySelector(".canvas-setup-form")).not.toBeNull();
  await click(".sh-close");
  await click("[data-testid=workspace-setup-connect-marketplace]");
  expect(rendered.container.querySelector("[data-testid=canvas-setup-connect-source]")).not.toBeNull();
  expect(
    rendered.container.querySelector("[data-testid=canvas-setup-choice-existing]")?.getAttribute("aria-pressed"),
  ).toBe("true");
  await click(".sh-close");
  await click("[data-testid=workspace-setup-project]");
  expect(rendered.container.querySelector("[data-testid=canvas-setup-inspect-project]")).not.toBeNull();
  await click(".sh-close");
  await click("[data-testid=workspace-setup-agents]");
  expect(rendered.container.querySelector("[data-testid=settings-agents]")).not.toBeNull();
});

it("keeps all setup actions disabled with an explanation when setup is unavailable", async () => {
  await render(undefined, false);
  const buttons = [...rendered.container.querySelectorAll<HTMLButtonElement>(".workspace-setup-place button")];
  expect(buttons).toHaveLength(4);
  expect(buttons.every((button) => button.disabled && button.title.includes("unavailable"))).toBe(true);
});

it("shows matching loading geometry before the registry arrives", async () => {
  await render(undefined, true, true);
  expect(rendered.container.querySelector("h1")).toBeNull();
  expect(rendered.container.querySelectorAll(".workspace-setup-place.is-loading")).toHaveLength(3);
  const positions = [...rendered.container.querySelectorAll<HTMLElement>(".workspace-setup-place")].map(
    (place) => place.style.cssText,
  );
  await render();
  expect(
    [...rendered.container.querySelectorAll<HTMLElement>(".workspace-setup-place")].map((place) => place.style.cssText),
  ).toEqual(positions);
});

it("rereads the existing agent status when a setup operation changes Review", async () => {
  await render();
  status = { ...status, harnesses: [harness(true)] };
  await act(async () => listeners.forEach((listener) => listener()));
  expect(rendered.container.querySelector("[data-setup-step=agents]")).toBeNull();
  expect(rendered.container.querySelector("[data-testid=workspace-setup-progress]")?.textContent).toContain("1 of 3");
});
