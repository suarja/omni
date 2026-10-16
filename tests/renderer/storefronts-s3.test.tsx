// @vitest-environment jsdom
import type { AgentRequest } from "../../src/shared/agents-ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render as renderFixture, plan } from "./storefronts-s3-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
const render = (options?: Parameters<typeof renderFixture>[1]) => renderFixture(root, options);
it("hangs a storefront below the workshop with a dashed publication wire", async () => {
  await render();
  const node = container.querySelector('[data-kind="storefront"] .canvas-node');
  expect(node).not.toBeNull();
  expect(node?.textContent).toContain("Vitrine · public-tools");
  expect(node?.textContent).toContain("1 à publier");
  expect(container.querySelector('.canvas-wire[data-kind="publication"]')).not.toBeNull();
  expect(container.querySelectorAll(".canvas-wire[data-storefront-project]")).toHaveLength(0);
});
it("opens publication checks from the storefront without leaving the canvas", async () => {
  await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')?.click());
  const sheet = container.querySelector('[data-testid="storefront-sheet"]');
  expect(sheet).not.toBeNull();
  expect(sheet?.textContent).toContain("Voir et publier");
});

async function click(label: string, scope: ParentNode = container): Promise<void> {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function openUpdate(): Promise<ReturnType<typeof render> extends Promise<infer T> ? T : never> {
  const api = await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  return api;
}
it("shows file statistics and the existing diff viewer when updating", async () => {
  const api = await openUpdate();
  expect(api.previewOperation).toHaveBeenCalledWith({
    kind: "publish-plugin",
    pluginId: "pstack",
    storefrontId: "storefront-one",
    conflictChoices: {},
  });
  expect(container.textContent).toContain("+1");
  await click("Voir le diff");
  expect(container.querySelector(".changes-diff-lines")?.textContent).toContain("new");
});
it("blocks publication on a red check and rechecks without applying", async () => {
  const api = await render();
  api.previewOperation.mockResolvedValue({
    status: "blocked",
    reason: "publication-checks",
    diagnostic: "Blocked",
    plan: {
      ...plan,
      publication: {
        ...plan.publication,
        findings: [
          {
            severity: "error",
            code: "personal-path",
            message: "Personal path",
            fix: "Use relative paths",
            file: "skills/review/SKILL.md",
            line: 41,
            excerpt: "/Users/example/private",
          },
        ],
      },
    },
  } as never);
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  const publish = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.textContent === "Publier la mise à jour")
    .at(-1)!;
  expect(publish.disabled).toBe(true);
  expect(container.textContent).toContain("ligne 41");
  await click("Revérifier");
  expect(api.applyOperation).not.toHaveBeenCalled();
});
it("opens a plugin menu and selects its package for a new skill", async () => {
  await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="marketplace"] .canvas-node')!.click());
  await click("Plugins et vitrines");
  await click("Plus d'actions pour pstack");
  expect(container.querySelector(".canvas-menu")?.textContent).toContain("Voir dans public-tools");
  await click("Nouveau skill dans ce plugin");
  expect(
    [...container.querySelectorAll<HTMLLabelElement>(".skill-plugin-pick")]
      .find((label) => label.textContent?.includes("pstack"))
      ?.querySelector<HTMLInputElement>("input")?.checked,
  ).toBe(true);
});

