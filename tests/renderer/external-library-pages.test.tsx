// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderExternal, openLibrary, click } from "./external-library-fixture";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));

it("opens the library and a source as pages with used, unused and removed skill nodes", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-library-sheet"]')).toBeNull();
  expect(container.querySelector('[data-external-skill="old-tool"]')).not.toBeNull();
  await click(container, "mattpocock/skills");
  expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-source-sheet"]')).toBeNull();
  expect(container.querySelector('[data-external-skill="fresh-tool"]')?.classList.contains("is-unused")).toBe(true);
  expect(container.textContent).toContain("Retirés de la source, encore dans vos projets");
  expect(container.querySelector(".canvas-breadcrumbs")?.textContent).toContain(
    "Bibliothèque externe/mattpocock/skills",
  );
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  expect(api.readExternalSource).toHaveBeenCalledTimes(2);
});
it("hides archived external project uses from library chips and installed counts", async () => {
  await renderExternal(root, { archivedProject: true });
  await openLibrary(container);
  expect(container.querySelector('[data-testid="external-library-page"]')?.textContent).not.toContain("Project One");
  await click(container, "mattpocock/skills");
  await act(async () => container.querySelector<HTMLElement>('[data-external-skill="grill-me"] .canvas-node')!.click());
  const sheet = container.querySelector('[data-testid="external-skill-sheet"]')!;
  expect(sheet.querySelector("h3")?.textContent).toContain("Installé dans · 0");
  expect(sheet.querySelector('[data-project-id="project-one"]')).toBeNull();
});

it("opens one skill with inline projects and passes the named selection to the guarded install flow", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await act(async () =>
    container.querySelector<HTMLElement>('[data-external-skill="fresh-tool"] .canvas-node')!.click(),
  );
  const sheet = container.querySelector('[data-testid="external-skill-sheet"]')!;
  expect(sheet.textContent).toContain("New source skill");
  expect(sheet.textContent).toContain("SKILL.md");
  expect(sheet.textContent).toContain("name: fresh-tool");
  expect(api.readProjectSkills).not.toHaveBeenCalled();
  await act(async () => sheet.querySelector<HTMLInputElement>("[data-project-id] input")!.click());
  await click(sheet, "Installer dans Project One");
  expect(container.querySelector('[data-testid="external-install-sheet"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-install-sheet"] input')?.getAttribute("disabled")).toBeNull();
  expect(api.previewSkillOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: expect.objectContaining({
        kind: "install-external-skill",
        targets: [expect.objectContaining({ projectId: "project-one" })],
      }),
    }),
  );
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});

it("retains Mac discovery across library and Add-sheet navigation", async () => {
  const { api } = await renderExternal(root);
  for (let round = 0; round < 3; round++) {
    await openLibrary(container);
    await click(container, "＋ Ajouter une source");
    await click(container, "Fermer");
    await click(container, "Espace de travail");
  }
  expect(api.discoverExternalSource).toHaveBeenCalledTimes(2);
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
});

it("finds library pages and external skills from the toolbar and lands on a source with its skill open", async () => {
  await renderExternal(root);
  await act(async () => container.querySelector<HTMLButtonElement>(".canvas-search-trigger")!.click());
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fresh-tool");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const choice = container.querySelector<HTMLButtonElement>('[role="option"]');
  expect(choice?.textContent).toContain("fresh-tool");
  await act(async () => choice!.click());
  expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-skill-sheet"]')?.textContent).toContain("New source skill");
});
it("keeps installed inline targets checked and disabled without reading projects", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await act(async () => container.querySelector<HTMLElement>('[data-external-skill="grill-me"] .canvas-node')!.click());
  const target = container.querySelector<HTMLInputElement>(
    '[data-testid="external-skill-sheet"] [data-project-id="project-one"] input',
  )!;
  expect(target.checked).toBe(true);
  expect(target.disabled).toBe(true);
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});
it("opens a marketplace page grouped by plugin and keeps the plugin management sheet behind its header action", async () => {
  await renderExternal(root);
  await act(async () => container.querySelector<HTMLElement>('[data-kind="marketplace"] .canvas-node')!.click());
  const page = container.querySelector('[data-testid="marketplace-page"]')!;
  expect(page).not.toBeNull();
  expect(container.querySelector('[data-testid="my-marketplace-sheet"]')).toBeNull();
  expect(page.querySelector('[data-page-section="pstack"]')?.textContent).toContain("review");
  await click(page, "Plugins et vitrines");
  expect(container.querySelector('[data-testid="my-marketplace-sheet"]')).not.toBeNull();
});

