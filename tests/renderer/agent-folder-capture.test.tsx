// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentRouter } from "../../src/main/agent-gateway/router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Observation } from "../../src/domain/project-source-registry";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import type { AppShellProps } from "../../src/renderer/shell/routes";
import type { Route } from "../../src/renderer/navigation";
import { AppShell } from "../../src/renderer/shell/AppShell";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import { observationKey } from "../../src/renderer/app-helpers";
import { artifact, personal, personalObservation, project, readyPlan } from "./brief-12-import-helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alpha = { ...project, ref: { kind: "project" as const, id: "alpha" }, displayName: "Alpha" };
const sourcePath = ".claude/skills/capture-me";
const observed: Observation = {
  ...personalObservation,
  subject: alpha.ref,
  inventory: {
    ...personalObservation.inventory,
    rootHandle: "project-grant",
    packages: [],
    marketplace: undefined,
    artifacts: [
      {
        ...artifact,
        kind: "skill",
        scope: "project",
        relativePath: `${sourcePath}/SKILL.md`,
        displayPath: `${sourcePath}/SKILL.md`,
        projectionPaths: [`${sourcePath}/SKILL.md`],
      },
    ],
  },
};
const target: Observation = {
  ...personalObservation,
  inventory: {
    ...personalObservation.inventory,
    packages: [
      {
        ...personalObservation.inventory.packages![0]!,
        id: "packages/tools",
        displayName: "tools",
        relativeRoot: "packages/tools",
      },
    ],
  },
};
const plan = readyPlan({ displayTarget: "packages/tools" }).plan;
const receipt: OperationReceipt = {
  operationId: "capture-receipt",
  kind: "import-artifact",
  status: "applied",
  appliedAt: "2026-10-11T10:01:00Z",
  displayTarget: "packages/tools",
  actions: [],
  git: { mode: "disabled" },
  registered: null,
};

