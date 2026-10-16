import { validateMainSkillAuthorization } from "./service-authorization";
import type { SkillManagementEffects, SkillManagementService } from "../../application/skill-management";
import { isExternalSkillIntent } from "../../shared/external-skill-intents";
import type { ExternalSkillOperations } from "../external-library/operations";
import { actionFingerprint, createSkillManagementReceipt, operationResult, stepFor } from "./service-operation-helpers";
import { createSkillManagementService } from "../../application/skill-management";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { ApplyRestoreBridge } from "../apply-ipc";
import type { createWriteSkillOperations } from "../operations-write-skill";
import type { createRestoreOperations } from "../operations-restore";
import type { OperationStore } from "../operation-store";
import type { createSkillAssignmentAdapter } from "./assignment";
import type { createSkillRemovalAdapter } from "./removal";

import type { createSkillRecoveryAdapter } from "./recovery";
import type { createSkillAdoptionAdapter } from "./adoption";
import type { createSkillAdoptionRecoveryAdapter } from "./adoption-recovery";
import type { createSkillResolutionAdapter } from "./resolution";
import type { createSkillResolutionRecoveryAdapter } from "./resolution-recovery";
import { createSkillAggregateRestore } from "./aggregate-restore";
import { assignmentRestoreStep } from "./assignment-restore-step";
import { resolveAdoptionReceiptRecord } from "./adoption-receipt";
import { resolveSkillResolutionReceiptRecord } from "./resolution-receipt";
import {
  blockedRestore,
  previewUnboundLinkReceiptRecovery,
  previewUnboundLinkRecovery,
} from "./unbound-service-routes";
import { resolveSkillVariantCaptureReceiptRecord } from "./variant-recovery";
import { applySkillReconciliation } from "./reconciliation-apply";
import { dispatchReconciliationRequest } from "./reconciliation-dispatch";
import type { createSkillVariantCaptureAdapter } from "./variant-capture";
import type { createSkillVariantRecoveryAdapter } from "./variant-recovery";
import type { createSkillDetachmentAdapter } from "./detachment";
import type { createSkillDetachmentRecoveryAdapter } from "./detachment-recovery";
import type { createSkillPropagationAdapter } from "./propagation-composition";
import { previewInterruptedLegacyBridgeRestore } from "./legacy-binding-service";
import { composeProjectSkillService, previewProjectSkillOperation } from "./project-skill-service";
import type { createLegacyBindingBridge } from "./legacy-binding-bridge";
import type { createLegacyBindingRecovery } from "./legacy-binding-recovery";
import { blockedDetachmentForMcp, previewInterruptedDetachmentInverse } from "./detachment-access";

type WriteSkillOperations = ReturnType<typeof createWriteSkillOperations>;
type RestoreOperations = ReturnType<typeof createRestoreOperations>;

