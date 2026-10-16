// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  renderExternal,
  openSourcePage,
  openExternalSkill,
  openExternalInstall,
  openLibrary,
  click,
  type FixtureOptions,
} from "./external-library-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});
const sheet = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function source(options: FixtureOptions = {}): Promise<Awaited<ReturnType<typeof renderExternal>>> {
  const fixture = await renderExternal(root, options);
  await openLibrary(container);
  await openSourcePage(container);
  return fixture;
}
async function compare(options: FixtureOptions = {}): Promise<Awaited<ReturnType<typeof renderExternal>>> {
  const fixture = await source(options);
  await click(container, "Comparer");
  await click(sheet("external-compare-list"), "Comparer");
  return fixture;
}
async function install(skillName: string): Promise<void> {
  await openExternalInstall(container, skillName);
}
it("counts source changes in the comparison index without including local-only files", async () => {
  await source();
  await click(container, "Comparer");
  const row = [...sheet("external-compare-list").querySelectorAll<HTMLElement>(".external-row")].find(
    (item) => item.querySelector("b")?.textContent === "grill-me",
  )!;
  expect(row.querySelector("small")?.textContent).toContain("2 fichiers changés dans la source");
});
it("requires an explicit choice for both-side files before preview and applies the reviewed fingerprint", async () => {
  const { api } = await compare();
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(sheet("external-update-sheet").textContent).toContain("Garder le mien");
  expect(sheet("external-update-sheet").textContent).toContain("Prendre la source");
  expect(sheet("external-update-sheet").textContent).toContain("modifié ici · conservé");
  await click(container, "Garder le mien");
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
    intent: {
      kind: "merge-external-skill",
      sourceId: "mattpocock/skills",
      useId: "grill-me",
      choices: [{ path: "SKILL.md", choice: "mine" }],
    },
  });
  expect(sheet("external-update-sheet").textContent).toContain("Jamais automatique.");
  await click(container, "Mettre à jour (1)");
  expect(api.applySkillOperation).toHaveBeenCalledWith({ intentId: "intent-1", effectFingerprint: "f".repeat(64) });
  expect(sheet("external-update-sheet").querySelector('[data-testid="changes-result"]')).not.toBeNull();
});
it("opens source-only diffs in the existing viewer while local-only changes remain retained", async () => {
  await compare();
  const row = [...sheet("external-update-sheet").querySelectorAll<HTMLElement>(".external-row")].find(
    (row) => row.querySelector("b")?.textContent === "source.txt",
  )!;
  await click(row, "Voir le diff");
  expect(sheet("external-update-sheet").querySelector(".changes-diff-lines")?.textContent).toContain("new");
  expect(sheet("external-update-sheet").querySelector(".changes-diff-lines")?.textContent).toContain("old");
  expect(sheet("external-update-sheet").textContent).toContain("local.txt");
});
it.each(["Garder ma copie", "Prendre la version de la source"])(
  "offers whole-folder %s only when the base is missing",
  async (label) => {
    const { api } = await compare({ missingBase: true });
    expect(sheet("external-update-sheet").textContent).toContain("Version installée introuvable");
    expect(sheet("external-update-sheet").textContent).not.toContain("Garder le mien");
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    await click(container, label);
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: {
        kind: "merge-external-skill",
        sourceId: "mattpocock/skills",
        useId: "grill-me",
        choices: [],
        wholeCopy: label === "Garder ma copie" ? "mine" : "source",
      },
    });
  },
);
it("keeps preview limited to selected project copies and separates their conflict choices", async () => {
  const { api } = await compare({ twoProjects: true });
  const choices = [...sheet("external-update-sheet").querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Garder le mien",
  );
  await act(async () => choices[0]!.click());
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ useId: "grill-me" }) }),
  );
  const projectChoices = [
    ...sheet("external-update-sheet").querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  await act(async () => projectChoices[1]!.click());
  const second = [...sheet("external-update-sheet").querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Prendre la source",
  )[1]!;
  await act(async () => second.click());
  expect(
    api.previewSkillOperation.mock.calls.some(
      ([request]) => request.intent.kind === "merge-external-skill" && request.intent.useId === "grill-other",
    ),
  ).toBe(true);
});
it("previews ask-mode identical-copy updates through the ordinary update operation", async () => {
  const { api } = await source({ mode: "ask" });
  await click(container, "À valider");
  const row = container.querySelector<HTMLElement>('[data-external-review^="update:"]')!;
  await click(row, "Voir");
  const list = sheet("external-compare-list");
  const update = [...list.querySelectorAll<HTMLElement>(".external-row")].find(
    (row) => row.querySelector("b")?.textContent === "update-tool",
  )!;
  await click(update, "Comparer");
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
    intent: { kind: "update-external-skills", sourceId: "mattpocock/skills", useIds: ["update-tool"] },
  });
});
it("blocks installation on a name conflict until replacement is explicit and includes backup wording", async () => {
  const { api } = await source();
  await install("local-tool");
  const target = sheet("external-install-sheet").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(target.checked).toBe(true);
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(sheet("external-install-sheet").textContent).toContain("a déjà un skill local-tool");
  expect(sheet("external-install-sheet").textContent).toContain("Omni la sauvegarde");
  const replace = [...sheet("external-install-sheet").querySelectorAll<HTMLLabelElement>("label")]
    .find((label) => label.textContent?.includes("Remplacer cette copie"))!
    .querySelector<HTMLInputElement>("input")!;
  await act(async () => replace.click());
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
    intent: expect.objectContaining({
      kind: "install-external-skill",
      skillName: "local-tool",
      conflict: "replace",
      targets: [expect.objectContaining({ harnessIds: ["claude-code", "codex"] })],
    }),
  });
});
it("disables already installed targets and lets agents be selected independently", async () => {
  const { api } = await source();
  await install("grill-me");
  expect(sheet("external-install-sheet").querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(
    true,
  );
  expect(sheet("external-install-sheet").textContent).toContain("déjà installé");
  const choices = [...sheet("external-install-sheet").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(choices[0]!.checked).toBe(true);
  expect(choices[1]!.checked).toBe(true);
  await act(async () => choices[2]!.click());
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
    intent: expect.objectContaining({ targets: [expect.objectContaining({ harnessIds: ["codex"] })] }),
  });
});
it("surfaces an all-failed apply once without presenting it as success or permitting replay", async () => {
  const { api } = await compare({ allFailed: true });
  await click(container, "Prendre la source");
  await click(container, "Mettre à jour (1)");
  expect(sheet("external-update-sheet").querySelector('[data-testid="changes-result"]')?.textContent).toContain(
    "No target applied",
  );
  const apply = [...sheet("external-update-sheet").querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Mettre à jour (1)",
  )!;
  expect(apply.disabled).toBe(true);
  await act(async () => apply.click());
  expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
});
it("retains removed copies while Keep acknowledges only the reviewed use", async () => {
  const { api } = await source();
  await openExternalSkill(container, "old-tool");
  await click(sheet("external-skill-sheet"), "Voir");
  expect(sheet("external-removed-sheet").textContent).toContain("Renamed into better-tool");
  await click(container, "Garder");
  expect(api.acknowledgeRemovedExternalUse).toHaveBeenCalledWith({ useId: "old-tool" });
  expect(api.applySkillOperation).not.toHaveBeenCalled();
  await click(container, "À valider");
  expect(container.querySelectorAll('[data-external-review^="removed:"]')).toHaveLength(0);
});
it("shows modified removed copies with one combined chip", async () => {
  await renderExternal(root, { project: true, modifiedRemoved: true });
  await act(async () => container.querySelector<HTMLElement>('[data-project-group="external"] .canvas-node')!.click());
  const node = container.querySelector('[data-skill-row-id="old-tool"]');
  expect(node?.textContent).toContain("Modifié ici · retiré de la source");
  expect(node?.querySelectorAll(".project-chip.is-removed")).toHaveLength(1);
});

