import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSkillManagementService,
  type SkillEffectDraft,
  type SkillManagementEffects,
} from "../../src/application/skill-management";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { applyManagedSkill } from "../../src/main/agent-gateway/router-management";

const roots: string[] = [];
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const input = {
  kind: "write-skill" as const,
  sourceId: "personal",
  packageId: "packages/tools",
  mode: "create" as const,
  folderName: "demo",
  files: [{ path: "SKILL.md", content: "# A\n" }],
};
const intent = { kind: "write" as const, request: input };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])(
  "recomputes a managed request after restart and withholds changed effects (%s)",
  async (changed) => {
    const root = await mkdtemp(join(tmpdir(), "omni-managed-restart-"));
    roots.push(root);
    let content = "# A\n";
    let sequence = 0;
    const effects: SkillManagementEffects = {
      preview: vi.fn(async (): Promise<SkillEffectDraft> => {
        const file = {
          rootId: "source:personal",
          relativePath: "packages/tools/skills/demo/SKILL.md",
          change: "add" as const,
          afterHash: createHash("sha256").update(content).digest("hex"),
        };
        const scope = { sourceId: "personal", packageId: "packages/tools", targets: [] };
        const plan = {
          planId: `plan-${++sequence}`,
          kind: "write-skill" as const,
          displayTarget: "personal",
          actions: [{ kind: "write-file" as const, relativePath: file.relativePath, afterHash: file.afterHash }],
          git: { mode: "disabled" as const, warnings: [] },
        };
        return {
          status: "ready",
          planId: plan.planId,
          scope,
          steps: [{ stepId: "source", scope, plan, files: [file], bindingEffects: [] }],
          fingerprint: { scope, files: [file], bindings: [] },
          backupReferences: [],
        };
      }),
      prepare: vi.fn(async () => undefined),
      validateAuthorization: vi.fn(async () => undefined),
      apply: vi.fn(async () => ({
        status: "applied" as const,
        source: { status: "created" as const, sourceId: "personal" },
        targets: [],
        receiptIds: ["receipt"],
        issues: [],
        recoveryAvailable: false,
      })),
    };
    const journal = createSkillOperationJournal(join(root, "journal"));
    const requestsPath = join(root, "requests.json");
    const requests = createAgentRequestsStore(requestsPath, () => NOW);
    const requestId = "request";
    const actor = { kind: "mcp" as const, requestId, harness: "codex" as const };
    const first = createSkillManagementService({ effects, journal, now: () => NOW, createId: () => "intent" });
    const preview = await first.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    await requests.create({
      requestId,
      request: input,
      skillIntent: intent,
      intentId: preview.intentId,
      approval: "conversation",
      plan: preview.steps[0].plan,
      harness: "codex",
    });
    const reopenedRequests = createAgentRequestsStore(requestsPath, () => NOW + 3600000);
    const saved = await reopenedRequests.get(requestId);
    if (!saved) throw new Error("Expected the persisted request.");
    const restarted = createSkillManagementService({
      effects,
      journal: createSkillOperationJournal(join(root, "journal")),
      now: () => NOW + 3600000,
    });
    await restarted.initialize();
    if (changed) content = "# B\n";
    const result = await applyManagedSkill({
      request: saved,
      service: restarted,
      requests: reopenedRequests,
      operationStore: {} as never,
    });
    expect(result).toMatchObject(
      changed
        ? { status: "stale", message: "The files changed; preview again." }
        : { status: "applied", receiptIds: ["receipt"] },
    );
    expect(effects.preview).toHaveBeenLastCalledWith(intent, actor, preview.intentId, NOW);
    expect(effects.apply).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(await reopenedRequests.get(requestId)).toMatchObject({ status: changed ? "awaiting-agent" : "approved" });
  },
);