it.each(["active", "cached", "delayed", "projection", "unrelated", "missing"])(
  "reviews a %s project folder capture using its exact evidence",
  async (mode) => {
    const userDataPath = await mkdtemp(join(tmpdir(), "omni-t4b-capture-"));
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "requests.json"), () =>
      Date.parse("2026-10-11T10:00:00Z"),
    );
    const savedReceipts: OperationReceipt[] = [];
    const router = createAgentRouter({
      userDataPath,
      appVersion: "test",
      requests,
      registry: {
        getGrantForEntry: async () => "project-grant",
        listRegistry: async () => ({
          status: "ready",
          registry: { revision: 1, projects: [alpha], sources: [personal] },
        }),
        observeRegisteredEntry: async () => ({ status: "observed", observation: target }),
      } as never,
      bindings: {} as never,
      operations: { previewOperation: async () => ({ status: "ready", plan }) } as never,
      operationStore: { read: async () => ({ status: "ready", receipts: savedReceipts }) } as never,
      settingsStore: {
        read: async () => ({
          schemaVersion: 2,
          git: { commitChanges: false },
          agents: { approval: { personalMarketplace: "omni", projects: "omni" } },
        }),
      } as never,
    });
    const client = { name: "test", version: "1", harness: "claude-code" as const };
    const preview = (await router.handle(
      "preview_capture",
      { projectId: "alpha", relativePath: sourcePath, target: { packageId: "packages/tools" }, askInOmni: true },
      client,
    )) as { requestId: string };
    const pending = (await requests.get(preview.requestId))!;
    expect(pending.status).toBe("pending");
    const agentWaiting =
      mode === "missing" ? undefined : router.handle("apply", { requestId: pending.requestId, waitMs: 5000 }, client);
    const resolveAgentRequest = vi.fn(async () => requests.resolve(pending.requestId, receipt.operationId));
    const api = {
      listAgentRequests: vi.fn(async () => ({ status: "ready", requests: await requests.list() })),
      refreshAgentRequest: vi.fn(async () => (await requests.get(pending.requestId))!),
      applyOperation: vi.fn(async () => {
        savedReceipts.push(receipt);
        return { status: "applied", receipt };
      }),
      resolveAgentRequest,
      listOperations: vi.fn(async () => ({ status: "ready", receipts: [] })),
    } as unknown as DesktopApi;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let load: (() => void) | undefined;
    const projectionObservation = {
      ...observed,
      inventory: {
        ...observed.inventory,
        artifacts: [{ ...observed.inventory.artifacts[0]!, relativePath: ".agents/skills/capture-me/SKILL.md" }],
      },
    };
    function Harness(): React.ReactElement {
      const [route, navigate] = useState<Route>({
        screen: "resource-canvas",
        context: { kind: "workspace" },
        initialRailSurface: "review",
      });
      const [loaded, setLoaded] = useState(mode !== "delayed");
      load = () => setLoaded(true);
      const observation =
        mode === "projection"
          ? projectionObservation
          : mode === "missing"
            ? { ...observed, inventory: { ...observed.inventory, artifacts: [] } }
            : observed;
      const props: AppShellProps = {
        api,
        route,
        registry: { status: "ready", registry: { revision: 1, projects: [alpha], sources: [personal] } },
        observations: loaded ? { [observationKey(alpha.ref)]: { status: "observed", observation } } : {},
        destinationObservation:
          loaded && mode !== "cached"
            ? { status: "observed", observation: mode === "unrelated" ? personalObservation : observation }
            : null,
        marketplaceObservation: target,
        openedEntry: { status: "granted", entry: alpha, grantHandle: "project-grant" },
        destinationAudit: {
          status: "idle",
          report: null,
          error: null,
          progress: { completed: 0, total: 0 },
          start: vi.fn(),
          cancel: vi.fn(),
          refresh: vi.fn(),
        },
        mode: "light",
        registryBusy: false,
        registryMutationBusy: false,
        registryError: null,
        onModeChange: vi.fn(),
        onNavigate: vi.fn(),
        onNavigateToRoute: navigate,
        onReaudit: vi.fn(),
        onRefreshRegistry: vi.fn(async () => null),
        onRetry: vi.fn(),
      };
      return (
        <ThemeProvider>
          <I18nProvider initialLanguage="fr">
            <AppShell {...props} />
          </I18nProvider>
        </ThemeProvider>
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      const open = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Ouvrir",
      );
      expect(open).toBeDefined();
      await act(async () => open!.click());
      expect(container.querySelector(".changes-header h2")?.textContent).toBe("Capture de capture-me");
      if (mode === "delayed" || mode === "missing") {
        expect(container.querySelector(".changes-body")?.textContent).toContain("Cet artefact n’est pas disponible");
        expect(api.applyOperation).not.toHaveBeenCalled();
      }
      if (mode === "missing") {
        expect(container.querySelector('[data-testid="import-apply"]')).toBeNull();
        expect((await requests.get(pending.requestId))?.status).toBe("pending");
        return;
      }
      if (mode === "delayed") await act(async () => load?.());
      const apply = container.querySelector<HTMLButtonElement>('[data-testid="import-apply"]');
      expect(apply).not.toBeNull();
      expect(apply?.disabled).toBe(false);
      await act(async () => apply!.click());
      expect(api.applyOperation).toHaveBeenCalledWith({ planId: plan.planId });
      expect(api.resolveAgentRequest).toHaveBeenCalledWith({
        requestId: pending.requestId,
        operationId: receipt.operationId,
      });
      await act(async () => {
        await expect(agentWaiting).resolves.toMatchObject({ status: "applied", receipt });
        await resolveAgentRequest.mock.results.at(-1)?.value;
      });
      expect((await requests.get(pending.requestId))?.status).toBe("approved");
      expect(container.querySelector("#changes-tab-result")?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await resolveAgentRequest.mock.results.at(-1)?.value;
      if ((await requests.get(pending.requestId))?.status === "pending") await requests.decline(pending.requestId);
      await agentWaiting;
      await rm(userDataPath, { recursive: true, force: true });
    }
  },
);
