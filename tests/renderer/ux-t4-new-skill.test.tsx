// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { CanvasToastProvider, useCanvasToast } from "../../src/renderer/canvas/CanvasToast";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectId, projectSnapshot } from "./project-view-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text || button.getAttribute("aria-label") === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function edit(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  expect(input, id).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(overrides: Record<string, unknown> = {}, project = false) {
  const api = {
    ...projectApi(),
    getAgentStatus: vi.fn(async () => ({
      harnesses: [
        { harness: "claude-code", detected: true, registered: true },
        { harness: "codex", detected: true, registered: false },
      ],
    })),
    previewOperation: vi.fn(async () => ({
      status: "ready",
      plan: {
        planId: "source-plan",
        kind: "write-skill",
        displayTarget: "packages/demo-tools",
        actions: [],
        git: { mode: "commit", warnings: [] },
        findings: [{ severity: "warning", code: "review", message: "Review this body", fix: "" }],
      },
    })),
    applyOperation: vi.fn(async () => ({
      status: "applied",
      receipt: { operationId: "source-receipt", status: "applied" },
    })),
    ...overrides,
  };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          api={api as any}
          snapshot={projectSnapshot}
          context={project ? { kind: "entry", entry: { kind: "project", id: projectId } } : { kind: "workspace" }}
          onEnsureGrant={vi.fn(async () => "grant")}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  if (project) {
    await click("Gérer les skills");
    await click("＋ Ajouter des skills");
    await click("Nouveau skill…");
  } else {
    await click("＋ Ajouter");
    await click("Nouveau skill");
  }
  return api;
}
async function fill() {
  await edit("ns-name", "show-work");
  await edit("ns-desc", "Writes posts. Use when sharing shipped work.");
  await act(async () => container.querySelector<HTMLInputElement>(".skill-plugin-pick input")!.click());
  const inputs = container.querySelectorAll<HTMLInputElement>(".skill-new-plugin input");
  for (const [index, value] of ["demo-tools", "Tools for showing shipped work."].entries())
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[index], value);
      inputs[index]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
it("shows every field, disables an unconnected agent, and copies the live French message before closing", async () => {
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  await render();
  await fill();
  expect(container.querySelector("[data-testid=new-skill-sheet]")).not.toBeNull();
  expect(container.textContent).toContain("L'installer aussi dans");
  expect(
    [...container.querySelectorAll<HTMLButtonElement>(".new-skill-agents button")].map((button) => button.disabled),
  ).toEqual([false, true]);
  expect(container.querySelector(".new-skill-prompt")?.textContent).toContain(
    "un nouveau plugin « demo-tools » (Tools for showing shipped work.)",
  );
  await click("Copier le message");
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("Écris avec Omni un nouveau skill « show-work »"));
  expect(container.querySelector("[data-testid=new-skill-sheet]")).toBeNull();
  expect(container.textContent).toContain("Message copié");
});
it("checks the fields live, previews findings, then creates and assigns the selected project", async () => {
  const api = await render({}, true);
  await click("Moi, ici");
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Créer le skill",
    )?.disabled,
  ).toBe(true);
  await fill();
  expect(container.querySelectorAll(".new-skill-checks li:not(.is-failed)")).toHaveLength(5);
  expect(container.textContent).toContain("Review this body");
  const checked = container.querySelector<HTMLInputElement>(`[data-ns-project="${projectId}"]`)!;
  expect(checked.checked).toBe(true);
  await click("Créer le skill");
  expect(api.previewOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "write-skill",
      mode: "create",
      folderName: "show-work",
      newPackage: { name: "demo-tools", description: "Tools for showing shipped work." },
    }),
  );
  expect(api.previewSkillOperation).toHaveBeenCalledWith({
    intent: {
      kind: "assign",
      sourceId: "source-one",
      packageId: "packages/demo-tools",
      artifactPath: "skills/show-work",
      targets: [{ projectId, harnessIds: ["claude-code", "codex"] }],
    },
  });
  expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("show-work créé dans demo-tools et installé dans");
});
it("keeps the sheet and the clipboard error visible when copying fails", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error("Clipboard denied");
      }),
    },
  });
  await render();
  await click("Copier le message");
  expect(container.querySelector("[data-testid=new-skill-sheet]")).not.toBeNull();
  expect(container.textContent).toContain("Clipboard denied");
});
it("shows a partial assignment failure without claiming that every project was installed", async () => {
  const api = await render(
    {
      applySkillOperation: vi.fn(async () => ({
        status: "partial",
        issues: [{ message: "Local file retained" }],
        receiptIds: ["partial-receipt"],
      })),
    },
    true,
  );
  await fill();
  await click("Moi, ici");
  await click("Créer le skill");
  expect(container.textContent).toContain("Local file retained");
  expect(container.textContent).not.toContain("et installé dans");
  expect(api.applyOperation).toHaveBeenCalledTimes(1);
  const refreshed = { ...projectSnapshot, registry: { ...projectSnapshot.registry, sources: [] } };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          api={api as any}
          snapshot={refreshed}
          context={{ kind: "entry", entry: { kind: "project", id: projectId } }}
          onEnsureGrant={vi.fn(async () => "grant")}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  await click("Réessayer l'installation");
  expect(api.applyOperation).toHaveBeenCalledTimes(1);
  expect(api.applySkillOperation).toHaveBeenCalledTimes(2);
});

function ToastProbe() {
  const toast = useCanvasToast();
  return (
    <>
      <button onClick={() => toast.show({ message: "A new skill was created" })}>Show new result</button>
      <button onClick={() => toast.update({ message: "Previous project operation", disabled: false })}>
        Update previous result
      </button>
    </>
  );
}
it("keeps a new skill toast when a background project updates its earlier result", async () => {
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <CanvasToastProvider>
          <div className="resource-canvas">
            <ToastProbe />
          </div>
        </CanvasToastProvider>
      </I18nProvider>,
    ),
  );
  await click("Show new result");
  await click("Update previous result");
  expect(container.querySelector(".canvas-toast")?.textContent).toContain("A new skill was created");
});
