// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { CanvasToastProvider } from "../../src/renderer/canvas/CanvasToast";
import { useAgentMaintenance } from "../../src/renderer/agents/use-agent-maintenance";
import type { DesktopApi } from "../../src/shared/ipc";
import type { AgentHarness } from "../../src/shared/agents-ipc";
const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
function Maintenance({ api }: Readonly<{ api: Partial<DesktopApi> }>): ReactElement {
  useAgentMaintenance(api, () => undefined);
  return <span />;
}
it.each([
  ["fr", ["claude-code"], "Omni est passé en 1.2.3 — Claude Code est à jour."],
  ["fr", ["claude-code", "codex"], "Omni est passé en 1.2.3 — Claude Code et Codex sont à jour."],
  ["en", ["codex"], "Omni is now on 1.2.3 — Codex is up to date."],
  ["en", ["claude-code", "codex"], "Omni is now on 1.2.3 — Claude Code and Codex are up to date."],
] as const)("agrees the %s automatic update toast with %s", async (language, harnesses, expected) => {
  const host = document.createElement("div");
  host.className = "resource-canvas";
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const api = {
    getAgentMaintenance: async () => ({
      updating: [],
      failures: [],
      notice: { id: "notice", version: "1.2.3", harnesses: harnesses as readonly AgentHarness[] },
    }),
  };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage={language}>
        <CanvasToastProvider>
          <Maintenance api={api} />
        </CanvasToastProvider>
      </I18nProvider>,
    ),
  );
  expect(host.querySelector(".toast > span")?.textContent).toBe(expected);
});
