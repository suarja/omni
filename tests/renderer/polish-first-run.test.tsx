// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { detailsFixture } from "./external-library-fixture";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { vi } from "vitest";
import { projectExternalLibrary } from "../../src/renderer/canvas/external-library/workspace";
import {
  createCanvasRoot,
  renderResourceCanvas,
  setupInputs,
  resourceSnapshot,
  registryView,
  source,
} from "./workspace-setup-fixtures";
let rendered: ReturnType<typeof createCanvasRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rendered = createCanvasRoot();
});
afterEach(() => act(() => rendered.root.unmount()));
it("omits the external library node when no sources exist", () => {
  const result = projectExternalLibrary(
    { key: "workspace", children: [], relations: [], groups: [], center: undefined },
    [],
  );
  expect(result.children).toHaveLength(0);
});
it("opens the first marketplace on the personal tab with first-marketplace wording", async () => {
  await act(async () => renderResourceCanvas(rendered.root, setupInputs()));
  act(() =>
    rendered.container.querySelector<HTMLButtonElement>("[data-testid='workspace-setup-connect-marketplace']")!.click(),
  );
  const personal = rendered.container.querySelector("[data-testid='canvas-setup-choice-existing']")!;
  expect(personal.getAttribute("aria-pressed")).toBe("true");
  expect(personal.textContent).toBe("My first marketplace");
});
it("retains the external default once a personal marketplace exists", async () => {
  const personal = source("mine", "My marketplace");
  await act(async () =>
    renderResourceCanvas(
      rendered.root,
      setupInputs({ snapshot: resourceSnapshot(registryView([], [personal]), [personal.ref]) }),
    ),
  );
  act(() => rendered.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']")!.click());
  act(() =>
    rendered.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")!.click(),
  );
  expect(
    rendered.container.querySelector("[data-testid='canvas-setup-choice-external']")?.getAttribute("aria-pressed"),
  ).toBe("true");
});
it("keeps an empty external library reachable from search and Add", async () => {
  await act(async () => renderResourceCanvas(rendered.root, setupInputs()));
  expect(rendered.container.querySelector("[data-external-library=true]")).toBeNull();
  act(() => rendered.container.querySelector<HTMLButtonElement>(".canvas-search-trigger")!.click());
  expect(
    [...rendered.container.querySelectorAll("[role=option]")].some((option) =>
      option.textContent?.includes("External library"),
    ),
  ).toBe(true);
  act(() => rendered.container.querySelector<HTMLButtonElement>(".sh-close")!.click());
  act(() =>
    rendered.container.querySelector<HTMLButtonElement>("[data-testid='workspace-setup-connect-marketplace']")!.click(),
  );
  act(() =>
    rendered.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-choice-external']")!.click(),
  );
  expect(
    rendered.container.querySelector("[data-testid='canvas-setup-choice-external']")?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("shows the first-marketplace label in French", async () => {
  const setup = setupInputs();
  await act(async () =>
    rendered.root.render(
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          api={null}
          context={{ kind: "workspace" }}
          snapshot={setup.snapshot}
          setup={setup}
          onEnsureGrant={vi.fn(async () => null)}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  act(() =>
    rendered.container.querySelector<HTMLButtonElement>("[data-testid='workspace-setup-connect-marketplace']")!.click(),
  );
  const personal = rendered.container.querySelector("[data-testid='canvas-setup-choice-existing']")!;
  expect(personal.getAttribute("aria-pressed")).toBe("true");
  expect(personal.textContent).toBe("Ma première marketplace");
});
it("removes the synthetic library node again when the last followed source disappears", () => {
  const initial = { key: "workspace", children: [], relations: [], groups: [] };
  const populated = projectExternalLibrary(initial, [detailsFixture().source!]);
  expect(populated.children).toHaveLength(1);
  expect(projectExternalLibrary(populated, []).children).toHaveLength(0);
});
