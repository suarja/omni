import { describe, expect, it } from "vitest";
import type { SkillEffectStep, SkillResult } from "../../src/shared/skill-management-ipc";
import type { SkillLocationKey } from "../../src/domain/skill-reconciliation/types";
import type { SkillPropagationSummary, SkillPropagationTarget } from "../../src/shared/skill-propagation-ipc";
import {
  buildPropagationView,
  canRetryPropagationTarget,
  locationKey,
  selectPropagationIntent,
} from "../../src/renderer/canvas/changes/propagation/view-model";
import { canReviewRestore } from "../../src/renderer/canvas/changes/operation-view-model";

const loc = (
  projectId: string,
  harnessId: SkillLocationKey["harnessId"],
  folderPath = ".claude/skills/toolkit",
): SkillLocationKey => ({ projectId, harnessId, folderPath });
const target = (
  location: SkillLocationKey,
  state: SkillPropagationTarget["state"],
  result?: SkillPropagationTarget["result"],
): SkillPropagationTarget => ({ location, state, ...(result ? { result } : {}) });
const evidenceStep = (location: SkillLocationKey): SkillEffectStep => ({
  stepId: `step-${location.projectId}-${location.harnessId}`,
  scope: { targets: [{ projectId: location.projectId, harnessId: location.harnessId }] },
  plan: {} as SkillEffectStep["plan"],
  bindingEffects: [],
  files: [{ rootId: "project-root", relativePath: "SKILL.md", change: "change", diff: "exact diff" }],
  propagationEvidence: { location } as NonNullable<SkillEffectStep["propagationEvidence"]>,
});
const summary = (
  targets: readonly SkillPropagationTarget[],
  mode: SkillPropagationSummary["mode"] = "maintain-current",
): SkillPropagationSummary => ({
  mode,
  source: { sourceId: "source", packageId: "package", artifactPath: "skills/toolkit" },
  targets,
});

