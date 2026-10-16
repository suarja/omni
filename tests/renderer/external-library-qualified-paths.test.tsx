// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderExternal, openLibrary, click, useFixture } from "./external-library-fixture";
import { createFixture } from "./external-library-fixture";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { projectSnapshot } from "./project-view-fixture";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
const secondPath = "plugins/second/skills/fresh-tool";
function sheet(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="external-skill-sheet"]')!;
}
async function seed(used = false) {
  const fixture = await renderExternal(root, { language: "en" });
  const original = fixture.primary.skills.find((skill) => skill.name === "fresh-tool")!;
  original.useIds = used ? ["first-copy"] : [];
  fixture.primary.skills.push({
    ...original,
    path: secondPath,
    description: "Second distinct skill",
    useIds: used ? ["second-copy"] : [],
  });
  if (used)
    for (const [id, projectId, path] of [
      ["first-copy", "project-one", original.path],
      ["second-copy", "project-two", secondPath],
    ]) {
      fixture.primary.uses.push({
        ...useFixture(id!, "up-to-date"),
        skillKey: "fresh-tool",
        skillPath: path!,
        projectId: projectId!,
        projectName: projectId === "project-one" ? "Project One" : "Project Two",
      });
    }
  fixture.primary.source!.skillCount++;
  await act(async () => window.dispatchEvent(new Event("focus")));
  return fixture;
}
async function openPeer(index: number): Promise<void> {
  const nodes = container.querySelectorAll<HTMLButtonElement>('[data-external-skill="fresh-tool"] .canvas-node');
  await act(async () => nodes[index]!.click());
}

it.each(["library", "source"])(
  "keeps both used same-name paths and their own uses and documents on the %s page",
  async (page) => {
    const { api } = await seed(true);
    await openLibrary(container);
    if (page === "source") await click(container, "mattpocock/skills");
    const nodes = container.querySelectorAll<HTMLElement>('[data-external-skill="fresh-tool"]');
    expect(nodes).toHaveLength(2);
    expect(new Set([...nodes].map((node) => node.dataset.pageNode)).size).toBe(2);
    expect(nodes[0]!.textContent).toContain("Project One");
    expect(nodes[0]!.textContent).not.toContain("Project Two");
    expect(nodes[1]!.textContent).toContain("Project Two");
    expect(nodes[1]!.querySelector("button")!.getAttribute("aria-label")).toContain(secondPath);
    for (const [index, path, description] of [
      [0, "skills/fresh-tool", "New source skill"],
      [1, secondPath, "Second distinct skill"],
    ] as const) {
      await openPeer(index);
      expect(sheet().textContent).toContain(description);
      expect(
        sheet().querySelector<HTMLInputElement>(`[data-project-id="${index ? "project-two" : "project-one"}"] input`)!
          .disabled,
      ).toBe(true);
      await click(sheet(), "Read the entire skill");
      expect(api.readExternalSkillDocument).toHaveBeenLastCalledWith({
        sourceId: "mattpocock/skills",
        skillPath: path,
      });
      expect(container.querySelector('[data-testid="page-skill-document"]')!.textContent).toContain(`${path}/SKILL.md`);
      await click(container.querySelector('[data-testid="page-skill-document"]')!, "Close");
      await click(sheet(), "Close");
    }
    expect(api.readProjectSkills).not.toHaveBeenCalled();
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  },
);

it("copies and installs the selected unused same-name path through contextual nested operations", async () => {
  const { api } = await seed();
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await openPeer(1);
  await click(sheet(), "Copy to my marketplace");
  const capture = container.querySelector('[data-testid="project-capture"]')!;
  await act(async () => capture.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click());
  expect(api.prepareExternalSkillImport).toHaveBeenLastCalledWith({
    sourceId: "mattpocock/skills",
    skillPath: secondPath,
  });
  expect(api.previewOperation).toHaveBeenLastCalledWith(expect.objectContaining({ relativePath: secondPath }));
  await click(capture, "Close");
  expect(sheet().textContent).toContain("Second distinct skill");
  await act(async () => sheet().querySelector<HTMLInputElement>('[data-project-id="project-one"] input')!.click());
  await click(sheet(), "Install in Project One");
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ skillPath: secondPath }) }),
  );
  expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  await click(container.querySelector('[data-testid="external-install-sheet"]')!, "Back");
  expect(sheet().textContent).toContain("Second distinct skill");
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});

