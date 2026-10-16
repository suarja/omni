// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createSkillManagementService,
  type SkillEffectDraft,
  type SkillManagementEffects,
} from "../../src/application/skill-management";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentRequestRefresher } from "../../src/main/agent-gateway/refresh-request";
import { createAgentApply } from "../../src/main/agent-gateway/router-apply";
import { registerSkillManagementIpcHandlers } from "../../src/main/skill-management/ipc";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import { snapshot, resourceFixture } from "../fixtures/resource-catalogue";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

it("applies one updated preview under StrictMode and returns applied to the waiting agent", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const directory = await mkdtemp(join(tmpdir(), "omni-approval-strict-"));
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  try {
    const skillPath = join(directory, "SKILL.md");
    await writeFile(skillPath, "# Original\n");
    const input = {
      kind: "write-skill" as const,
      sourceId: "source-one",
      packageId: "plugins/pstack",
      mode: "update" as const,
      replaceFolder: true,
      folderName: "release-notes",
      files: [{ path: "SKILL.md", content: "# Approved\n" }],
    };
    const intent = { kind: "write" as const, request: input };
    const scope = { sourceId: input.sourceId, packageId: input.packageId, targets: [] };
    let sequence = 0;
    const receipt = {
      operationId: "receipt",
      kind: "write-skill" as const,
      status: "applied" as const,
      appliedAt: new Date().toISOString(),
      actions: [],
      git: { mode: "disabled" as const },
      displayTarget: input.packageId,
      registered: null,
    };
    const effects: SkillManagementEffects = {
      preview: async (): Promise<SkillEffectDraft> => {
        const before = await readFile(skillPath, "utf8");
        const file = {
          rootId: input.sourceId,
          relativePath: "skills/release-notes/SKILL.md",
          change: "change" as const,
          beforeHash: createHash("sha256").update(before).digest("hex"),
          afterHash: createHash("sha256").update(input.files[0].content).digest("hex"),
          diff: `-${before}+${input.files[0].content}`,
        };
        const deletion = {
          rootId: input.sourceId,
          relativePath: "skills/release-notes/old.md",
          change: "delete" as const,
          beforeHash: "a".repeat(64),
        };
        const plan = {
          kind: "write-skill" as const,
          planId: `plan-${++sequence}`,
          displayTarget: input.packageId,
          actions: [
            {
              kind: "write-file" as const,
              relativePath: file.relativePath,
              beforeHash: file.beforeHash,
              afterHash: file.afterHash,
              diff: file.diff,
            },
            { kind: "delete-file" as const, relativePath: deletion.relativePath, beforeHash: deletion.beforeHash },
          ],
          git: { mode: "disabled" as const, warnings: [] },
        };
        return {
          status: "ready",
          planId: plan.planId,
          scope,
          steps: [{ stepId: "source", scope, plan, files: [file, deletion], bindingEffects: [] }],
          fingerprint: { scope, files: [file, deletion], bindings: [] },
          backupReferences: [],
        };
      },
      prepare: async () => undefined,
      validateAuthorization: async () => undefined,
      apply: vi.fn(async () => {
        await writeFile(skillPath, input.files[0].content);
        return {
          status: "applied" as const,
          source: { status: "updated" as const, sourceId: input.sourceId },
          targets: [],
          receiptIds: ["receipt"],
          receipts: [receipt],
          issues: [],
          recoveryAvailable: false,
        };
      }),
    };
    const service = createSkillManagementService({
      effects,
      journal: createSkillOperationJournal(join(directory, "journal")),
    });
    const requests = createAgentRequestsStore(join(directory, "requests.json"));
    const initial = await service.preview(intent, { kind: "mcp", requestId: "request", harness: "codex" });
    if (initial.status !== "ready") throw new Error("Expected a ready preview.");
    await requests.create({
      requestId: "request",
      request: input,
      skillIntent: intent,
      intentId: initial.intentId,
      plan: initial.steps[0].plan,
      harness: "codex",
      approvalReason: { code: "deletes-files", count: 1 },
    });
    await writeFile(skillPath, "# Manually changed\n");
    const refreshAgentRequest = vi.fn(
      createAgentRequestRefresher({
        requests,
        service,
        registry: {
          listRegistry: async () => ({
            status: "ready",
            registry: { sources: [{ ref: { id: input.sourceId }, ownership: "personal" }] },
          }),
        } as never,
        settings: {
          read: async () => ({
            schemaVersion: 8,
            git: { commitChanges: false },
            ai: DEFAULT_AI_SETTINGS,
            features: DEFAULT_FEATURES,
            externalLibrary: { updates: "auto" as const },
            agents: {
              approval: { projects: "conversation", personalMarketplace: "conversation" },
              guard: { warnProjectIds: [] },
            },
          }),
        } as never,
        previewPlan: vi.fn(),
      }),
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const agentApply = createAgentApply({
      requests: {
        ...requests,
        wait: (id, ms) => {
          const pending = requests.wait(id, ms);
          entered();
          return pending;
        },
      },
      operations: {} as never,
      skillManagement: service,
      operationStore: { read: async () => ({ status: "ready", receipts: [receipt] }) } as never,
      previewPlan: vi.fn(),
      receipt: vi.fn(),
      now: Date.now,
    });
    const waiting = agentApply({ requestId: "request", waitMs: 50000 }, {} as never);
    await started;
    let previewReady!: () => void;
    const opened = new Promise<void>((resolve) => {
      previewReady = resolve;
    });
    const handlers = registerSkillManagementIpcHandlers(() => undefined, service, requests);
    const api = {
      ...handlers,
      refreshSkillOperation: async (input: Parameters<NonNullable<typeof handlers.refreshSkillOperation>>[0]) => {
        const response = await handlers.refreshSkillOperation(input);
        if (response.status === "ready" && response.intentId !== initial.intentId) previewReady();
        return response;
      },
      refreshAgentRequest,
      listAgentRequests: async () => ({ status: "ready" as const, requests: await requests.list() }),
    };
    await act(async () =>
      root.render(
        <StrictMode>
          <I18nProvider initialLanguage="en">
            <ResourceCanvas
              api={api}
              context={{ kind: "entry", entry: resourceFixture.sourceRef }}
              initialSkillIntent={intent}
              initialSkillIntentId={initial.intentId}
              requestId="request"
              onEnsureGrant={async () => "grant"}
              onNavigate={vi.fn()}
              onNavigateDestination={vi.fn()}
              onRefresh={vi.fn()}
              snapshot={snapshot}
            />
          </I18nProvider>
        </StrictMode>,
      ),
    );
    await act(async () => opened);
    expect(refreshAgentRequest).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Files changed since the agent asked");
    expect(container.querySelector("[data-testid='changes-diff']")?.textContent).toContain("Manually changed");
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    await act(async () => {
      await waiting;
    });
    expect(await readFile(skillPath, "utf8")).toBe("# Approved\n");
    expect(await requests.get("request")).toMatchObject({ status: "approved", applyOutcome: { status: "applied" } });
    expect(await waiting).toMatchObject({ status: "applied" });
    expect(effects.apply).toHaveBeenCalledTimes(1);
    expect(refreshAgentRequest).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    await rm(directory, { recursive: true, force: true });
  }
});
