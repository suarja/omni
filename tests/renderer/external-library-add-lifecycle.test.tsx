// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CanvasRailProvider } from "../../src/renderer/canvas/rail/rail-context";
import { AddMarketplaceSheet } from "../../src/renderer/canvas/setup/AddMarketplaceSheet";
import { I18nProvider } from "../../src/renderer/i18n";
import { createFixture, click } from "./external-library-fixture";
import { projectSnapshot } from "./project-view-fixture";
import type { ResourceCanvasProps } from "../../src/renderer/canvas/resource-canvas-types";

it("locks marketplace ownership and dismissal while GitHub registration is applying", async () => {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createFixture();
  type Added = Awaited<ReturnType<typeof fixture.api.addExternalSource>>;
  let complete: ((result: Added) => void) | undefined;
  const add = fixture.api.addExternalSource.getMockImplementation()!;
  fixture.api.addExternalSource.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const onApplyingChange = vi.fn();
  const canvas: ResourceCanvasProps = {
    api: fixture.api,
    context: { kind: "workspace" },
    snapshot: projectSnapshot,
    onEnsureGrant: vi.fn(async () => "grant"),
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateDestination: vi.fn(),
  };
  type Props = ComponentProps<typeof AddMarketplaceSheet>;
  const setup = {
    snapshot: projectSnapshot,
    api: fixture.api,
    commands: {},
    registryBusy: false,
    diagnostic: null,
  } as unknown as Props["setup"];
  const state = { ownership: "external", marketplaceMode: "connect", busy: false } as Props["state"];
  const actions = { setOwnership: vi.fn() } as unknown as Props["actions"];
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="fr">
          <CanvasRailProvider canvas={canvas}>
            <AddMarketplaceSheet
              setup={setup}
              state={state}
              actions={actions}
              onClose={vi.fn()}
              onApplyingChange={onApplyingChange}
            />
          </CanvasRailProvider>
        </I18nProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await click(container, "Ajouter");
    expect(onApplyingChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="canvas-setup-choice-existing"]')!.disabled).toBe(
      true,
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Annuler")!
        .disabled,
    ).toBe(true);
  } finally {
    if (complete) await act(async () => complete!(await add({ repository: "mattpocock/skills" })));
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});