it("opens the added source on unused skills without waiting for an animation frame", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "＋ Ajouter une source");
  const input = container.querySelector<HTMLInputElement>("#external-repository")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture/new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(api.discoverExternalSource).toHaveBeenCalledWith({ repository: "fixture/new" });
  expect(api.addExternalSource).not.toHaveBeenCalled();
  expect(sheet("canvas-setup-sheet").textContent).toContain("Ce qu'Omni a trouvé");
  expect(sheet("canvas-setup-sheet").textContent).toContain("pas de skill (commandes seulement)");
  vi.stubGlobal("requestAnimationFrame", () => 1);
  try {
    await click(sheet("canvas-setup-sheet"), "Ajouter");
  } finally {
    vi.unstubAllGlobals();
  }
  expect(api.addExternalSource).toHaveBeenCalledWith({ repository: "fixture/new" });
  expect(sheet("external-source-page")).not.toBeNull();
  expect(sheet("external-source-page").textContent).toContain("fixture/new");
  expect(container.querySelector(".canvas-toast")?.textContent).toContain(
    "fixture/new ajoutée à la bibliothèque — 1 skill à parcourir",
  );
  expect(
    sheet("external-source-page").querySelector('[data-page-section="unused"] .page-section-title')?.textContent,
  ).toContain("Pas encore utilisés");
});
it("retains the deletion result after the removed use disappears from the refreshed library", async () => {
  const { api, primary } = await source();
  await openExternalSkill(container, "old-tool");
  await click(sheet("external-skill-sheet"), "Voir");
  const apply = api.applySkillOperation.getMockImplementation()!;
  api.applySkillOperation.mockImplementationOnce(async () => {
    const result = await apply();
    primary.uses = primary.uses.filter((use) => use.id !== "old-tool");
    return result;
  });
  await click(container, "Retirer");
  await click(container, "Supprimer");
  expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
  expect(sheet("external-removed-sheet")).not.toBeNull();
  expect(sheet("external-removed-sheet").querySelector('[data-testid="changes-result"]')).not.toBeNull();
});
it("opens a checked source GitHub repository through its identity adapter", async () => {
  const { api } = await source();
  await click(container, "Ouvrir sur GitHub");
  expect(api.openExternalSourceRepository).toHaveBeenCalledWith({ sourceId: "mattpocock/skills" });
});
it("copies an unused source skill through the existing marketplace import preview", async () => {
  const { api } = await source();
  await openExternalSkill(container, "fresh-tool");
  await click(document.body, "Copier dans ma marketplace");
  expect(sheet("project-capture")).not.toBeNull();
  const choices = sheet("project-capture").querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await act(async () => choices[1]!.click());
  expect(api.prepareExternalSkillImport).toHaveBeenCalledWith({
    sourceId: "mattpocock/skills",
    skillPath: "skills/fresh-tool",
  });
  expect(api.previewOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "import-artifact",
      source: { kind: "source", id: "external-copy", grantHandle: "external-grant" },
      relativePath: "skills/fresh-tool",
    }),
  );
});

