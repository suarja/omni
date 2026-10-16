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
async function openSource(): Promise<void> {
  await openLibrary(container);
  await openSourcePage(container);
}

it("shows followed source counts and external project update wires on the workspace", async () => {
  await renderExternal(root);
  const node = container.querySelector('[data-kind="external-source"] .canvas-node');
  expect(node?.textContent).toContain("Bibliothèque externe");
  expect(node?.textContent).toContain("2 sources · suivies");
  expect(node?.textContent).toContain("1 à comparer");
  expect(node?.closest(".canvas-node-row")?.getAttribute("data-external-library")).toBe("true");
  expect(container.querySelectorAll('[data-kind="external-source"].canvas-node-row')).toHaveLength(1);
  expect(container.querySelector('[data-glossary="library"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll(".canvas-wire")].some((wire) =>
      wire.getAttribute("data-wire-id")?.includes("external-library"),
    ),
  ).toBe(true);
  expect(container.textContent).toContain("2 à mettre à jour");
});
it("shows the automatic pass, used and unused sources, Mac sources and manual checking", async () => {
  const { api } = await renderExternal(root, { macSkillSource: true });
  await openLibrary(container);
  const library = sheet("external-library-page");
  expect(library.textContent).toContain("Omni a mis à jour 42 copies");
  expect(library.textContent).toContain("1 copie modifiée");
  expect(library.textContent).toContain("Pas encore utilisées");
  expect(library.textContent).toContain("Sur ce Mac");
  await click(library, "Vérifier maintenant");
  expect(api.checkExternalLibrary).toHaveBeenCalledTimes(1);
  await click(library, "Historique");
  expect(sheet("canvas-history-sheet")).not.toBeNull();
});
it("shows ask-mode updates without claiming automatic writes", async () => {
  await renderExternal(root, { mode: "ask" });
  await openLibrary(container);
  expect(sheet("external-library-page").textContent).toContain("1 mise à jour pour vos projets");
  expect(sheet("external-library-page").textContent).not.toContain("Omni a mis à jour");
  await click(container, "Voir");
  expect(container.querySelectorAll('[data-external-review^="update:"]')).toHaveLength(1);
});
it("groups source skills by use and keeps removal evidence in the one-skill sheet", async () => {
  await renderExternal(root);
  await openSource();
  const page = sheet("external-source-page");
  expect(page.textContent).toContain("Retirés de la source, encore dans vos projets");
  expect(page.querySelector('[data-page-section="unused"]')?.textContent).toContain("fresh-tool");
  expect(page.querySelector('[data-page-section="unused"]')?.textContent).toContain("local-tool");
  expect(page.querySelector('[data-page-section="unused"]')?.textContent).not.toContain("old-tool");
  expect(page.querySelector(".stage-note")?.textContent).toContain("MIT · 4 skills · version aaaaaaa");
  await openExternalSkill(container, "old-tool");
  expect(sheet("external-skill-sheet").textContent).toContain("Renamed into better-tool");
});
it("offers named installation and copying from the one-skill sheet", async () => {
  await renderExternal(root);
  await openSource();
  await openExternalInstall(container, "fresh-tool");
  expect(sheet("external-install-sheet")).not.toBeNull();
  await click(sheet("external-install-sheet"), "Retour");
  await openExternalSkill(container, "fresh-tool");
  expect(sheet("external-skill-sheet").textContent).toContain("Installer dans un projet");
  expect(sheet("external-skill-sheet").textContent).toContain("Copier dans ma marketplace");
  expect(sheet("external-skill-sheet").textContent).toContain("Voir sur GitHub");
});
it("lists modified copies one per use with comparison actions", async () => {
  await renderExternal(root);
  await openSource();
  await click(container, "Comparer");
  expect(sheet("external-compare-list").querySelectorAll(".external-row")).toHaveLength(1);
  expect(sheet("external-compare-list").textContent).toContain("grill-me");
  await click(sheet("external-compare-list"), "Comparer");
  expect(sheet("external-update-sheet")).not.toBeNull();
});
it("renders removed and modified state chips, source groups and legend on the project", async () => {
  await renderExternal(root, { project: true });
  await act(async () => container.querySelector<HTMLElement>('[data-project-group="external"] .canvas-node')!.click());
  expect(container.textContent).toContain("Modifié ici · mise à jour dispo");
  expect(container.textContent).toContain("Retiré de la source");
  expect(container.querySelector(".project-legend")?.textContent).toContain("Retiré de la source");
  expect(container.querySelector(".project-source-heading")?.textContent).toContain("mattpocock/skills");
});
it("shows modified skill choices above the read-only callout and lists other project uses", async () => {
  await renderExternal(root, { project: true });
  await act(async () => container.querySelector<HTMLElement>('[data-project-group="external"] .canvas-node')!.click());
  await act(async () => container.querySelector<HTMLElement>('[data-skill-row-id="grill-me"] .canvas-node')!.click());
  expect(sheet("project-skill-sheet").textContent).toContain("Modifié ici, et changé dans la source");
  expect(
    sheet("project-skill-sheet")
      .querySelector(".external-callout")!
      .compareDocumentPosition(sheet("project-skill-sheet").querySelector(".skill-callout.is-external")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(sheet("project-skill-sheet").textContent).toContain("Installé dans");
  await click(sheet("project-skill-sheet"), "Comparer");
  expect(sheet("external-update-sheet")).not.toBeNull();
});
it("renders an unused source with unused nodes with an honest no-project callout", async () => {
  await renderExternal(root, { unused: true });
  await openLibrary(container);
  await openSourcePage(container, "fixture/unused");
  expect(sheet("external-source-page").textContent).toContain("Aucun projet n'utilise encore cette source");
  expect(
    sheet("external-source-page").querySelector('[data-page-section="unused"] .page-section-title')?.textContent,
  ).toContain("Pas encore utilisés");
});
it("keeps cached source skills readable with offline diagnostics and no update preview", async () => {
  const { api } = await renderExternal(root, { offline: true });
  await openLibrary(container);
  expect(sheet("external-library-page").textContent).toContain("Network unavailable");
  await openSourcePage(container);
  expect(sheet("external-source-page").textContent).toContain("Source indisponible");
  expect(sheet("external-source-page").textContent).toContain("fresh-tool");
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
});
it("shows each automatic failure only once in Review and retains its reason", async () => {
  await renderExternal(root, { mode: "ask", failure: true });
  await click(container, "À valider");
  expect(container.querySelectorAll('[data-external-review^="failure:"]')).toHaveLength(1);
  expect(container.querySelector('[data-external-review^="failure:"]')?.textContent).toContain(
    "Copy changed during apply",
  );
  expect(container.querySelectorAll('[data-external-review^="update:"]')).toHaveLength(0);
  expect(container.querySelectorAll('[data-external-review^="modified:"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-external-review^="removed:"]')).toHaveLength(1);
});
it("keeps all-failed automatic History operations visibly failed without Undo", async () => {
  await renderExternal(root, { allFailed: true });
  await click(container, "Historique");
  expect(sheet("canvas-history-sheet").textContent).toContain("Échec");
  expect(sheet("canvas-history-sheet").textContent).toContain("Automatique");
  expect(
    [...sheet("canvas-history-sheet").querySelectorAll("button")].some((button) => button.textContent === "Annuler"),
  ).toBe(false);
});
it("saves auto and ask Settings while retaining the other settings and opens Library", async () => {
  const { api } = await renderExternal(root);
  await click(container, "Réglages");
  const row = sheet("external-library-settings");
  expect(row.textContent).toContain("Bibliothèque externe · 2 sources");
  await click(row, "Me demander");
  expect(api.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      externalLibrary: { updates: "ask" },
      agents: expect.any(Object),
      features: expect.any(Object),
    }),
  );
  await click(row, "Automatique");
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ externalLibrary: { updates: "auto" } }));
  await click(row, "Ouvrir");
  expect(sheet("external-library-page")).not.toBeNull();
});
it("keeps GitHub and on-Mac additions gated until discovery and exposes the folder fallback", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "＋ Ajouter une source");
  expect(sheet("canvas-setup-sheet").textContent).toContain("Dépôt GitHub");
  expect(sheet("canvas-setup-sheet").textContent).toContain("Choisir un dossier…");
  await act(async () => sheet("canvas-setup-sheet").querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  expect(sheet("canvas-setup-sheet").textContent).toContain("Ce qu'Omni a trouvé");
  expect(api.addExternalSource).not.toHaveBeenCalled();
});
it("provides English translations for the Library surface", async () => {
  await renderExternal(root, { language: "en" });
  await openLibrary(container);
  expect(sheet("external-library-page").textContent).toContain("External library");
  expect(sheet("external-library-page").textContent).toContain("Check now");
  expect(sheet("external-library-page").textContent).not.toContain("Sources externes");
});
it.each(["fr", "en"] as const)("uses singular skill summaries and current-state chips in %s", async (language) => {
  const { primary } = await renderExternal(root, { language });
  primary.source!.skillCount = 1;
  primary.source!.counts = { "up-to-date": 1, modified: 0, update: 0, removed: 0, unknown: 0 };
  primary.uses = primary.uses.map((use) => ({ ...use, state: "up-to-date", sourceChanged: false }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await openLibrary(container);
  const library = sheet("external-library-page");
  expect(library.querySelector(".page-section-title small")?.textContent).toContain("1 skill ·");
  expect(library.textContent).not.toContain("1 skills");
  expect(library.querySelector(".project-chip.is-current")?.textContent).toBe(
    language === "fr" ? "à jour" : "up to date",
  );
  await openSourcePage(container);
  expect(
    sheet("external-source-page").querySelectorAll('[data-page-section="used"] .project-chip.is-current'),
  ).toHaveLength(2);
});