export function createMainSkillManagementService(
  args: Readonly<{
    writeSkill: WriteSkillOperations;
    restore: RestoreOperations;
    operationStore: OperationStore;
    journal: SkillOperationJournal;
    externalSkills?: ExternalSkillOperations;
    assignment?: ReturnType<typeof createSkillAssignmentAdapter>;
    removal?: ReturnType<typeof createSkillRemovalAdapter>;
    applyRestore?: ApplyRestoreBridge;
    recovery?: ReturnType<typeof createSkillRecoveryAdapter>;
    adoption?: ReturnType<typeof createSkillAdoptionAdapter>;
    adoptionRecovery?: ReturnType<typeof createSkillAdoptionRecoveryAdapter>;
    resolution?: ReturnType<typeof createSkillResolutionAdapter>;
    resolutionRecovery?: ReturnType<typeof createSkillResolutionRecoveryAdapter>;
    variantCapture?: ReturnType<typeof createSkillVariantCaptureAdapter>;
    variantRecovery?: ReturnType<typeof createSkillVariantRecoveryAdapter>;
    unboundResolution?: ReturnType<typeof import("./unbound-resolution").createSkillUnboundResolutionAdapter>;
    detachment?: ReturnType<typeof createSkillDetachmentAdapter>;
    detachmentRecovery?: ReturnType<typeof createSkillDetachmentRecoveryAdapter>;
    propagation?: ReturnType<typeof createSkillPropagationAdapter>;
    projectSkills?: ReturnType<typeof import("./project-skills").createProjectSkillsAdapter>;
    legacyBridge?: ReturnType<typeof createLegacyBindingBridge>;
    legacyBridgeRecovery?: ReturnType<typeof createLegacyBindingRecovery>;
    now?: () => number;
    onProgress?: (intentId: string) => void;
  }>,
): SkillManagementService {
  const aggregateRestore = createSkillAggregateRestore(args.operationStore, () => effects, args.journal);
  const effects: SkillManagementEffects = {
    async preview(intent, actor, intentId, createdAt) {
      if (isExternalSkillIntent(intent))
        return args.externalSkills
          ? args.externalSkills.preview(intent, intentId)
          : blockedRestore(
              "External skill operations are unavailable.",
              "external-skills-unavailable",
              "Check the external library.",
            );
      if (intent.kind === "project-skill") return previewProjectSkillOperation(intent, intentId, args);
      if (intent.kind === "assign") {
        if (!args.assignment)
          return {
            status: "needs-input",
            reason: "Assignment is unavailable in this session.",
            details: [
              {
                code: "assignment-adapter-unavailable",
                message: "Reopen the source and project in Changes, then refresh the assignment preview.",
                recoveryAction: "reconnect",
              },
            ],
          };
        return args.assignment.preview(intent, intentId);
      }
      if (intent.kind === "remove") {
        if (!args.removal)
          return {
            status: "blocked",
            reason: "Removal is unavailable in this session.",
            details: [
              {
                code: "removal-adapter-unavailable",
                message: "Reopen the project in Changes, then refresh the removal preview.",
                recoveryAction: "reconnect",
              },
            ],
          };
        return args.removal.preview(intent, intentId);
      }
      if (intent.kind === "restore") {
        const externalRestore = await args.externalSkills?.previewRestore(intent.operationId, intentId);
        if (externalRestore) return externalRestore;
        const projectRestore = await args.projectSkills?.previewRestore(intent.operationId, intentId);
        if (projectRestore) return projectRestore;
        const interrupted = await args.journal.read(intent.operationId);
        const legacyRecovery = await previewInterruptedLegacyBridgeRestore(
          interrupted,
          args.operationStore,
          args.legacyBridgeRecovery,
          intentId,
        );
        if (legacyRecovery) return legacyRecovery;
        if (interrupted.status === "ready" && interrupted.record.intent.kind === "reconcile") {
          const request = interrupted.record.intent.request;
          if (request.choice === "detach-managed")
            return (
              blockedDetachmentForMcp(actor) ??
              (args.detachmentRecovery
                ? args.detachmentRecovery.previewOriginal(interrupted.record, intentId)
                : blockedRestore(
                    "Stop-management recovery is unavailable.",
                    "detachment-recovery-unavailable",
                    "Reconnect the selected project and inspect the original stop-management receipt.",
                  ))
            );
          if (request.choice === "link-canonical") {
            return previewUnboundLinkRecovery({
              record: interrupted.record,
              intentId,
              actor,
              adoptionRecovery: args.adoptionRecovery,
              unboundResolution: args.unboundResolution,
            });
          }
          if (request.choice === "keep-variant") {
            if (!args.variantRecovery)
              return blockedRestore(
                "Variant recovery is unavailable.",
                "variant-recovery-unavailable",
                "Reconnect the selected personal source and inspect its saved capture evidence.",
              );
            return args.variantRecovery.preview(interrupted.record, intentId);
          }
          if (request.choice === "adopt-exact" && !args.adoptionRecovery)
            return {
              status: "blocked",
              reason: "Adoption recovery is unavailable.",
              details: [
                {
                  code: "adoption-recovery-unavailable",
                  message: "Reconnect the original source and project before restoring adoption metadata.",
                  recoveryAction: "reconnect",
                },
              ],
            };
          if (request.choice === "adopt-exact") return args.adoptionRecovery!.preview(interrupted.record, intentId);
          if (!args.resolutionRecovery)
            return {
              status: "blocked",
              reason: "Managed resolution recovery is unavailable.",
              details: [
                {
                  code: "resolution-recovery-unavailable",
                  message: "Reconnect the selected project and inspect the saved local backup.",
                  recoveryAction: "reconnect",
                },
              ],
            };
          return args.resolutionRecovery.preview(interrupted.record, intentId);
        }
        if (
          interrupted.status === "ready" &&
          interrupted.record.status === "recovery-required" &&
          !interrupted.record.effect?.propagation
        ) {
          const interruptedInverse = previewInterruptedDetachmentInverse(
            actor,
            interrupted.record,
            intentId,
            args.detachmentRecovery,
          );
          if (interruptedInverse) return interruptedInverse;
          if (interrupted.record.intent.kind === "reconcile") {
            const request = interrupted.record.intent.request;
            if (request.choice === "detach-managed")
              return (
                blockedDetachmentForMcp(actor) ??
                (args.detachmentRecovery
                  ? args.detachmentRecovery.previewOriginal(interrupted.record, intentId)
                  : blockedRestore(
                      "Stop-management recovery is unavailable.",
                      "detachment-recovery-unavailable",
                      "Reconnect the selected project and inspect the original stop-management receipt.",
                    ))
              );
            if (request.choice === "link-canonical") {
              return previewUnboundLinkRecovery({
                record: interrupted.record,
                intentId,
                actor,
                adoptionRecovery: args.adoptionRecovery,
                unboundResolution: args.unboundResolution,
              });
            }
            if (request.choice === "keep-variant") {
              if (!args.variantRecovery)
                return blockedRestore(
                  "Variant recovery is unavailable.",
                  "variant-recovery-unavailable",
                  "Reconnect the selected personal source and inspect its saved capture evidence.",
                );
              return args.variantRecovery.preview(interrupted.record, intentId);
            }
            if (request.choice === "adopt-exact") {
              if (!args.adoptionRecovery)
                return {
                  status: "blocked",
                  reason: "Adoption recovery is unavailable.",
                  details: [
                    {
                      code: "adoption-recovery-unavailable",
                      message: "Reconnect the source and project before inspecting adoption recovery.",
                      recoveryAction: "reconnect",
                    },
                  ],
                };
              return args.adoptionRecovery.preview(interrupted.record, intentId);
            }
            if (!args.resolutionRecovery)
              return {
                status: "blocked",
                reason: "Managed resolution recovery is unavailable.",
                details: [
                  {
                    code: "resolution-recovery-unavailable",
                    message: "Reconnect the selected project and inspect the saved local backup.",
                    recoveryAction: "reconnect",
                  },
                ],
              };
            return args.resolutionRecovery.preview(interrupted.record, intentId);
          }
          if (!args.recovery)
            return {
              status: "blocked",
              reason: "Recovery is unavailable in this session.",
              details: [
                {
                  code: "recovery-unavailable",
                  message: "Reconnect the owned source and projects to inspect recovery.",
                  recoveryAction: "reconnect",
                },
              ],
            };
          return args.recovery.preview(interrupted.record, intentId);
        }
        const loaded = await args.operationStore.read();
        if (loaded.status !== "ready")
          return {
            status: "blocked",
            reason: "The operation receipt store is unavailable.",
            details: [
              {
                code: "receipt-unavailable",
                message: "Restore cannot be previewed while operation history is unavailable.",
                recoveryAction: "inspect-recovery",
              },
            ],
          };
        const parent = loaded.receipts.find(
          (receipt) =>
            receipt.operationId === intent.operationId &&
            (receipt.kind === "skill-management" ||
              (receipt.kind === "import-artifact" && Boolean(receipt.children?.length))),
        );
        if (parent) return aggregateRestore.preview(parent, actor, intentId, createdAt);
        const bridgeReceipt = loaded.receipts.find(
          (receipt) => receipt.operationId === intent.operationId && receipt.legacyBridge && !receipt.restored,
        );
        if (bridgeReceipt && args.legacyBridgeRecovery)
          return args.legacyBridgeRecovery.preview(bridgeReceipt, intentId);
        const original = loaded.receipts.find(
          (receipt) => receipt.operationId === intent.operationId && receipt.status === "applied" && !receipt.restored,
        );
        if (original?.kind === "propagate-skill" && original.skillPropagation) {
          if (!args.propagation)
            return blockedRestore(
              "Skill propagation restore is unavailable.",
              "propagation-restore-unavailable",
              "Reconnect the project and inspect its propagation receipt.",
            );
          return args.propagation.previewReceipt(original, intentId);
        }
        if (original?.kind === "adopt-skill") {
          const record = original.adoption
            ? resolveAdoptionReceiptRecord(original, await args.journal.read(original.adoption.intentId))
            : undefined;
          if (!record || !args.adoptionRecovery)
            return {
              status: "blocked",
              reason: "The adoption receipt does not have a verified journal link.",
              details: [
                {
                  code: "adoption-receipt-unavailable",
                  message: "Open the original adoption operation and inspect its recovery record.",
                  recoveryAction: "inspect-recovery",
                },
              ],
            };
          return args.adoptionRecovery.preview(record, intentId);
        }
        if (original?.kind === "resolve-skill") {
          const record = original.reconciliation
            ? resolveSkillResolutionReceiptRecord(original, await args.journal.read(original.reconciliation.intentId))
            : undefined;
          if (!record || !args.resolutionRecovery)
            return {
              status: "blocked",
              reason: "The managed resolution receipt does not have a verified journal link.",
              details: [
                {
                  code: "resolution-receipt-unavailable",
                  message: "Inspect the original managed resolution record and local backup.",
                  recoveryAction: "inspect-recovery",
                },
              ],
            };
          return args.resolutionRecovery.preview(record, intentId);
        }
        if (original?.kind === "capture-skill") {
          const record = original.capture
            ? await args.journal.read(original.capture.intentId)
            : { status: "missing" as const };
          const linked =
            record.status === "ready" ? resolveSkillVariantCaptureReceiptRecord(original, record.record) : undefined;
          if (!linked || !args.variantRecovery)
            return blockedRestore(
              "The capture receipt does not have a verified journal link.",
              "variant-receipt-unavailable",
              "Inspect the original capture receipt and saved recovery payload before restoring it.",
            );
          return args.variantRecovery.preview(linked, intentId, original);
        }
        if (original?.kind === "link-skill") {
          return previewUnboundLinkReceiptRecovery({
            receipt: original,
            intentId,
            actor,
            journal: args.journal,
            unboundResolution: args.unboundResolution,
          });
        }
        if (original?.kind === "detach-skill") {
          const localOnly = blockedDetachmentForMcp(actor);
          if (localOnly) return localOnly;
          if (!args.detachmentRecovery)
            return blockedRestore(
              "Stop-management recovery is unavailable.",
              "detachment-recovery-unavailable",
              "Inspect the original stop-management journal and public parent receipt.",
            );
          return args.detachmentRecovery.previewReceipt(original, intentId);
        }
        if (original?.kind === "apply-plan" || original?.kind === "remove-binding") {
          if (!args.applyRestore)
            return {
              status: "blocked",
              reason: "The project restore service is unavailable.",
              details: [
                {
                  code: "restore-unavailable",
                  message: "Reconnect the project before previewing this assignment restore.",
                  recoveryAction: "reconnect",
                },
              ],
            };
          const response = await args.applyRestore.previewRestore({ operationId: intent.operationId });
          if (response.status !== "ready")
            return {
              status: "blocked",
              reason: response.diagnostic ?? "The assignment restore could not be previewed.",
              details: [
                {
                  code: response.reason,
                  message: response.diagnostic ?? "Refresh the assignment restore after reconnecting the project.",
                  recoveryAction: "inspect-recovery",
                },
              ],
            };
          const step = assignmentRestoreStep(original, response.planId, response.files);
          if (!step)
            return {
              status: "blocked",
              reason: "The assignment receipt does not contain exact restore effects.",
              details: [
                {
                  code: "restore-receipt-incomplete",
                  message: "Inspect the original assignment receipt before restoring it.",
                  recoveryAction: "inspect-recovery",
                },
              ],
            };
          return {
            status: "ready",
            planId: response.planId,
            scope: step.scope,
            steps: [step],
            fingerprint: {
              scope: step.scope,
              files: step.files,
              bindings: step.bindingEffects,
              actions: actionFingerprint(step.plan, step.scope.targets[0]?.projectId ?? intent.operationId),
            },
            backupReferences: [
              { rootId: original.project!.id, path: `backups/${original.operationId}/${original.project!.id}` },
            ],
          };
        }
        const sourceId = original?.registered?.sourceId;
        if (!original || !sourceId)
          return {
            status: "blocked",
            reason: "The source skill receipt is unavailable or already restored.",
            details: [
              {
                code: "restore-unavailable",
                message: "Open the original source operation receipt and inspect its status.",
                recoveryAction: "inspect-recovery",
              },
            ],
          };
        const response = await args.restore.preview({ kind: "restore-import", operationId: intent.operationId });
        if (response.status !== "ready")
          return {
            status: "blocked",
            reason: response.diagnostic,
            details: [{ code: response.reason, message: response.diagnostic, recoveryAction: "inspect-recovery" }],
          };
        const step = stepFor(response.plan, sourceId, original.displayTarget);
        return {
          status: "ready",
          planId: response.plan.planId,
          scope: step.scope,
          steps: [step],
          fingerprint: {
            scope: step.scope,
            files: step.files,
            bindings: [],
            actions: actionFingerprint(response.plan, sourceId),
          },
          backupReferences: [{ rootId: sourceId, path: `backups/skill-intents/${intentId}/before-restore` }],
        };
      }
      if (intent.kind === "reconcile") {
        const request = intent.request;
        if (request.choice === "link-canonical" && actor.kind === "mcp")
          return blockedRestore(
            "Unbound canonical linkage is available only through the desktop Changes review.",
            "unbound-resolution-local-only",
            "open-changes",
          );
        return dispatchReconciliationRequest(request, {
          adoptExact: (adoptionRequest) =>
            args.adoption
              ? args.adoption.preview({ kind: "reconcile", request: adoptionRequest }, intentId)
              : Promise.resolve({
                  status: "blocked",
                  reason: "Skill adoption is unavailable in this session.",
                  details: [
                    {
                      code: "adoption-adapter-unavailable",
                      message: "Reopen the source and project, then refresh the exact-copy adoption preview.",
                      recoveryAction: "reconnect",
                    },
                  ],
                }),
          managedResolution: (managedRequest) =>
            args.resolution
              ? args.resolution.preview({ kind: "reconcile", request: managedRequest }, intentId)
              : Promise.resolve({
                  status: "blocked",
                  reason: "Managed resolution is unavailable in this session.",
                  details: [
                    {
                      code: "resolution-adapter-unavailable",
                      message: "Refresh the selected managed copy in Changes.",
                      recoveryAction: "reconnect",
                    },
                  ],
                }),
          variantCapture: (captureRequest) =>
            args.variantCapture
              ? args.variantCapture.preview({ kind: "reconcile", request: captureRequest }, intentId, createdAt)
              : Promise.resolve(
                  blockedRestore(
                    "Personal variant capture is unavailable.",
                    "variant-capture-unavailable",
                    "Reopen the selected project copy and personal source, then refresh the capture preview.",
                  ),
                ),
          unboundResolution: (unboundRequest) =>
            args.unboundResolution
              ? args.unboundResolution.preview({ kind: "reconcile", request: unboundRequest }, intentId, createdAt)
              : Promise.resolve(
                  blockedRestore(
                    "Unbound canonical linkage is unavailable in this session.",
                    "unbound-resolution-adapter-unavailable",
                    "Reopen the selected project copy and owned source, then refresh the linkage preview.",
                  ),
                ),
          detachment: (detachmentRequest) => {
            const localOnly = blockedDetachmentForMcp(actor);
            if (localOnly) return Promise.resolve(localOnly);
            return args.detachment
              ? args.detachment.preview({ kind: "reconcile", request: detachmentRequest }, intentId)
              : Promise.resolve(
                  blockedRestore(
                    "Stop management is unavailable in this session.",
                    "detachment-adapter-unavailable",
                    "Reopen the selected project and refresh the stop-management preview.",
                  ),
                );
          },
        });
      }
      if (intent.kind === "update-and-maintain" || intent.kind === "maintain-current")
        return args.propagation
          ? args.propagation.preview(intent, intentId)
          : blockedRestore(
              "Skill propagation is unavailable in this session.",
              "propagation-adapter-unavailable",
              "Reopen the owned source and selected projects, then refresh the Changes preview.",
            );
      if (intent.kind !== "write")
        return {
          status: "needs-input",
          reason: "This operation is not available through the source writer yet.",
          details: [
            {
              code: "operation-adapter-unavailable",
              message: "Choose a supported operation in Changes.",
              recoveryAction: "open-changes",
            },
          ],
        };
      const response = await args.writeSkill.preview({ ...intent.request, kind: "write-skill" }, createdAt);
      if (response.status !== "ready")
        return {
          status: "blocked",
          reason: response.diagnostic,
          details: [{ code: response.reason, message: response.diagnostic, recoveryAction: "refresh" }],
        };
      const plan = response.plan;
      const step = stepFor(plan, intent.request.sourceId, plan.displayTarget);
      const backup = args.writeSkill.recoveryReference(plan.planId);
      return {
        status: "ready",
        planId: plan.planId,
        scope: step.scope,
        steps: [step],
        fingerprint: {
          scope: step.scope,
          files: step.files,
          bindings: [],
          actions: actionFingerprint(plan, intent.request.sourceId),
        },
        backupReferences: backup ? [{ rootId: backup.sourceId, path: backup.path }] : [],
      };
    },
    async prepare(intentId, effect) {
      if (args.externalSkills?.has(effect.planId)) return args.externalSkills.prepare(intentId, effect);
      if (args.projectSkills?.has(effect.planId)) return args.projectSkills.prepare(intentId, effect);
      if (args.legacyBridgeRecovery?.has(effect.planId)) return args.legacyBridgeRecovery.prepare(intentId, effect);
      if (args.propagation?.has(effect.planId)) return args.propagation.prepare(intentId, effect);
      if (args.unboundResolution?.isRecoveryEffect(effect))
        return args.unboundResolution.prepareRecovery(intentId, effect);
      if (args.detachmentRecovery?.has(effect.planId)) return args.detachmentRecovery.prepare(intentId, effect);
      if (args.detachment?.has(effect.planId)) return args.detachment.prepare(intentId, effect);
      if (args.variantCapture?.has(effect.planId)) return args.variantCapture.prepare(intentId, effect);
      if (args.variantRecovery?.has(effect.planId)) return args.variantRecovery.prepare(intentId, effect);
      if (args.recovery?.has(effect.planId)) return args.recovery.prepare(intentId, effect);
      if (args.adoptionRecovery?.has(effect.planId)) return args.adoptionRecovery.prepare(intentId, effect);
      if (args.resolutionRecovery?.has(effect.planId)) return args.resolutionRecovery.prepare(intentId, effect);
      if (args.resolution?.has(effect.planId)) return args.resolution.prepare(intentId, effect);
      if (args.unboundResolution?.has(effect.planId)) return args.unboundResolution.prepare(intentId, effect);
      if (aggregateRestore.has(effect.planId)) return aggregateRestore.prepare(intentId, effect);
      if (effect.steps[0]?.plan.kind === "adopt-skill") {
        if (!args.adoption) throw new Error("The skill adoption adapter is unavailable.");
        await args.adoption.prepare(intentId, effect);
        return;
      }
      if (!effect.steps.length) return;
      if (effect.steps.some((step) => step.plan.kind === "apply-plan")) {
        if (!args.assignment) throw new Error("The assignment adapter is unavailable.");
        await args.assignment.prepare(intentId, effect);
        return;
      }
      if (effect.steps[0]?.plan.kind === "restore-apply") return;
      if (effect.steps[0]?.plan.kind === "remove-binding") {
        if (!args.removal) throw new Error("The removal adapter is unavailable.");
        await args.removal.prepare(effect.planId, effect);
        return;
      }
      if (effect.steps[0]?.plan.kind === "restore-import") await args.restore.prepare(effect.planId, intentId);
      else await args.writeSkill.prepare(effect.planId);
    },
    async validateAuthorization(record, authorization) {
      return validateMainSkillAuthorization(record, authorization, args);
    },
    async apply(_intentId, intent, actor, authorization, effect, progress) {
      if (args.externalSkills?.has(effect.planId))
        return args.externalSkills.apply(_intentId, effect, actor, authorization, progress);
      if (args.projectSkills?.has(effect.planId)) return args.projectSkills.apply(_intentId, effect, progress);
      if (intent.kind === "project-skill" && intent.action === "install-agent" && args.assignment)
        return args.assignment.apply(_intentId, effect, progress);
      if (args.legacyBridgeRecovery?.has(effect.planId))
        return args.legacyBridgeRecovery.apply(_intentId, effect, progress);
      if (args.propagation?.has(effect.planId)) return args.propagation.apply(_intentId, effect, progress);
      if (args.unboundResolution?.isRecoveryEffect(effect))
        return args.unboundResolution.applyRecovery(_intentId, effect, progress);
      if (args.detachmentRecovery?.has(effect.planId))
        return args.detachmentRecovery.apply(_intentId, effect, progress);
      if (args.detachment?.has(effect.planId)) return args.detachment.apply(_intentId, effect, progress);
      if (args.variantRecovery?.has(effect.planId)) return args.variantRecovery.apply(_intentId, effect, progress);
      if (args.variantCapture?.has(effect.planId)) return args.variantCapture.apply(_intentId, effect, progress);
      if (args.recovery?.has(effect.planId)) return args.recovery.apply(_intentId, effect, progress);
      if (args.adoptionRecovery?.has(effect.planId)) return args.adoptionRecovery.apply(_intentId, effect, progress);
      if (args.resolutionRecovery?.has(effect.planId))
        return args.resolutionRecovery.apply(_intentId, effect, progress);
      if (args.resolution?.has(effect.planId)) return args.resolution.apply(_intentId, effect, progress);
      if (args.unboundResolution?.has(effect.planId)) return args.unboundResolution.apply(_intentId, effect, progress);
      if (aggregateRestore.has(effect.planId))
        return aggregateRestore.apply(_intentId, actor, authorization, effect, progress);
      if (intent.kind === "reconcile")
        return applySkillReconciliation({
          request: intent.request,
          intentId: _intentId,
          effect,
          progress,
          adoption: args.adoption,
          resolution: args.resolution,
          variantCapture: args.variantCapture,
          unboundResolution: args.unboundResolution,
          detachment: args.detachment,
        });
      if (!effect.steps.length && intent.kind !== "remove") throw new Error("The skill preview is unavailable.");
      if (intent.kind === "assign") {
        if (!args.assignment) throw new Error("The assignment adapter is unavailable.");
        return args.assignment.apply(_intentId, effect, progress);
      }
      if (intent.kind === "remove") {
        if (!args.removal) throw new Error("The removal adapter is unavailable.");
        return args.removal.apply(_intentId, effect, progress);
      }
      if (effect.steps[0]) await progress({ stepId: effect.steps[0].stepId, status: "applying" });
      if (intent.kind === "restore") {
        if (effect.steps[0].plan.kind === "restore-apply") {
          if (!args.applyRestore) throw new Error("The project restore service is unavailable.");
          const restored = await args.applyRestore.runRestore({ planId: effect.planId });
          if (!("receipt" in restored)) throw new Error("The approved assignment restore expired; preview it again.");
          const targets = effect.steps.flatMap((step) =>
            step.bindingEffects.flatMap((bindingEffect) => {
              const binding = bindingEffect.before ?? bindingEffect.after;
              return binding
                ? [
                    {
                      projectId: binding.projectId,
                      harnessId: binding.harnessId,
                      bindingId: binding.bindingId,
                      artifactPath: binding.artifactPath,
                      status: restored.receipt.status === "applied" ? ("restored" as const) : ("failed" as const),
                    },
                  ]
                : [];
            }),
          );
          return {
            status: restored.receipt.status === "applied" ? "restored" : "failed",
            source: { status: "unchanged", ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}) },
            targets,
            receiptIds: [restored.receipt.operationId],
            receipts: [restored.receipt],
            issues:
              restored.receipt.status === "failed"
                ? [
                    {
                      code: "restore-failed",
                      message: restored.receipt.diagnostic ?? "The assignment restore could not be completed safely.",
                      recoveryAction: "inspect-recovery" as const,
                    },
                  ]
                : [],
            recoveryAvailable: restored.receipt.status === "failed",
          };
        }
        const restored = await args.restore.apply({ planId: effect.planId });
        if (!restored) throw new Error("The approved restore plan is unavailable; preview it again.");
        const partial =
          restored.receipt.status === "failed" &&
          restored.receipt.actions.some((action) => action.status === "applied");
        return {
          status: restored.receipt.status === "applied" ? "restored" : partial ? "recovery-required" : "failed",
          source: {
            status: restored.receipt.status === "applied" ? "restored" : "failed",
            sourceId: effect.scope.sourceId,
          },
          targets: [],
          receiptIds: [restored.receipt.operationId],
          receipts: [restored.receipt],
          issues:
            restored.receipt.status === "failed"
              ? [
                  {
                    code: "restore-failed",
                    message: restored.receipt.diagnostic ?? "The restore could not be completed safely.",
                    recoveryAction: "inspect-recovery" as const,
                  },
                ]
              : [],
          recoveryAvailable: partial || restored.receipt.status === "failed",
        };
      }
      if (intent.kind !== "write") throw new Error("The selected operation is not supported by the source writer.");
      if (effect.steps[0].plan.actions.length === 0 && authorization.kind === "desktop")
        return {
          status: "no-op",
          source: { status: "unchanged", sourceId: intent.request.sourceId },
          targets: [],
          receiptIds: [],
          issues: [],
          recoveryAvailable: false,
        };
      const approval = authorization.kind === "agent" ? (authorization.approval ?? "conversation") : undefined;
      const applied = await args.writeSkill.apply({
        planId: effect.planId,
        ...(approval
          ? {
              provenance: {
                approval,
                ...(actor.kind === "mcp" && actor.harness
                  ? {
                      agent: {
                        harness: actor.harness,
                        ...(actor.sessionName ? { sessionName: actor.sessionName } : {}),
                        requestedAt: new Date(authorization.approvedAt).toISOString(),
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
      if (!applied) throw new Error("The approved skill plan is unavailable; preview it again.");
      const result = operationResult(applied.receipt, intent.request.sourceId);
      return {
        status: result.status,
        source: result.source,
        targets: result.targets,
        receiptIds: result.receiptIds,
        receipts: result.receipts,
        issues: result.issues,
        recoveryAvailable: result.recoveryAvailable,
      };
    },
  };
  const service = createSkillManagementService({
    effects,
    journal: args.journal,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    recordResult: async (result, record) => {
      const stored = await args.operationStore.append(createSkillManagementReceipt(result, record));
      if (stored.status !== "ready") throw new Error("The aggregate skill receipt could not be saved safely.");
      if (record.effect?.steps.some((step) => step.projectSkillEvidence)) await args.projectSkills?.cleanupParking();
    },
    ...(args.now ? { now: args.now } : {}),
  });
  return composeProjectSkillService(service, args);
}