it("lists behind publications in Review and fixes storefront approvals in Settings", async () => {
  await render();
  await click("À valider");
  expect(container.textContent).toContain("pstack a changé depuis sa publication dans public-tools");
  await click("Voir et publier");
  expect(container.querySelector('[data-testid="publish-sheet"]')).not.toBeNull();
  await click("Retour");
  await click("Réglages");
  expect(container.textContent).toContain("Mes vitrines");
  expect(container.textContent).toContain("Toujours dans Omni");
  expect(container.textContent).toContain("Omni ne pousse que vos vitrines, quand vous publiez.");
});
it("disables plugins without descriptions in the publication picker", async () => {
  await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Publier un plugin…");
  const rows = [...container.querySelectorAll<HTMLLabelElement>(".storefront-plugin-picker label")];
  expect(
    rows.find((row) => row.textContent?.includes("Other"))?.querySelector<HTMLInputElement>("input")?.disabled,
  ).toBe(true);
  expect(container.textContent).toContain("décrivez-le d'abord");
});
it("requires a choice for each conflicting file before publication", async () => {
  const api = await render();
  api.previewOperation.mockImplementation(async (request?: unknown) => {
    const choices = (request as { conflictChoices?: Record<string, string> }).conflictChoices ?? {};
    return {
      status: "ready",
      plan: {
        ...plan,
        publication: {
          ...plan.publication,
          files: [{ ...plan.publication.files[0], classification: "conflict" }],
          conflicts: Object.keys(choices).length ? [] : ["skills/review/SKILL.md"],
        },
      },
    } as never;
  });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  expect(container.querySelector<HTMLButtonElement>(".sh-foot .is-primary")!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>('input[value="take-workshop"]')!.click());
  expect(api.previewOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({ conflictChoices: { "skills/review/SKILL.md": "take-workshop" } }),
  );
  expect(container.querySelector<HTMLButtonElement>(".sh-foot .is-primary")!.disabled).toBe(false);
});
it("copies a ready correction message with the plugin, file and line", async () => {
  const api = await render();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  api.previewOperation.mockResolvedValue({
    status: "blocked",
    reason: "publication-checks",
    diagnostic: "Blocked",
    plan: {
      ...plan,
      publication: {
        ...plan.publication,
        findings: [
          {
            severity: "error",
            code: "personal-path",
            message: "Personal path",
            fix: "Use relative paths",
            file: "skills/review/SKILL.md",
            line: 41,
            excerpt: "private path",
          },
        ],
      },
    },
  } as never);
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  await click("Corriger avec mon agent");
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("plugin pstack"));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("skills/review/SKILL.md:41"));
  expect(api.applyOperation).not.toHaveBeenCalled();
});
const publicationReceipt = {
  operationId: "published-1",
  kind: "publish-plugin" as const,
  status: "applied" as const,
  appliedAt: "2026-10-12T10:00:00.000Z",
  displayTarget: "pstack",
  actions: [],
  registered: { sourceId: "storefront-one" },
  git: { mode: "commit" as const },
  publication: {
    state: "pushed" as const,
    storefrontId: "storefront-one",
    pluginId: "pstack",
    branch: "main",
    remoteUrl: "https://github.com/fixture/public-tools.git",
  },
};
it("claims GitHub success only from a pushed receipt", async () => {
  const api = await openUpdate();
  api.applyOperation.mockResolvedValue({ status: "applied", receipt: publicationReceipt });
  await click("Publier la mise à jour");
  expect(container.querySelector(".canvas-toast")?.textContent).toContain(
    "pstack publié dans public-tools — poussé sur GitHub",
  );
});
it("keeps a committed but unpushed receipt visible and previews its retry", async () => {
  const api = await openUpdate();
  api.applyOperation.mockResolvedValue({
    status: "failed",
    receipt: {
      ...publicationReceipt,
      status: "failed",
      publication: { ...publicationReceipt.publication, state: "committed-not-pushed" },
    },
  });
  await click("Publier la mise à jour");
  expect(container.textContent).toContain("pas poussé sur GitHub");
  expect(container.querySelector(".canvas-toast")).toBeNull();
  await click("Réessayer");
  expect(api.previewOperation).toHaveBeenLastCalledWith({ kind: "retry-push", operationId: "published-1" });
});

it("keeps an up-to-date storefront quiet", async () => {
  await render({ behind: false });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  const sheet = container.querySelector('[data-testid="storefront-sheet"]')!;
  expect(sheet.textContent).toContain("à jour");
  expect(sheet.textContent).not.toContain("Voir et publier");
});
it("never draws a storefront-to-project wire for a retained legacy use", async () => {
  await render({ legacyStorefrontUse: true });
  const wires = [...container.querySelectorAll(".canvas-wire")].map((wire) => wire.getAttribute("data-wire-id")!);
  expect(wires.some((id) => id.includes("storefront-one") && id.endsWith(":publication"))).toBe(true);
  expect(wires.filter((id) => id.includes("storefront-one") && id.includes("project-one"))).toEqual([]);
});
it("shows publication and creation history without undo for pushed content", async () => {
  const api = await render();
  api.listOperations.mockResolvedValue({
    status: "ready",
    receipts: [
      publicationReceipt,
      {
        ...publicationReceipt,
        operationId: "creation-1",
        kind: "create-storefront",
        publication: { ...publicationReceipt.publication, pluginId: undefined },
      },
    ],
  });
  await click("Historique");
  const history = container.querySelector('[data-testid="canvas-history-sheet"]')!;
  expect(history.textContent).toContain("pstack publié dans public-tools");
  expect(history.textContent).toContain("Vitrine public-tools créée");
  expect(history.textContent).not.toContain("Annuler");
});
it("requires Omni authorization before applying an agent's publication request", async () => {
  const request: AgentRequest = {
    requestId: "agent-publish",
    createdAt: "2026-10-12T10:00:00.000Z",
    expiresAt: "2026-10-13T10:00:00.000Z",
    status: "pending",
    harness: "codex",
    approval: "omni",
    approvalReason: { code: "public-publication" },
    request: { kind: "publish-plugin", pluginId: "pstack", storefrontId: "storefront-one" },
    plan,
  };
  const api = await render({ initialPublicationRequest: request });
  expect(api.applyOperation).not.toHaveBeenCalled();
  expect(api.beginAgentApply).not.toHaveBeenCalled();
  api.applyOperation.mockResolvedValue({ status: "applied", receipt: publicationReceipt });
  await click("Publier");
  expect(api.beginAgentApply).toHaveBeenCalledWith({ requestId: "agent-publish" });
  expect(api.applyOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      provenance: expect.objectContaining({ approval: "omni", agent: expect.objectContaining({ harness: "codex" }) }),
    }),
  );
  expect(api.resolveAgentRequest).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: "agent-publish", operationIds: ["published-1"] }),
  );
  expect(api.endAgentApply).toHaveBeenCalledWith({ requestId: "agent-publish", leaseId: "lease-1" });
});

