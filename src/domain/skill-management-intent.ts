import { createHash } from "node:crypto";

import {
  parseSkillIntent,
  type SkillBindingEffect,
  type SkillFileSummary,
  type SkillIntent,
  type SkillScope,
} from "../shared/skill-management-ipc";
import { writeSkillFileBytes } from "../shared/operations-write-skill-ipc";
import type { SkillPropagationSummary } from "../shared/skill-propagation-ipc";
import type { SkillUseEffect } from "./skill-reconciliation/types";
import type { SkillAdoptionBaseReference, SkillAdoptionEvidence } from "../shared/skill-adoption-effects";
import type { SkillResolutionEvidence } from "../shared/skill-resolution-effects";
import type { SkillVariantCaptureEvidence } from "../shared/skill-variant-effects";
import type { SkillUnboundResolutionEvidence } from "../shared/skill-unbound-resolution-effects";
import type { SkillUnboundResolutionEnvelope } from "../shared/skill-unbound-resolution-effects";
import type { SkillUnboundResolutionRestoreOrigin } from "../shared/skill-unbound-resolution-effects";
import type { SkillDetachmentEvidence, SkillDetachmentRestoreOrigin } from "../shared/skill-detachment-effects";
import type { SkillPropagationStepEvidence } from "../shared/skill-propagation-effects";

export type SkillEffectFingerprint = Readonly<{
  scope: SkillScope;
  files: readonly SkillFileSummary[];
  bindings: readonly SkillBindingEffect[];
  actions?: readonly Readonly<{
    rootId: string;
    kind: string;
    relativePath: string;
    beforeHash?: string;
    afterHash?: string;
  }>[];
  metadataEffects?: readonly SkillUseEffect[];
  baseReferences?: readonly SkillAdoptionBaseReference[];
  adoptionEvidence?: SkillAdoptionEvidence;
  resolutionEvidence?: SkillResolutionEvidence;
  variantCaptureEvidence?: SkillVariantCaptureEvidence;
  unboundResolutionEvidence?: SkillUnboundResolutionEvidence;
  unboundResolutionEnvelope?: SkillUnboundResolutionEnvelope;
  unboundResolutionRestoreOrigin?: SkillUnboundResolutionRestoreOrigin;
  detachmentEvidence?: SkillDetachmentEvidence;
  detachmentRestoreOrigin?: SkillDetachmentRestoreOrigin;
  propagation?: SkillPropagationSummary;
  propagationEvidence?: SkillPropagationStepEvidence;
  projectSkillEvidence?: import("../shared/project-skill-effects").ProjectSkillEvidence;
  externalSkillEvidence?: readonly import("../shared/external-skill-effects").ExternalSkillEvidence[];
}>;

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecord);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortRecord(nested)]),
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(sortRecord(value));
}

