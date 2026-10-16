// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderExternal, openLibrary, click, useFixture } from "./external-library-fixture";
import { discoverMacSource } from "../../src/renderer/canvas/external-library/use-mac-discovery";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
async function openSkill(name: string): Promise<void> {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-external-skill="${name}"] .canvas-node`)!.click(),
  );
}
function skillSheet(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="external-skill-sheet"]')!;
}

it("clears inline selections and the full document when another skill is opened", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await openSkill("fresh-tool");
  await act(async () => skillSheet().querySelector<HTMLInputElement>("[data-project-id] input")!.click());
  await click(skillSheet(), "Lire le skill en entier");
  await openSkill("local-tool");
  expect(skillSheet().querySelector<HTMLInputElement>("[data-project-id] input")!.checked).toBe(false);
  expect(container.querySelector('[data-testid="page-skill-document"]')).toBeNull();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});

it("discards a previous skill's deferred document when the selected skill changes", async () => {
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
  await openSkill("fresh-tool");
  await click(skillSheet(), "Lire le skill en entier");
  await openSkill("local-tool");
  await act(async () => finish({ status: "read", content: "previous skill", byteLength: 13, truncated: false }));
  expect(api.readArtifact).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="page-skill-document"]')).toBeNull();
});

it("captures each removed callout's own project copy", async () => {
  const { primary, api } = await renderExternal(root);
  primary.uses.push({
    ...useFixture("old-two", "removed"),
    skillKey: "old-tool",
    skillPath: "skills/old-tool",
    projectId: "project-two",
    projectName: "Project Two",
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await openSkill("old-tool");
  const capture = [...skillSheet().querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    button.textContent?.includes("Garder ma copie"),
  );
  expect(capture).toHaveLength(2);
  await act(async () => capture[1]!.click());
  expect(api.readProjectSkills).toHaveBeenCalledWith("project-two");
});

it.each(["response", "rejection"])(
  "retries a failed Mac discovery on an explicit request after a %s",
  async (failure) => {
    const ready = (await renderExternal(root)).api;
    const result = await ready.discoverExternalSource({ repository: "fixture/commands" });
    const discoverExternalSource = vi.fn();
    if (failure === "response")
      discoverExternalSource.mockResolvedValueOnce({
        status: "failed",
        error: { type: "offline", message: "Offline" },
      });
    else discoverExternalSource.mockRejectedValueOnce(new Error("Offline"));
    discoverExternalSource.mockResolvedValue(result);
    const api = { discoverExternalSource };
    const mac = { status: "ready" as const, marketplaces: [{ id: "commands", repo: "fixture/commands" }] };
    expect((await discoverMacSource(api, mac, "fixture/commands")).status).toBe("failed");
    expect((await discoverMacSource(api, mac, "fixture/commands")).status).toBe("ready");
    await discoverMacSource(api, mac, "fixture/commands");
    expect(discoverExternalSource).toHaveBeenCalledTimes(2);
  },
);

it("reads an offline cached source through the read-only document boundary", async () => {
  const { api } = await renderExternal(root, { offline: true });
  await openLibrary(container);
  await click(container, "mattpocock/skills");
  await openSkill("fresh-tool");
  await click(skillSheet(), "Lire le skill en entier");
  expect(api.readExternalSkillDocument).toHaveBeenCalledWith({
    sourceId: "mattpocock/skills",
    skillPath: "skills/fresh-tool",
  });
  expect(api.prepareExternalSkillImport).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="page-skill-document"]')?.textContent).toContain("Actual content");
});

it.each(["close", "Escape"])(
  "places the full document beside its inactive reader and restores focus after %s",
  async (action) => {
    await renderExternal(root);
    await openLibrary(container);
    await click(container, "mattpocock/skills");
    await openSkill("fresh-tool");
    const reader = skillSheet();
    const trigger = [...reader.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Lire le skill en entier",
    )!;
    await act(async () => trigger.click());
    const full = container.querySelector<HTMLElement>('[data-testid="page-skill-document"]')!;
    expect(full.parentElement?.classList.contains("canvas-rail-layer")).toBe(true);
    expect(reader.contains(full)).toBe(false);
    expect(reader.hasAttribute("inert")).toBe(true);
    if (action === "close") await click(full, "Fermer");
    else await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-testid="page-skill-document"]')).toBeNull();
    expect(skillSheet()).toBe(reader);
    expect(reader.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  },
);

it("keeps a directly opened Library skill and its install flow over the Library page", async () => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await openSkill("update-tool");
  expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  await act(async () => skillSheet().querySelector<HTMLInputElement>('[data-project-id="project-two"] input')!.click());
  await click(skillSheet(), "Installer dans Project Two");
  expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="external-install-sheet"]')).not.toBeNull();
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  expect(api.readExternalSource).toHaveBeenCalledTimes(2);
});

it.each(["result", "undo"])(
  "lands a personal History %s on the marketplace with the saved operation open",
  async (action) => {
    const { api } = await renderExternal(root, { allFailed: true });
    const history = await api.listOperations();
    const management = {
      intentId: "personal-intent",
      operationId: "personal-operation",
      status: "applied" as const,
      source: { status: "unchanged" as const, sourceId: "source-one" },
      targets: [],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    };
    api.listOperations.mockResolvedValue({
      ...history,
      receipts: [
        {
          ...history.receipts[0]!,
          operationId: "personal-operation",
          status: "applied",
          skillManagement: management,
          children: ["personal-child"],
        },
        { ...history.receipts[0]!, operationId: "personal-child", kind: "apply-plan", status: "applied" },
      ],
    });
    api.readSkillOperationResult.mockResolvedValue({ ...management, receipts: [] });
    await click(container, "Historique");
    if (action === "result")
      await act(async () => container.querySelector<HTMLButtonElement>(".rail-history-entry")!.click());
    else await click(container.querySelector('[data-operation-id="personal-operation"]')!, "Annuler");
    expect(container.querySelector('[data-testid="marketplace-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
    if (action === "result") expect(api.readSkillOperationResult).toHaveBeenCalledWith({ intentId: "personal-intent" });
    else
      expect(api.previewSkillOperation).toHaveBeenCalledWith({
        intent: { kind: "restore", operationId: "personal-operation" },
      });
  },
);

it.each(["response", "rejection"])(
  "retries discovery once when Add is reopened after a %s without requests on re-render",
  async (failure) => {
    const { api } = await renderExternal(root, { macSkillSource: true });
    const discover = api.discoverExternalSource.getMockImplementation()!;
    let attempts = 0;
    api.discoverExternalSource.mockImplementation(async (request) => {
      if (request.repository === "fixture/mac-skills" && ++attempts === 1) {
        if (failure === "rejection") throw new Error("Offline");
        return { status: "failed", error: { type: "offline", message: "Offline" } } as never;
      }
      return discover(request);
    });
    await openLibrary(container);
    expect(attempts).toBe(1);
    await click(container, "＋ Ajouter une source");
    expect(attempts).toBe(2);
    await click(container, "Fermer");
    await click(container, "＋ Ajouter une source");
    expect(attempts).toBe(2);
    expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  },
);

it("keeps the selected unacknowledged removed use through Review, its reader and footer capture", async () => {
  const { primary, api } = await renderExternal(root);
  primary.uses[1]!.acknowledged = true;
  primary.uses.push({
    ...useFixture("old-two", "removed"),
    skillKey: "old-tool",
    skillPath: "skills/old-tool",
    projectId: "project-two",
    projectName: "Project Two",
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  await click(container, "À valider");
  await click(container.querySelector('[data-external-review="removed:all"]')!, "Voir");
  await click(skillSheet(), "Lire le skill en entier");
  expect(api.readArtifact).toHaveBeenCalledWith({
    kind: "project",
    id: "project-two",
    grantHandle: "grant",
    relativePath: ".agents/skills/old-two/SKILL.md",
  });
  await click(container.querySelector('[data-testid="page-skill-document"]')!, "Fermer");
  await click(skillSheet(), "Copier dans ma marketplace");
  expect(api.readProjectSkills).toHaveBeenCalledWith("project-two");
  expect(api.readProjectSkills).not.toHaveBeenCalledWith("project-one");
});

it.each([false, true])(
  "keeps the reviewed removed folder instead of another installed harness copy, missing=%s",
  async (missing) => {
    const { primary, api } = await renderExternal(root);
    primary.uses[1]!.acknowledged = true;
    const apply = vi.fn();
    Object.assign(api, { applyOperation: apply });
    const selected = {
      ...useFixture("old-tool", "removed"),
      id: "old-project-two",
      projectId: "project-two",
      projectName: "Project Two",
    };
    primary.uses.push(selected);
    if (missing) {
      const read = api.readProjectSkills.getMockImplementation()!;
      api.readProjectSkills.mockImplementation(async (id) => {
        const data = await read(id);
        return {
          ...data,
          skills: data.skills.map((row) =>
            row.name === "old-tool"
              ? {
                  ...row,
                  agents: {
                    ...row.agents,
                    codex: { state: "installed" as const, folderPath: ".agents/skills/moved-old-tool" },
                  },
                }
              : row,
          ),
        };
      });
    }
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click(container, "À valider");
    await click(container.querySelector('[data-external-review="removed:all"]')!, "Voir");
    await click(skillSheet(), "Lire le skill en entier");
    expect(api.readArtifact).toHaveBeenLastCalledWith({
      kind: "project",
      id: "project-two",
      grantHandle: "grant",
      relativePath: `${selected.folderPath}/SKILL.md`,
    });
    await click(container.querySelector('[data-testid="page-skill-document"]')!, "Fermer");
    await click(skillSheet(), "Copier dans ma marketplace");
    const capture = container.querySelector('[data-testid="project-capture"]')!;
    await act(async () => capture.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click());
    if (missing) {
      expect(api.previewOperation).not.toHaveBeenCalled();
      expect(capture.querySelector('[role="alert"]')).not.toBeNull();
    } else {
      expect(api.previewOperation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: { kind: "project", id: "project-two", grantHandle: "grant" },
          relativePath: selected.folderPath,
        }),
      );
    }
    expect(apply).not.toHaveBeenCalled();
  },
);

it("retries failed discovery explicitly for the same repository without changing the Mac list", async () => {
  const { api } = await renderExternal(root, { macSkillSource: true });
  const discover = api.discoverExternalSource.getMockImplementation()!;
  let attempts = 0;
  api.discoverExternalSource.mockImplementation(async (request) => {
    if (request.repository === "fixture/mac-skills" && ++attempts < 3)
      return { status: "failed", error: { type: "offline", message: "Offline" } } as never;
    return discover(request);
  });
  await openLibrary(container);
  await click(container.querySelector('[data-page-section="mac"]')!, "fixture/mac-skills");
  expect(attempts).toBe(2);
  const input = container.querySelector<HTMLInputElement>("#external-repository")!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(attempts).toBe(3);
  expect(container.querySelector('[data-testid="external-add-fields"]')?.textContent).not.toContain("Offline");
});

it.each(["copy", "compare"])("keeps a Library skill's %s journey on the Library page", async (journey) => {
  const { api } = await renderExternal(root);
  await openLibrary(container);
  await openSkill(journey === "copy" ? "update-tool" : "grill-me");
  await click(skillSheet(), journey === "copy" ? "Copier dans ma marketplace" : "Comparer");
  expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  expect(
    container.querySelector(`[data-testid="${journey === "copy" ? "project-capture" : "external-update-sheet"}"]`),
  ).not.toBeNull();
  if (journey === "copy") {
    await click(container.querySelector('[data-testid="project-capture"]')!, "Fermer");
    expect(skillSheet()).not.toBeNull();
    expect(container.querySelector('[data-testid="external-library-page"]')).not.toBeNull();
  }
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  expect(api.readExternalSource).toHaveBeenCalledTimes(2);
});