it("shows a same-name skill in another source without choosing a replacement", async () => {
  await source();
  await openExternalSkill(container, "old-tool");
  await click(sheet("external-skill-sheet"), "Voir");
  expect(sheet("external-removed-sheet").textContent).toContain("fixture/unused publie aussi un skill old-tool");
  await click(container, "Voir unused");
  expect(sheet("external-source-page").textContent).toContain("fixture/unused");
});
it("shows identical-copy update callouts only under the ask setting", async () => {
  await renderExternal(root, { project: true, mode: "auto" });
  await act(async () => container.querySelector<HTMLElement>('[data-project-group="external"] .canvas-node')!.click());
  await act(async () =>
    container.querySelector<HTMLElement>('[data-skill-row-id="update-tool"] .canvas-node')!.click(),
  );
  expect(sheet("project-skill-sheet").textContent).not.toContain("Voir et mettre à jour");
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderExternal(root, { project: true, mode: "ask" });
  await act(async () => container.querySelector<HTMLElement>('[data-project-group="external"] .canvas-node')!.click());
  await act(async () =>
    container.querySelector<HTMLElement>('[data-skill-row-id="update-tool"] .canvas-node')!.click(),
  );
  expect(sheet("project-skill-sheet").textContent).toContain("Voir et mettre à jour");
});

it("retains the applied result after the library refresh removes the completed update from pending copies", async () => {
  const { api, primary } = await compare();
  const apply = api.applySkillOperation.getMockImplementation()!;
  api.applySkillOperation.mockImplementationOnce(async () => {
    const result = await apply();
    primary.uses = primary.uses.map((use) =>
      use.skillKey === "grill-me" ? { ...use, state: "up-to-date", sourceChanged: false } : use,
    );
    return result;
  });
  await click(container, "Prendre la source");
  await click(container, "Mettre à jour (1)");
  expect(sheet("external-update-sheet").querySelector('[data-testid="changes-result"]')).not.toBeNull();
  expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
});
