import { randomUUID } from "node:crypto";
import type { LegacyBindingBridgeDiagnostic } from "../../shared/legacy-binding-bridge-diagnostic";
import { LegacyBridgeDiagnostics, bridgeErrorMessage } from "./legacy-binding-diagnostics";
import type { Binding } from "../../domain/assignment-plan";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import {
  planLegacyBindingBridge,
  legacyBindingLocation,
  skillLocationIdentity,
} from "../../domain/skill-reconciliation/legacy-binding-bridge";
import type { SkillRelationshipsState } from "../../domain/skill-reconciliation/types";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { readLegacyBindingCopies, verifyLegacyBindingCopies, type LegacyCopyCapture } from "./legacy-binding-reader";

export type LegacyBindingBridgeDependencies = Readonly<{
  registry: RegistryIpcServices;
  bindings: BindingsStore;
  relationships: SkillRelationshipStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  journal?: SkillOperationJournal;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
  log?: (diagnostic: LegacyBindingBridgeDiagnostic) => void;
}>;

export async function persistLegacyBridgeReceipt(store: OperationStore, receipt: OperationReceipt): Promise<void> {
  const result = await store.append(receipt);
  if (result.status !== "ready" || !result.receipts.some((saved) => JSON.stringify(saved) === JSON.stringify(receipt)))
    throw new Error(
      `Legacy Binding bridge receipt ${receipt.operationId} could not be saved; inspect operation history before retrying.`,
    );
}

async function reconcilePreparedReceipts(
  args: LegacyBindingBridgeDependencies,
  state: SkillRelationshipsState,
  receipts: readonly OperationReceipt[],
  diagnostics: LegacyBridgeDiagnostics,
): Promise<Set<string>> {
  const reserved = new Set<string>();
  for (const receipt of receipts.filter(
    ({ legacyBridge, restored }) => legacyBridge?.phase === "prepared" && !restored,
  )) {
    const effect = receipt.legacyBridge!;
    try {
      const applied = effect.uses.every((use) =>
        state.uses.some((current) => JSON.stringify(current) === JSON.stringify(use)),
      );
      const absent = effect.uses.every((use) => !state.uses.some(({ bindingId }) => bindingId === use.bindingId));
      if (!applied && !absent)
        throw new Error(
          `Legacy Binding bridge ${receipt.operationId} requires metadata recovery; restore its receipt before continuing.`,
        );
      await persistLegacyBridgeReceipt(args.operationStore, {
        ...receipt,
        status: applied ? "applied" : "failed",
        legacyBridge: { ...effect, phase: applied ? "applied" : "abandoned" },
        diagnostic: applied ? undefined : "No managed uses were created; retry with fresh copy evidence.",
      });
    } catch (error: unknown) {
      diagnostics.issue("receipt-recovery-unavailable", bridgeErrorMessage(error));
      for (const use of effect.uses) reserved.add(skillLocationIdentity(use.location));
    }
  }
  return reserved;
}

async function readBridgeStore<T extends { status: string }>(
  read: () => Promise<T>,
  code: string,
  diagnostics: LegacyBridgeDiagnostics,
): Promise<T | undefined> {
  try {
    const result = await read();
    if (result.status !== "ready")
      diagnostics.issue(
        code,
        `The ${code.replace("-unavailable", "")} store is unreadable; inspect it before retrying the bridge.`,
      );
    return result;
  } catch (error: unknown) {
    diagnostics.issue(code, bridgeErrorMessage(error));
    return undefined;
  }
}