it("keeps checks and effects visible for a new storefront before its inputs are filled", async () => {
  const api = await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Publier un plugin…");
  await act(async () =>
    container.querySelector<HTMLInputElement>(".storefront-plugin-picker input:not(:disabled)")!.click(),
  );
  const newRow = [...container.querySelectorAll<HTMLLabelElement>(".storefront-pick")].find((row) =>
    row.textContent?.includes("＋ Nouvelle vitrine"),
  )!;
  await act(async () => newRow.querySelector<HTMLInputElement>("input")!.click());
  expect(container.textContent).toContain("Vérifications avant publication");
  expect(container.textContent).toContain("Ce qui change");
  expect(container.textContent).toContain("nouveau dépôt public fixture/nom");
  expect(container.querySelector(".storefront-new-fields .storefront-label")).toBeNull();
  expect(container.textContent).not.toContain("Un thème par vitrine");
  expect(container.querySelector(".sh-foot")?.textContent).not.toContain("point rouge");
  expect(container.querySelector<HTMLButtonElement>(".sh-foot .is-primary")!.disabled).toBe(true);
  expect(api.applyOperation).not.toHaveBeenCalled();
});
it("uses the shared node info icon for storefronts and explains the storefront", async () => {
  await render();
  const info = container.querySelector<HTMLButtonElement>('[data-kind="storefront"] button.canvas-node-info')!;
  expect(info.querySelector("svg")).not.toBeNull();
  await act(async () => info.click());
  expect(container.textContent).toContain("Vitrine");
});
it("shows the English description and a dedicated update subtitle", async () => {
  await openUpdate();
  expect(container.querySelector(".sh-sub")?.textContent).toBe("dans public-tools · public");
});
it("opens the registered repository from the sheet and the publication toast", async () => {
  const api = await render();
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  expect(container.querySelector(".sh-sub")?.textContent).toBe("Agent skills for content creation.");
  await click("Ouvrir sur GitHub");
  expect(api.openStorefrontRepository).toHaveBeenCalledWith({ sourceId: "storefront-one" });
  await click("Voir et publier");
  api.applyOperation.mockResolvedValue({ status: "applied", receipt: publicationReceipt });
  await click("Publier la mise à jour");
  await click("Voir sur GitHub");
  expect(api.openStorefrontRepository).toHaveBeenCalledTimes(2);
});

it("keeps a saved unpushed publication visible in its storefront sheet", async () => {
  await render({
    receipts: [
      {
        ...publicationReceipt,
        status: "failed",
        publication: { ...publicationReceipt.publication, state: "committed-not-pushed" },
      },
    ],
  });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  expect(container.querySelector(".storefront-callout.is-warn")?.textContent).toContain("pas poussé sur GitHub");
  await click("Réessayer");
  expect(container.querySelector('[data-testid="publish-sheet"]')).not.toBeNull();
});
it("uses public-facing labels in English without exposing source roles", async () => {
  await render({ language: "en" });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  expect(container.textContent).toContain("Storefront");
  expect(container.textContent).not.toMatch(/\bworkshop\b/u);
  await click("Review and publish");
  expect(container.querySelector(".sh-sub")?.textContent).toBe("in public-tools · public");
});
it("asks for an existing GitHub repository when publishing without gh", async () => {
  const api = await render();
  api.readStorefrontCapabilities.mockResolvedValue({ gh: "unavailable" } as never);
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Publier un plugin…");
  await act(async () =>
    container.querySelector<HTMLInputElement>(".storefront-plugin-picker input:not(:disabled)")!.click(),
  );
  const row = [...container.querySelectorAll<HTMLLabelElement>(".storefront-pick")].find((row) =>
    row.textContent?.includes("＋ Nouvelle vitrine"),
  )!;
  await act(async () => row.querySelector<HTMLInputElement>("input")!.click());
  expect(container.querySelector('input[placeholder="https://github.com/owner/mobile-app-shipping"]')).not.toBeNull();
  expect(container.querySelector<HTMLButtonElement>(".sh-foot .is-primary")!.disabled).toBe(true);
  expect(api.applyOperation).not.toHaveBeenCalled();
});

