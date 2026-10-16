// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createResourceCatalogue, type ResourceRef } from "../../src/domain/resource-catalogue";
import { ResourceSheet } from "../../src/renderer/canvas/ResourceSheet";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";
import type { SkillPreview } from "../../src/shared/skill-management-ipc";
import type { SkillPropagationTarget } from "../../src/shared/skill-propagation-ipc";
import { snapshot, skillRef, sourceRefResource } from "../fixtures/resource-catalogue";

const source = { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" };
const location = { projectId: "project-one", harnessId: "codex" as const, folderPath: ".agents/skills/review" };
function preview(states: readonly SkillPropagationTarget["state"][]): SkillPreview {
  return {
    status: "ready",
    intentId: "maintenance",
    planId: "maintenance-plan",
    effectFingerprint: "a".repeat(64),
    scope: { sourceId: source.sourceId, packageId: source.packageId, targets: [] },
    steps: [],
    propagation: {
      mode: "maintain-current",
      source,
      targets: states.map((state, index) => ({
        skillId: `skill-${index}`,
        location: { ...location, projectId: `project-${index}` },
        state,
      })),
    },
  };
}

describe("marketplace skill maintenance entry", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));
  function api(result: SkillPreview): DesktopApi {
    return { previewSkillOperation: vi.fn().mockResolvedValue(result) } as unknown as DesktopApi;
  }
  async function sheet(
    service: DesktopApi,
    ref: ResourceRef = skillRef,
    language: "en" | "fr" = "en",
    onOpenMaintenance = vi.fn(),
  ): Promise<void> {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage={language}>
          <ResourceSheet
            api={service}
            details={createResourceCatalogue(snapshot).inspect(ref)!}
            snapshot={snapshot}
            onEnsureGrant={vi.fn()}
            onClose={vi.fn()}
            onOpenChanges={vi.fn()}
            onOpenRemoval={vi.fn()}
            onOpenMaintenance={onOpenMaintenance}
          />
        </I18nProvider>,
      ),
    );
  }
  it("counts eligible copies across logical skills and opens source maintenance", async () => {
    const service = api(preview(["eligible", "eligible", "retained-local", "already-current", "unavailable"]));
    const open = vi.fn();
    await sheet(service, skillRef, "en", open);
    const button = container.querySelector<HTMLButtonElement>("[data-testid='update-linked-copies']");
    expect(button?.textContent).toBe("Update linked copies (2)");
    expect(service.previewSkillOperation).toHaveBeenCalledWith({ intent: { kind: "maintain-current", source } });
    act(() => button?.click());
    expect(open).toHaveBeenCalledWith({ kind: "maintain-current", source });
  });
  it.each(["current", "already-current", "retained-local", "withheld", "unavailable"] as const)(
    "hides maintenance for %s copies",
    async (state) => {
      await sheet(api(preview([state])));
      expect(container.querySelector("[data-testid='update-linked-copies']")).toBeNull();
    },
  );
  it("keeps marketplace overview actions free of skill-specific maintenance", async () => {
    const service = api(preview(["eligible"]));
    await sheet(service, sourceRefResource);
    expect(service.previewSkillOperation).not.toHaveBeenCalled();
    expect(container.textContent).toContain("New skill draft");
    expect(container.querySelector("[data-testid='update-linked-copies']")).toBeNull();
  });
  it("uses the French label and hides the action when evidence cannot be read", async () => {
    const service = api(preview(["eligible"]));
    await sheet(service, skillRef, "fr");
    expect(container.textContent).toContain("Mettre à jour les copies liées (1)");
    vi.mocked(service.previewSkillOperation!).mockRejectedValue(new Error("Unavailable"));
    await sheet({ ...service }, skillRef, "fr");
    expect(container.querySelector("[data-testid='update-linked-copies']")).toBeNull();
  });
  it("opens the existing propagation workbench from the canvas skill sheet", async () => {
    const service = api(preview(["eligible"]));
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={service}
            context={skillRef}
            snapshot={snapshot}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Overview")
        ?.click(),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='update-linked-copies']")?.click());
    expect(container.querySelector("[data-testid='changes-workbench']")).not.toBeNull();
    expect(service.previewSkillOperation).toHaveBeenLastCalledWith({ intent: { kind: "maintain-current", source } });
  });
});
