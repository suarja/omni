// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { WorkshopDeliveryPanel } from "../../src/renderer/canvas/delivery/WorkshopDeliveryPanel";
import type { WorkshopDeliveryStatus } from "../../src/shared/workshop-delivery-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.replaceChildren();
});
const status: WorkshopDeliveryStatus = {
  status: "ready",
  workshop: {
    sourceId: "workshop",
    name: "Workshop",
    sync: { status: "push-failed", ahead: 2, behind: 0, diagnostic: "Offline. Retry." },
  },
  plugins: {
    status: "ready",
    behind: 1,
    diagnostics: [],
    installations: [
      {
        harness: "claude-code",
        name: "truth",
        marketplace: "fixture",
        state: "behind",
        commands: [{ executable: "claude", args: ["plugin", "update", "truth@fixture", "--scope", "user", "--json"] }],
      },
    ],
  },
  projects: [{ projectId: "project", conflicts: 2, updates: 2, unavailable: 0 }],
  diagnostics: [],
};
async function render(language: "en" | "fr" = "en") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const api: Partial<DesktopApi> = {
    previewOperation: vi.fn<NonNullable<DesktopApi["previewOperation"]>>(async () => ({
      status: "ready",
      plan: {
        planId: "preview",
        kind: "update-workshop-plugins",
        displayTarget: "claude-code",
        actions: [],
        git: { mode: "disabled", warnings: [] },
        notes: ["claude plugin update truth@fixture --scope user --json"],
        workshopDelivery: { fingerprint: "a".repeat(64), commands: status.plugins.installations[0]!.commands },
      },
    })),
    applyOperation: vi.fn<NonNullable<DesktopApi["applyOperation"]>>(async () => ({
      status: "applied",
      receipt: {
        operationId: "operation",
        kind: "update-workshop-plugins",
        status: "applied",
        appliedAt: "2026-10-22T00:00:00.000Z",
        displayTarget: "claude-code",
        actions: [],
        git: { mode: "disabled" },
        registered: null,
      },
    })),
  };
  await act(async () =>
    root!.render(
      <I18nProvider initialLanguage={language}>
        <WorkshopDeliveryPanel status={status} api={api} onRefresh={vi.fn()} onApplyingChange={vi.fn()} />
      </I18nProvider>,
    ),
  );
  return { node, api };
}
it("shows push failure reasons, counts and the exact provider commands", async () => {
  const { node } = await render();
  expect(node.textContent).toContain("Offline. Retry.");
  expect(node.textContent).toContain("2 unpushed commits");
  expect(node.textContent).toContain("1 installed plugin behind");
  expect(node.textContent).toContain("claude plugin update truth@fixture --scope user --json");
});
it("previews an update and requires a second explicit approval before executing it", async () => {
  const { node, api } = await render();
  const update = [...node.querySelectorAll("button")].find((b) => b.textContent === "Update installed plugins")!;
  await act(async () => update.click());
  expect(api.previewOperation).toHaveBeenCalledWith({ kind: "update-workshop-plugins", harness: "claude-code" });
  expect(api.applyOperation).not.toHaveBeenCalled();
  await act(async () => [...node.querySelectorAll("button")].find((b) => b.textContent === "Approve and run")!.click());
  expect(api.applyOperation).toHaveBeenCalledWith({ planId: "preview", provenance: { approval: "omni" } });
});
it("keeps the retry action and counts readable in French", async () => {
  const { node } = await render("fr");
  expect(node.textContent).toContain("Réessayer le push");
  expect(node.textContent).toContain("2 commits non poussés");
});