it("offers both same-name search choices and restores the exact path through history", async () => {
  const { api } = await seed();
  for (const [index, description] of [
    [0, "New source skill"],
    [1, "Second distinct skill"],
  ] as const) {
    await act(async () => container.querySelector<HTMLButtonElement>(".canvas-search-trigger")!.click());
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fresh-tool");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const choices = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(choices).toHaveLength(2);
    expect(choices[1]!.textContent).toContain(secondPath);
    await act(async () => choices[index]!.click());
    expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
    expect(sheet().textContent).toContain(description);
  }
  await click(sheet(), "Close");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true })));
  expect(sheet().textContent).toContain("New source skill");
  await click(sheet(), "Close");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true, bubbles: true })));
  expect(sheet().textContent).toContain("Second distinct skill");
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});

it.each(["missing-path", "removed-use"])("does not substitute a live same-name sibling for %s", async (selection) => {
  const { api, primary } = createFixture();
  if (selection === "removed-use")
    primary.skills.push({
      name: "old-tool",
      path: "plugins/new/skills/old-tool",
      description: "Live sibling",
      licence: "MIT",
      useIds: [],
    });
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          api={api}
          snapshot={projectSnapshot}
          context={{ kind: "workspace" }}
          canvasPage={{ kind: "source", sourceId: "mattpocock/skills" }}
          initialExternalSelection={{
            sourceId: "mattpocock/skills",
            skillName: selection === "removed-use" ? "old-tool" : "fresh-tool",
            skillPath: selection === "removed-use" ? "skills/old-tool" : "missing/skills/fresh-tool",
            ...(selection === "removed-use" ? { useId: "old-tool" } : {}),
            view: "skill",
          }}
          onEnsureGrant={async () => "grant"}
          onRefresh={() => {}}
          onNavigate={() => {}}
          onNavigateDestination={() => {}}
        />
      </I18nProvider>,
    ),
  );
  if (selection === "removed-use") {
    expect(sheet().textContent).not.toContain("Live sibling");
    await click(sheet(), "Read the entire skill");
    expect(api.readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "project", id: "project-one", relativePath: ".agents/skills/old-tool/SKILL.md" }),
    );
  } else {
    const read = [...sheet().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Read the entire skill",
    )!;
    expect(read.disabled).toBe(true);
    expect(sheet().textContent).not.toContain("New source skill");
    expect(sheet().querySelector("[data-project-id]")).toBeNull();
  }
  expect(api.readExternalSkillDocument).not.toHaveBeenCalled();
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(api.prepareExternalSkillImport).not.toHaveBeenCalled();
});

it("retains a selected removed use at the install boundary when its source path is reused", async () => {
  const { api, primary } = createFixture();
  primary.skills.push({
    name: "old-tool",
    path: "skills/old-tool",
    description: "Republished skill",
    licence: "MIT",
    useIds: [],
  });
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          api={api}
          snapshot={projectSnapshot}
          context={{ kind: "workspace" }}
          canvasPage={{ kind: "source", sourceId: "mattpocock/skills" }}
          initialExternalSelection={{
            sourceId: "mattpocock/skills",
            skillName: "old-tool",
            skillPath: "skills/old-tool",
            useId: "old-tool",
            view: "install",
            projectIds: ["project-two"],
          }}
          onEnsureGrant={async () => "grant"}
          onRefresh={() => {}}
          onNavigate={() => {}}
          onNavigateDestination={() => {}}
        />
      </I18nProvider>,
    ),
  );
  expect(api.previewSkillOperation).not.toHaveBeenCalled();
  expect(api.applySkillOperation).not.toHaveBeenCalled();
});
