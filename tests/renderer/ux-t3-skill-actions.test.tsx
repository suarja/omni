// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectId, projectSnapshot, skillRow } from "./project-view-fixture";
import type { Route } from "../../src/renderer/navigation";
import { ProjectSkillState } from "../../src/renderer/canvas/ProjectSkillChips";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
it.each(["mine", "project-only", "external"] as const)(
  "keeps unknown %s skill state out of exception chips",
  (origin) => {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="fr">
          <ProjectSkillState row={{ ...skillRow("unbound", origin), state: "unknown" }} />
        </I18nProvider>,
      ),
    );
    expect(container.textContent).toBe("");
  },
);
async function render(workspace = false) {
  const api = projectApi();
  const grant = vi.fn(async () => "grant");
  function Navigation() {
    const [route, setRoute] = useState<Extract<Route, { screen: "resource-canvas" }>>({
      screen: "resource-canvas",
      context: workspace ? { kind: "workspace" } : { kind: "entry", entry: { kind: "project", id: projectId } },
    });
    return (
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          {...route}
          api={api}
          snapshot={projectSnapshot}
          onEnsureGrant={grant}
          onRefresh={vi.fn()}
          onNavigate={(next) => {
            if (next.screen === "resource-canvas") setRoute(next);
          }}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Navigation />));
  return api;
}
async function click(text: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll<HTMLElement>("button,[role=button]")].find(
    (button) => button.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
it("opens an agent removal from a canvas chip without opening the skill and focuses Cancel", async () => {
  const api = await render();
  await act(async () => container.querySelector<HTMLElement>("[data-project-group=mine] .canvas-node")!.click());
  await click("✓ Codex", container.querySelector("[data-skill-row-id=review]")!);
  expect(container.querySelector("[data-testid=project-skill-sheet]")).toBeNull();
  const pop = container.querySelector("[data-testid=project-confirmation]")!;
  expect(pop.textContent).toContain("Seul Codex ne le verra plus. Claude Code le garde.");
  expect(document.activeElement?.textContent).toBe("Annuler");
  await click("Retirer pour Codex", pop);
  expect(api.previewSkillOperation).toHaveBeenCalledWith({
    intent: { kind: "project-skill", projectId, rowId: "review", action: "remove-agent", harnessIds: ["codex"] },
  });
});
it("shows the one-agent and capture callouts before skill sections and validates both new plugin fields", async () => {
  await render();
  await click("Gérer les skills");
  await click("local-tool");
  const sheet = container.querySelector("[data-testid=project-skill-sheet]")!;
  expect(sheet.textContent).toContain("Installé seulement pour Claude Code");
  expect(sheet.textContent!.indexOf("Ajouter à ma marketplace")).toBeLessThan(
    sheet.textContent!.indexOf("Ce que fait ce skill"),
  );
  await click("Ajouter à ma marketplace", sheet);
  await act(async () => container.querySelector<HTMLInputElement>(".skill-plugin-pick input")!.click());
  const capture = container.querySelector("[data-testid=project-capture]")!;
  expect(capture.textContent).not.toContain("Nouvelle clé de skill");
  const inputs = capture.querySelectorAll<HTMLInputElement>(".skill-new-plugin input");
  expect(inputs).toHaveLength(2);
  const submit = [...capture.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Ajouter",
  )!;
  expect(submit.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0], "build-to-show");
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(submit.disabled).toBe(true);
});
it("offers copying for an external skill and preserves the origin wording", async () => {
  await render();
  await click("Gérer les skills");
  await click("grill-me");
  expect(container.textContent).toContain("Publié par mattpocock/skills — lecture seule");
  await click("Copier dans ma marketplace");
  expect(container.querySelector("[data-testid=project-capture]")?.textContent).toContain(
    "inchangé : garde la version de mattpocock/skills",
  );
});

it("opens My Marketplace from its workspace node and focuses Cancel when describing an empty plugin", async () => {
  await render(true);
  await act(async () => container.querySelector<HTMLElement>("[data-kind=marketplace] .canvas-node")!.click());
  expect(container.querySelector("[data-testid=marketplace-page]")).not.toBeNull();
  await click("Plugins et vitrines");
  const sheet = container.querySelector("[data-testid=my-marketplace-sheet]")!;
  expect(sheet).not.toBeNull();
  expect(sheet.textContent).toContain("Plugins · 2");
  expect(sheet.textContent).toContain("pas encore de description");
  expect(sheet.textContent).toContain("Un plugin se crée quand vous y rangez un premier skill.");
  await click("Décrire", sheet);
  expect(document.activeElement?.textContent).toBe("Annuler");
  expect(container.querySelector(".skill-description-pop")?.textContent).toContain("Une phrase, en anglais");
});