describe("skill propagation view model", () => {
  it("keys locations by project, harness, and exact folder", () => {
    expect(locationKey(loc("p", "codex"))).not.toBe(locationKey(loc("p", "codex", ".codex/skills/toolkit")));
  });

  it("counts distinct projects and copies while retaining evidence per harness", () => {
    const codex = loc("p1", "codex");
    const claude = loc("p1", "claude-code");
    const view = buildPropagationView(summary([target(codex, "eligible"), target(claude, "eligible")]), [
      evidenceStep(codex),
      evidenceStep(claude),
    ]);
    expect([view.projectCount, view.copyCount, view.selectedProjectCount, view.selectedCopyCount]).toEqual([
      1, 2, 1, 2,
    ]);
    expect(view.locations.map(({ files }) => files[0]?.diff)).toEqual(["exact diff", "exact diff"]);
  });

  it("maps applied, retained, failed, and unknown results to their outcome tones", () => {
    const entries: [SkillPropagationTarget["result"], string][] = [
      ["applied", "success"],
      ["retained-local", "review"],
      ["failed", "conflict"],
      ["unknown", "unknown"],
    ];
    const targets = entries.map(([result], index) => target(loc(`p${index}`, "codex"), "eligible", result));
    const view = buildPropagationView(
      summary(targets),
      targets.map(({ location }) => evidenceStep(location)),
    );
    expect(view.locations.map(({ tone }) => tone)).toEqual(entries.map(([, tone]) => tone));
  });

  it("does not select current copies or let selection hide a real result", () => {
    const current = loc("p1", "codex");
    const eligible = loc("p2", "codex");
    const results = summary([target(current, "already-current", "no-op"), target(eligible, "eligible", "failed")]);
    const view = buildPropagationView(
      summary([target(current, "already-current"), target(eligible, "eligible")]),
      [evidenceStep(current), evidenceStep(eligible)],
      [],
      { propagation: results } as never,
    );
    expect(view.locations.map(({ selected, outcome, retryable }) => [selected, outcome, retryable])).toEqual([
      [false, "no-op", false],
      [false, "failed", true],
    ]);
  });

  it("allows source-only updates and converts empty update selection into a write", () => {
    const update = {
      kind: "update-and-maintain",
      source: { sourceId: "source", packageId: "package", artifactPath: "skills/toolkit" },
      request: { mode: "update" } as never,
      locations: [loc("p", "codex")],
    } as const;
    const view = buildPropagationView(summary([], "update-and-maintain"), []);
    expect(view.canApply).toBe(true);
    expect(buildPropagationView(summary([]), []).canApply).toBe(false);
    expect(selectPropagationIntent(update, [])).toEqual({ kind: "write", request: update.request });
    expect(selectPropagationIntent({ ...update, kind: "maintain-current" } as never, [])).toBeUndefined();
  });

  it("requires matching folder evidence before marking an eligible target safe", () => {
    const wanted = loc("p", "codex", ".codex/skills/toolkit");
    const wrongFolder = loc("p", "codex", ".codex/skills/other");
    const view = buildPropagationView(summary([target(wanted, "eligible")]), [evidenceStep(wrongFolder)]);
    expect(view.locations[0]).toMatchObject({ group: "unavailable", selected: false, files: [], retryable: false });
  });

  it("shows retained base-to-local metadata without inventing diff text", () => {
    const retained = {
      ...target(loc("p", "codex"), "retained-local"),
      baseRevision: {
        algorithm: "omni-tree-v1",
        hash: "base",
        files: [{ path: "SKILL.md", hash: "before", byteLength: 4 }],
      },
      localRevision: {
        algorithm: "omni-tree-v1",
        hash: "local",
        files: [
          { path: "SKILL.md", hash: "after", byteLength: 5 },
          { path: "extra.md", hash: "extra", byteLength: 2 },
        ],
      },
    } as SkillPropagationTarget;
    const view = buildPropagationView(summary([retained]), []);
    expect(
      view.locations[0].files.map(({ rootId, relativePath, change, diff, beforeHash, afterHash }) => ({
        rootId,
        relativePath,
        change,
        diff,
        beforeHash,
        afterHash,
      })),
    ).toEqual([
      {
        rootId: "p",
        relativePath: "SKILL.md",
        change: "change",
        diff: undefined,
        beforeHash: "before",
        afterHash: "after",
      },
      {
        rootId: "p",
        relativePath: "extra.md",
        change: "add",
        diff: undefined,
        beforeHash: undefined,
        afterHash: "extra",
      },
    ]);
  });

  it("selects already-current targets with a base advance step, but keeps current no-ops out", () => {
    const baseAdvance = loc("p", "codex");
    const current = loc("p", "claude-code");
    const view = buildPropagationView(summary([target(baseAdvance, "already-current"), target(current, "current")]), [
      evidenceStep(baseAdvance),
    ]);
    expect(
      view.locations.map(({ group, selectable, selected, outcome }) => [group, selectable, selected, outcome]),
    ).toEqual([
      ["safe", true, true, "no-op"],
      ["safe", false, false, "no-op"],
    ]);
  });

  it("keeps declined base advances unselected and blocks retry during recovery", () => {
    const copy = loc("p", "codex");
    const input = summary([target(copy, "already-current")], "update-and-maintain");
    expect(buildPropagationView(input, [evidenceStep(copy)], [], { targets: [] } as never).locations[0].outcome).toBe(
      "unselected",
    );
    const result = {
      status: "recovery-required",
      recoveryAvailable: true,
      propagation: summary([target(copy, "eligible", "failed")]),
    } as unknown as SkillResult;
    expect(canRetryPropagationTarget(target(copy, "eligible"), result)).toBe(false);
  });

  it("offers propagation recovery only when an applied target can be restored", () => {
    const result = {
      status: "recovery-required",
      propagation: summary([target(loc("p", "codex"), "eligible", "unknown")]),
      receipts: [{ kind: "propagate-skill", status: "applied", restored: false }],
    } as unknown as SkillResult;
    expect(canReviewRestore(result)).toBe(true);
    expect(canReviewRestore({ ...result, receipts: [] })).toBe(false);
    expect(
      canReviewRestore({
        ...result,
        source: { status: "updated" },
        receipts: [
          { kind: "write-skill", status: "applied", restored: false } as unknown as NonNullable<
            SkillResult["receipts"]
          >[number],
        ],
      }),
    ).toBe(true);
  });

  it("keeps unselected targets neutral and retries only matching failed or newly unavailable results", () => {
    const selectedOut = loc("p1", "codex");
    const failed = loc("p2", "codex");
    const unknown = loc("p3", "codex");
    const pendingUnavailable = loc("p4", "codex");
    const targets = [
      target(selectedOut, "eligible"),
      target(failed, "eligible"),
      target(unknown, "eligible"),
      target(pendingUnavailable, "eligible"),
    ];
    const returned = [
      target(selectedOut, "eligible", "pending"),
      target(failed, "eligible", "failed"),
      target(unknown, "eligible", "unknown"),
      target(pendingUnavailable, "unavailable", "unavailable"),
    ];
    const result = { propagation: summary(returned) } as never;
    const view = buildPropagationView(
      summary(targets),
      targets.map(({ location }) => evidenceStep(location)),
      [],
      result,
    );
    expect(view.locations.map(({ outcome, tone, retryable }) => [outcome, tone, retryable])).toEqual([
      ["unselected", "neutral", false],
      ["failed", "conflict", true],
      ["unknown", "unknown", false],
      ["unavailable", "unknown", true],
    ]);
    expect(canRetryPropagationTarget(target(failed, "eligible"), result)).toBe(true);
    expect(canRetryPropagationTarget(target(unknown, "eligible"), result)).toBe(false);
  });
});
