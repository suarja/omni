// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { projectSnapshot } from "./project-view-fixture";
import { createFixture, renderExternal, click } from "./external-library-fixture";
import type { EntryRef } from "../../src/domain/project-source-registry";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
function sheet(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="marketplace-skill-sheet"]')!;
}
async function toggle(id: string): Promise<void> {
  await act(async () => sheet().querySelector<HTMLInputElement>(`[data-project-id="${id}"] input`)!.click());
}
async function mount() {
  const fixture = createFixture();
  const api = { ...fixture.api, readWorkspaceSkillUses: vi.fn(async () => ({ status: "ready" as const, uses: [] })) };
  const pending = new Map<string, (grant: string) => void>();
  let deferSource = false;
  const grant = vi.fn((entry: EntryRef) =>
    entry.kind === "source" && !deferSource
      ? Promise.resolve("grant")
      : new Promise<string>((resolve) => pending.set(entry.id, resolve)),
  );
  async function render(
    path = "plugins/pstack/skills/review/SKILL.md",
    snapshot: ResourceSnapshot = projectSnapshot,
  ): Promise<void> {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            snapshot={snapshot}
            context={{ kind: "workspace" }}
            canvasPage={{ kind: "marketplace" }}
            initialMarketplaceSkill={{ packageId: "pstack", path }}
            onEnsureGrant={grant}
            onRefresh={vi.fn()}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
  }
  // Read the exact inventory path rather than prescribing a fixture layout.
  const source = projectSnapshot.roots.find((root) => root.entry.id === "source-one")!;
  const path =
    source.evidence.status === "observed"
      ? source.evidence.observation.inventory.artifacts.find(
          (artifact) => artifact.packageId === "pstack" && artifact.kind === "skill",
        )!.relativePath
      : "";
  await render(path);
  return {
    api,
    pending,
    render,
    path,
    grant,
    deferSource: () => {
      deferSource = true;
    },
  };
}

it("keeps the latest install target when an older project grant resolves last", async () => {
  const { api, pending } = await mount();
  await toggle("project-one");
  await click(sheet(), "Install in Project One");
  expect(pending.has("project-one")).toBe(true);
  expect(sheet().querySelector<HTMLButtonElement>('[aria-busy="true"]')!.disabled).toBe(true);
  expect(sheet().querySelector('[role="status"]')!.textContent).toBe("Preparing installation access…");
  await toggle("project-one");
  await toggle("project-two");
  await click(sheet(), "Install in Project Two");
  expect(pending.has("project-two")).toBe(true);
  await act(async () => pending.get("project-two")!("grant"));
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      intent: expect.objectContaining({
        targets: [{ projectId: "project-two", harnessIds: ["claude-code", "codex"] }],
      }),
    }),
  );
  await act(async () => pending.get("project-one")!("grant"));
  expect(api.previewSkillOperation).toHaveBeenCalledTimes(1);
  expect(api.applySkillOperation).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});

it("does not request project grants after a cancelled source grant completes", async () => {
  const { api, pending, grant, deferSource } = await mount();
  deferSource();
  await toggle("project-one");
  await click(sheet(), "Install in Project One");
  expect(pending.has("source-one")).toBe(true);
  await toggle("project-one");
  await act(async () => pending.get("source-one")!("grant"));
  expect(grant).not.toHaveBeenCalledWith({ kind: "project", id: "project-one" });
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});

it("cancels preparation when the inline selection changes without a second submission", async () => {
  const { api, pending } = await mount();
  await toggle("project-one");
  await click(sheet(), "Install in Project One");
  await toggle("project-one");
  await toggle("project-two");
  await act(async () => pending.get("project-one")!("grant"));
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});

it.each(["identity", "unmount", "eligibility"])("cancels deferred installation access on %s change", async (change) => {
  const { api, pending, render, path } = await mount();
  await toggle("project-one");
  await click(sheet(), "Install in Project One");
  if (change === "identity") await render("missing/SKILL.md");
  else if (change === "unmount") await act(async () => root.render(null));
  else
    await render(path, {
      ...projectSnapshot,
      registry: {
        ...projectSnapshot.registry,
        projects: projectSnapshot.registry.projects.map((project) =>
          project.ref.id === "project-one" ? { ...project, availability: "missing" as const } : project,
        ),
      },
    });
  await act(async () => pending.get("project-one")!("grant"));
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});

it("restores a node-opened marketplace reader through Back and Forward, closing the sheet first", async () => {
  const { api } = await renderExternal(root);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-kind="marketplace"] .canvas-node')!.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-page-section="pstack"] .canvas-node')!.click(),
  );
  const key = async (key: string): Promise<void> => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true })));
  };
  await key("[");
  expect(sheet()).toBeNull();
  expect(container.querySelector('[data-testid="marketplace-page"]')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-page-section="pstack"] .canvas-node')!.click(),
  );
  await key("k");
  const option = [...container.querySelectorAll<HTMLButtonElement>(".canvas-search-result")].find(
    (node) => node.querySelector("strong")?.textContent === "Bibliothèque externe",
  )!;
  await act(async () => option.click());
  await key("[");
  expect(container.querySelector('[data-testid="marketplace-page"]')).not.toBeNull();
  expect(sheet()).not.toBeNull();
  await click(sheet(), "Fermer");
  await key("]");
  expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});