it.each(["~/remotes/public-tools.git", "https://git.example.com/team/public-tools.git"])(
  "shows the real non-GitHub destination %s in the sheet, effects, picker and Review",
  async (originUrl) => {
    await render({ githubRepository: null, originUrl });
    await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
    const sheet = container.querySelector('[data-testid="storefront-sheet"]')!;
    expect(sheet.textContent).toContain(originUrl);
    await click("Voir et publier");
    const effects = [...container.querySelectorAll(".sec")].find(
      (section) => section.querySelector("h3")?.textContent === "Ce qui change",
    )!;
    expect(effects.textContent).toContain(`push sur ${originUrl}`);
    expect(effects.textContent).not.toContain("github.com/");
    await click("Retour");
    await click("Publier un plugin…");
    await act(async () =>
      container.querySelector<HTMLInputElement>(".storefront-plugin-picker input:not(:disabled)")!.click(),
    );
    expect(container.querySelector(".storefront-pickwrap")!.textContent).toContain(originUrl);
    await click("Annuler");
    await click("À valider");
    expect(container.querySelector('[data-testid="canvas-review-sheet"]')!.textContent).toContain(originUrl);
    await click("Réglages");
    expect(container.querySelector('[data-testid="canvas-settings-sheet"]')!.textContent).toContain(originUrl);
  },
);

it("shows a canonical GitHub destination without constructing a placeholder URL", async () => {
  await openUpdate();
  expect(container.querySelector('[data-testid="publish-sheet"]')!.textContent).toContain(
    "push sur github.com/fixture/public-tools",
  );
});

it.each([true, false])("returns to the refreshed storefront after a pushed receipt, GitHub=%s", async (github) => {
  const originUrl = github ? "https://github.com/fixture/public-tools.git" : "/tmp/remotes/public-tools.git";
  const api = await render({ githubRepository: github ? "fixture/public-tools" : null, originUrl });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  const drift = await api.readStorefrontDrift();
  api.readStorefrontDrift.mockResolvedValue({
    ...drift,
    storefronts: drift.storefronts.map((storefront) => ({
      ...storefront,
      behind: false,
      behindPlugins: 0,
      plugins: storefront.plugins.map((plugin) => ({ ...plugin, behind: false, toPublish: 0 })),
    })),
  });
  const receipt = { ...publicationReceipt, publication: { ...publicationReceipt.publication, remoteUrl: originUrl } };
  api.listOperations.mockResolvedValue({ status: "ready", receipts: [receipt] });
  api.applyOperation.mockResolvedValue({ status: "applied", receipt });
  await click("Publier la mise à jour");
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(container.querySelector('[data-testid="publish-sheet"]')).toBeNull();
  const sheet = container.querySelector('[data-testid="storefront-sheet"]');
  expect(sheet).not.toBeNull();
  expect(sheet!.textContent).toContain("à jour");
  expect(sheet!.textContent).not.toContain("Voir et publier");
  const toast = container.querySelector(".canvas-toast")!;
  expect(toast.textContent).toContain(`pstack publié dans public-tools — poussé${github ? " sur GitHub" : ""}`);
  expect(toast.textContent?.includes("Voir sur GitHub")).toBe(github);
  expect(toast.textContent).not.toContain("Annuler");
});

it("keeps an unread destination as plain text without inventing a GitHub URL", async () => {
  await render({ githubRepository: null });
  await act(async () => container.querySelector<HTMLElement>('[data-kind="storefront"] .canvas-node')!.click());
  await click("Voir et publier");
  const effects = [...container.querySelectorAll(".sec")].find(
    (section) => section.querySelector("h3")?.textContent === "Ce qui change",
  )!;
  expect(effects.textContent).toContain("Pas encore lu");
  expect(effects.textContent).not.toContain("github.com/");
});