function intentProjection(intent: SkillIntent): unknown {
  if (intent.kind !== "write" && intent.kind !== "update-and-maintain") return intent;
  const request = intent.request;
  const projectedRequest = {
    ...request,
    files: request.files
      .map((file) => ({
        path: file.path,
        contentHash: createHash("sha256").update(writeSkillFileBytes(file)).digest("hex"),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return intent.kind === "write"
    ? { kind: intent.kind, request: projectedRequest }
    : { ...intent, request: projectedRequest };
}

export function normalizeSkillIntent(value: unknown): SkillIntent {
  const intent = parseSkillIntent(value);
  if (intent.kind === "write")
    return {
      ...intent,
      request: {
        ...intent.request,
        files: [...intent.request.files].sort((left, right) => left.path.localeCompare(right.path)),
      },
    };
  if (intent.kind === "update-and-maintain")
    return {
      ...intent,
      request: {
        ...intent.request,
        files: [...intent.request.files].sort((left, right) => left.path.localeCompare(right.path)),
      },
      ...(intent.locations
        ? {
            locations: [...intent.locations].sort((left, right) =>
              `${left.projectId}\n${left.harnessId}\n${left.folderPath}`.localeCompare(
                `${right.projectId}\n${right.harnessId}\n${right.folderPath}`,
              ),
            ),
          }
        : {}),
    };
  if (intent.kind === "maintain-current")
    return {
      ...intent,
      ...(intent.locations
        ? {
            locations: [...intent.locations].sort((left, right) =>
              `${left.projectId}\n${left.harnessId}\n${left.folderPath}`.localeCompare(
                `${right.projectId}\n${right.harnessId}\n${right.folderPath}`,
              ),
            ),
          }
        : {}),
    };
  if (intent.kind === "assign")
    return {
      ...intent,
      targets: [...intent.targets]
        .map((target) => ({ ...target, harnessIds: [...target.harnessIds].sort() }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId)),
    };
  if (intent.kind === "remove") return { ...intent, bindingIds: [...intent.bindingIds].sort() };
  if (intent.kind === "reconcile" && intent.request.choice === "adopt-exact")
    return {
      ...intent,
      request: {
        ...intent.request,
        locations: [...intent.request.locations].sort((left, right) =>
          `${left.projectId}\n${left.harnessId}\n${left.folderPath}`.localeCompare(
            `${right.projectId}\n${right.harnessId}\n${right.folderPath}`,
          ),
        ),
      },
    };
  if (intent.kind === "reconcile" && intent.request.choice === "detach-managed") return intent;
  if (intent.kind === "reconcile") return intent;
  return intent;
}

export function fingerprintSkillEffects(intentValue: unknown, effects: SkillEffectFingerprint): string {
  const intent = normalizeSkillIntent(intentValue);
  const scope = {
    ...effects.scope,
    targets: [...effects.scope.targets].sort((left, right) =>
      `${left.projectId}\n${left.harnessId}\n${left.bindingId ?? ""}`.localeCompare(
        `${right.projectId}\n${right.harnessId}\n${right.bindingId ?? ""}`,
      ),
    ),
  };
  const files = [...effects.files]
    .map(({ rootId, relativePath, change, beforeHash, afterHash }) => ({
      rootId,
      relativePath,
      change,
      beforeHash,
      afterHash,
    }))
    .sort((left, right) =>
      `${left.rootId}\n${left.relativePath}`.localeCompare(`${right.rootId}\n${right.relativePath}`),
    );
  const bindings = [...effects.bindings]
    .map((effect) => ({
      bindingId: effect.bindingId,
      ...(effect.before ? { before: effect.before } : {}),
      ...(effect.after ? { after: effect.after } : {}),
    }))
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  const actions = [...(effects.actions ?? [])]
    .map((action) => ({ ...action }))
    .sort((left, right) =>
      `${left.rootId}\n${left.relativePath}\n${left.kind}`.localeCompare(
        `${right.rootId}\n${right.relativePath}\n${right.kind}`,
      ),
    );
  const metadataEffects = [...(effects.metadataEffects ?? [])].sort((left, right) =>
    `${left.location.projectId}\n${left.location.harnessId}\n${left.location.folderPath}\n${left.skillId}`.localeCompare(
      `${right.location.projectId}\n${right.location.harnessId}\n${right.location.folderPath}\n${right.skillId}`,
    ),
  );
  const baseReferences = [...(effects.baseReferences ?? [])].sort((left, right) =>
    left.baseRevisionId.localeCompare(right.baseRevisionId),
  );
  const adoptionEvidence =
    effects.adoptionEvidence === undefined
      ? undefined
      : {
          ...effects.adoptionEvidence,
          locals: [...effects.adoptionEvidence.locals].sort((left, right) =>
            `${left.location.projectId}\n${left.location.harnessId}\n${left.location.folderPath}`.localeCompare(
              `${right.location.projectId}\n${right.location.harnessId}\n${right.location.folderPath}`,
            ),
          ),
        };
  const resolutionEvidence =
    effects.resolutionEvidence === undefined
      ? undefined
      : {
          ...effects.resolutionEvidence,
          local: effects.resolutionEvidence.local,
          ...(effects.resolutionEvidence.sourceTree ? { sourceTree: effects.resolutionEvidence.sourceTree } : {}),
        };
  const canonicalEffects = {
    intent: intentProjection(intent),
    scope,
    files,
    bindings,
    actions,
    ...(effects.metadataEffects === undefined ? {} : { metadataEffects }),
    ...(effects.baseReferences === undefined ? {} : { baseReferences }),
    ...(adoptionEvidence === undefined ? {} : { adoptionEvidence }),
    ...(resolutionEvidence === undefined ? {} : { resolutionEvidence }),
    ...(effects.variantCaptureEvidence === undefined ? {} : { variantCaptureEvidence: effects.variantCaptureEvidence }),
    ...(effects.unboundResolutionEvidence === undefined
      ? {}
      : { unboundResolutionEvidence: effects.unboundResolutionEvidence }),
    ...(effects.unboundResolutionEnvelope === undefined
      ? {}
      : { unboundResolutionEnvelope: effects.unboundResolutionEnvelope }),
    ...(effects.unboundResolutionRestoreOrigin === undefined
      ? {}
      : { unboundResolutionRestoreOrigin: effects.unboundResolutionRestoreOrigin }),
    ...(effects.detachmentEvidence === undefined ? {} : { detachmentEvidence: effects.detachmentEvidence }),
    ...(effects.detachmentRestoreOrigin === undefined
      ? {}
      : { detachmentRestoreOrigin: effects.detachmentRestoreOrigin }),
    ...(effects.propagation === undefined ? {} : { propagation: effects.propagation }),
    ...(effects.projectSkillEvidence === undefined ? {} : { projectSkillEvidence: effects.projectSkillEvidence }),
    ...(effects.externalSkillEvidence === undefined ? {} : { externalSkillEvidence: effects.externalSkillEvidence }),
  };
  return createHash("sha256").update(canonical(canonicalEffects), "utf8").digest("hex");
}