async function runBridge(
  args: LegacyBindingBridgeDependencies,
  diagnostics: LegacyBridgeDiagnostics,
  bindingIds?: readonly string[],
): Promise<void> {
  const [bindingRead, relationshipRead, history] = await Promise.all([
    readBridgeStore(() => args.bindings.read(), "bindings-unavailable", diagnostics),
    readBridgeStore(() => args.relationships.read(), "relationships-unavailable", diagnostics),
    readBridgeStore(() => args.operationStore.read(), "history-unavailable", diagnostics),
  ]);
  if (bindingRead?.status !== "ready" || relationshipRead?.status !== "ready" || history?.status !== "ready") {
    if (bindingRead?.status === "ready")
      for (const binding of bindingRead.bindings.filter(({ kind }) => kind === "skill"))
        diagnostics.skip(
          [binding],
          "store-unavailable",
          "The bridge cannot save audited metadata while a required store is unreadable.",
        );
    return;
  }
  const pending = await reconcilePreparedReceipts(args, relationshipRead.state, history.receipts, diagnostics);
  if (!bindingRead.bindings.some(({ kind }) => kind === "skill")) return;
  const journal = args.journal
    ? await readBridgeStore(() => args.journal!.list(), "journal-unavailable", diagnostics)
    : undefined;
  if (args.journal && journal?.status !== "ready") {
    for (const binding of bindingRead.bindings.filter(({ kind }) => kind === "skill"))
      diagnostics.skip(
        [binding],
        "journal-unavailable",
        "Pending skill-operation scopes could not be inspected safely.",
      );
    return;
  }
  const reserved =
    journal?.status === "ready"
      ? journal.records
          .filter(({ status }) => !["previewed", "terminal"].includes(status))
          .flatMap(({ effect }) => effect?.scope.targets ?? [])
      : [];
  const candidates = bindingRead.bindings.filter((binding) => {
    if (bindingIds && !bindingIds.includes(binding.bindingId)) return false;
    const location = legacyBindingLocation(binding);
    if (!location) return false;
    if (
      pending.has(skillLocationIdentity(location)) ||
      reserved.some((target) => target.projectId === binding.projectId && target.harnessId === binding.harnessId)
    ) {
      diagnostics.skip(
        [binding],
        "pending-recovery",
        "This location is reserved by an unfinished skill operation; complete its recovery first.",
      );
      return false;
    }
    return true;
  });
  const captures = await readLegacyBindingCopies({
    ...args,
    bindings: candidates,
    relationships: relationshipRead.state,
    receipts: history.receipts,
    diagnostics,
  });
  const ready = await prepareLegacyCopies(args, captures, diagnostics);
  const accepted = selectLegacyGroups(relationshipRead.state, ready, diagnostics);
  if (!accepted.length) return;
  await saveLegacyUses(args, bindingRead.bindings, relationshipRead.state, accepted, diagnostics);
}

async function prepareLegacyCopies(
  args: LegacyBindingBridgeDependencies,
  captures: readonly LegacyCopyCapture[],
  diagnostics: LegacyBridgeDiagnostics,
): Promise<readonly LegacyCopyCapture[]> {
  const ready: LegacyCopyCapture[] = [];
  for (const capture of captures) {
    try {
      await verifyLegacyBindingCopies([capture], args.filesystem, args.now, args.registry);
      if (!capture.copy.baseUnavailable && capture.tree)
        await args.bases.publish(capture.copy.baseRevisionId, capture.tree.revision, capture.tree.files);
      await verifyLegacyBindingCopies([capture], args.filesystem, args.now, args.registry);
      ready.push(capture);
    } catch (error: unknown) {
      diagnostics.skip([capture.copy.binding], "copy-evidence-unavailable", bridgeErrorMessage(error));
    }
  }
  return ready;
}

function selectLegacyGroups(
  state: SkillRelationshipsState,
  ready: readonly LegacyCopyCapture[],
  diagnostics: LegacyBridgeDiagnostics,
): readonly LegacyCopyCapture[] {
  const accepted: LegacyCopyCapture[] = [];
  const groups = new Map<string, LegacyCopyCapture[]>();
  for (const capture of ready) {
    const key = JSON.stringify([capture.copy.location.projectId, capture.copy.source]);
    groups.set(key, [...(groups.get(key) ?? []), capture]);
  }
  for (const group of groups.values()) {
    try {
      planLegacyBindingBridge(
        state,
        [...accepted, ...group].map(({ copy }) => copy),
        randomUUID,
      );
      accepted.push(...group);
    } catch (error: unknown) {
      for (const { copy } of group)
        diagnostics.skip([copy.binding], "relationship-conflict", bridgeErrorMessage(error));
    }
  }
  return accepted;
}