it("lands a removed Review item on its source page with the one-skill sheet open", async () => {
  await renderExternal(root);
  await click(container, "À valider");
  await click(container.querySelector('[data-external-review="removed:all"]')!, "Voir");
  expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-skill-sheet"]')?.textContent).toContain("old-tool");
});
it("lands an external History result on its source page with the saved operation sheet open", async () => {
  const { api } = await renderExternal(root, { allFailed: true });
  const history = await api.listOperations();
  const skillManagement = {
    intentId: "intent-failed",
    operationId: "auto-failed",
    status: "failed" as const,
    source: { status: "unchanged" as const, sourceId: "mattpocock/skills" },
    targets: [],
    receiptIds: [],
    issues: [],
    recoveryAvailable: false,
  };
  api.listOperations.mockResolvedValue({ ...history, receipts: [{ ...history.receipts[0]!, skillManagement }] });
  api.readSkillOperationResult.mockResolvedValue({ ...skillManagement, receipts: [] });
  await click(container, "Historique");
  await act(async () => container.querySelector<HTMLButtonElement>(".rail-history-entry")!.click());
  expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
});

it("reopens the same skill after its sheet is closed without reloading the library", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  for (let round = 0; round < 2; round++) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-external-skill="fresh-tool"] .canvas-node')!.click(),
    );
    expect(container.querySelector('[data-testid="external-skill-sheet"]')).not.toBeNull();
    await click(container.querySelector('[data-testid="external-skill-sheet"]')!, "Fermer");
  }
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
});
it("reads the actual source document only when the full-reader action is selected", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-external-skill="fresh-tool"] .canvas-node')!.click(),
  );
  expect(api.readArtifact).not.toHaveBeenCalled();
  await click(container.querySelector('[data-testid="external-skill-sheet"]')!, "Lire le skill en entier");
  expect(api.readExternalSkillDocument).toHaveBeenCalledWith({
    sourceId: "mattpocock/skills",
    skillPath: "skills/fresh-tool",
  });
  expect(api.prepareExternalSkillImport).not.toHaveBeenCalled();
  expect(api.readArtifact).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="page-skill-document"]')?.textContent).toContain("Actual content");
});

it("discards a deferred source document when its viewer closes", async () => {
  const { api } = await renderExternal(root);
  let finish!: (value: Awaited<ReturnType<typeof api.readExternalSkillDocument>>) => void;
  api.readExternalSkillDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-external-skill="fresh-tool"] .canvas-node')!.click(),
  );
  await click(container.querySelector('[data-testid="external-skill-sheet"]')!, "Lire le skill en entier");
  await click(container.querySelector('[data-testid="page-skill-document"]')!, "Fermer");
  await act(async () => finish({ status: "read", content: "old document", byteLength: 12, truncated: false }));
  expect(api.readArtifact).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="external-skill-sheet"]')).not.toBeNull();
});
it("refreshes Mac discoveries once when the returned Mac list changes", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  expect(api.discoverExternalSource).toHaveBeenCalledTimes(2);
  api.listExternalSourcesOnMac.mockResolvedValue({
    status: "ready",
    marketplaces: [{ id: "commands-only", repo: "fixture/commands" }],
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(api.discoverExternalSource).toHaveBeenCalledTimes(3);
  await click(container, "＋ Ajouter une source");
  expect(api.discoverExternalSource).toHaveBeenCalledTimes(3);
});

it("shows skill-bearing Mac marketplaces as addable nodes and retains command-only entries in Add", async () => {
  await renderExternal(root, { macSkillSource: true });
  await openLibrary(container);
  const mac = container.querySelector('[data-page-section="mac"]')!;
  expect(mac.querySelectorAll(".page-node")).toHaveLength(1);
  expect(mac.textContent).toContain("fixture/mac-skills");
  expect(mac.textContent).not.toContain("fixture/commands");
  await click(mac, "fixture/mac-skills");
  expect(container.querySelector('[data-testid="canvas-setup-sheet"]')?.textContent).toContain(
    "pas de skill (commandes seulement)",
  );
});