async function saveLegacyUses(
  args: LegacyBindingBridgeDependencies,
  bindings: readonly Binding[],
  state: SkillRelationshipsState,
  accepted: readonly LegacyCopyCapture[],
  diagnostics: LegacyBridgeDiagnostics,
): Promise<void> {
  const effect = planLegacyBindingBridge(
    state,
    accepted.map(({ copy }) => copy),
    randomUUID,
  );
  try {
    await verifyBridgeState(args, bindings, accepted);
    const receipt: OperationReceipt = {
      operationId: randomUUID(),
      kind: "bridge-skill-uses",
      status: "failed",
      appliedAt: new Date((args.now ?? Date.now)()).toISOString(),
      displayTarget: `Omni now tracks ${effect.uses.length} ${effect.uses.length === 1 ? "copy" : "copies"}`,
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      legacyBridge: { phase: "prepared", ...effect },
      diagnostic: "Metadata tracking is prepared; inspect this receipt if the operation is interrupted.",
    };
    await persistLegacyBridgeReceipt(args.operationStore, receipt);
    await verifyBridgeState(args, bindings, accepted);
    const saved = await args.relationships.updateUsesExact(
      state.revision,
      effect.uses.map((after) => ({ skillId: after.skillId, location: after.location, after })),
      effect.records,
    );
    if (saved.status !== "saved")
      throw new Error(
        `Legacy Binding bridge ${receipt.operationId} could not save exact metadata; inspect its receipt and retry.`,
      );
    diagnostics.linkedCopies = effect.uses.length;
    await persistLegacyBridgeReceipt(args.operationStore, {
      ...receipt,
      status: "applied",
      legacyBridge: { ...receipt.legacyBridge!, phase: "applied" },
      diagnostic: undefined,
    });
  } catch (error: unknown) {
    diagnostics.issue("metadata-save-unavailable", bridgeErrorMessage(error));
    if (!diagnostics.linkedCopies)
      for (const { copy } of accepted)
        diagnostics.skip([copy.binding], "metadata-save-unavailable", bridgeErrorMessage(error));
  }
}

async function verifyBridgeState(
  args: LegacyBindingBridgeDependencies,
  bindings: readonly Binding[],
  captures: readonly LegacyCopyCapture[],
): Promise<void> {
  await verifyLegacyBindingCopies(captures, args.filesystem, args.now, args.registry);
  const current = await args.bindings.read();
  if (current.status !== "ready" || JSON.stringify(current.bindings) !== JSON.stringify(bindings))
    throw new Error("Legacy Bindings changed during bridge preparation; retry with fresh assignments.");
}

export function createLegacyBindingBridge(args: LegacyBindingBridgeDependencies): Readonly<{
  run(bindingIds?: readonly string[]): Promise<void>;
  readDiagnostic(): LegacyBindingBridgeDiagnostic | undefined;
}> {
  let queue = Promise.resolve();
  let diagnostic: LegacyBindingBridgeDiagnostic | undefined;
  return {
    readDiagnostic: () => diagnostic && structuredClone(diagnostic),
    run(bindingIds?: readonly string[]): Promise<void> {
      const result = queue.then(async () => {
        const collector = new LegacyBridgeDiagnostics();
        try {
          await runBridge(args, collector, bindingIds);
        } catch (error: unknown) {
          collector.issue("bridge-unavailable", bridgeErrorMessage(error));
        }
        diagnostic = collector.snapshot(args.now ?? Date.now);
        if (diagnostic.skippedLocations.length || diagnostic.issues.length) {
          // Diagnostics are informational; even a logging failure must not disable skills.
          try {
            (args.log ?? ((value) => console.info("Legacy Binding bridge diagnostic", JSON.stringify(value, null, 2))))(
              structuredClone(diagnostic),
            );
          } catch {
            /* The in-memory diagnostic remains readable. */
          }
        }
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
