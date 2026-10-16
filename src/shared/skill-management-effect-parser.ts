import { parseProjectSkillEvidence } from "./project-skill-effects";
import { parseExternalSkillEvidence } from "./external-skill-effects";
import { parseBinding } from "./bindings-ipc";
import { parsePreviewMarketplaceResponse, type PreviewMarketplaceResponse } from "./operations-ipc";
import type { SkillBindingEffect, SkillEffectStep, SkillFileSummary, SkillScope } from "./skill-management-ipc";
import { parseSkillAdoptionStepMetadata, parseSkillUseEffect } from "./skill-adoption-effects";
import { parseSkillResolutionStepMetadata } from "./skill-resolution-effects";
import { parseSkillVariantCaptureStepMetadata } from "./skill-variant-effects";
import { parseSkillUnboundResolutionStepMetadata } from "./skill-unbound-resolution-effects";
import { parseSkillDetachmentStepMetadata } from "./skill-detachment-effects";
import { parseSkillPropagationStepMetadata } from "./skill-propagation-effects";
import type { HarnessId } from "../domain/harness-targets";

type RecordValue = Record<string, unknown>;
const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function id(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}

function readableText(value: unknown, label: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value;
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${label} is invalid.`);
  const path = value.trim().replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be a safe relative path.`);
  return path;
}

function harness(value: unknown): HarnessId {
  if (!HARNESSES.includes(value as HarnessId)) throw new Error("Harness id is invalid.");
  return value as HarnessId;
}

export function parseScope(value: unknown): SkillScope {
  const scope = record(value, "Skill scope");
  keys(scope, ["sourceId", "packageId", "artifactPath", "targets"], "Skill scope");
  if (!Array.isArray(scope.targets)) throw new Error("Skill scope targets are invalid.");
  const targets = scope.targets.map((value) => {
    const target = record(value, "Skill scope target");
    keys(target, ["projectId", "harnessId", "bindingId"], "Skill scope target");
    return {
      projectId: id(target.projectId, "Project id"),
      harnessId: harness(target.harnessId),
      ...(target.bindingId === undefined ? {} : { bindingId: id(target.bindingId, "Binding id") }),
    };
  });
  const targetKeys = targets.map((target) => `${target.projectId}\n${target.harnessId}\n${target.bindingId ?? ""}`);
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("Skill scope targets are duplicated.");
  return {
    ...(scope.sourceId === undefined ? {} : { sourceId: id(scope.sourceId, "Source id") }),
    ...(scope.packageId === undefined ? {} : { packageId: relativePath(scope.packageId, "Package id") }),
    ...(scope.artifactPath === undefined ? {} : { artifactPath: relativePath(scope.artifactPath, "Artifact path") }),
    targets,
  };
}

function parseFileSummary(value: unknown): SkillFileSummary {
  const file = record(value, "Skill file summary");
  keys(
    file,
    ["rootId", "relativePath", "change", "byteLength", "diff", "summary", "beforeHash", "afterHash"],
    "Skill file summary",
  );
  if (!["add", "change", "delete", "unchanged"].includes(String(file.change)))
    throw new Error("Skill file change is invalid.");
  const hashValue = (candidate: unknown, label: string): string => {
    if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/u.test(candidate)) throw new Error(`${label} is invalid.`);
    return candidate;
  };
  if (file.byteLength !== undefined && (!Number.isInteger(file.byteLength) || Number(file.byteLength) < 0))
    throw new Error("Skill file byte length is invalid.");
  if (file.diff !== undefined && (typeof file.diff !== "string" || file.diff.length > 128 * 1024))
    throw new Error("Skill file diff is invalid.");
  return {
    rootId: id(file.rootId, "File root id"),
    relativePath: relativePath(file.relativePath, "Skill file path"),
    change: file.change as SkillFileSummary["change"],
    ...(file.byteLength === undefined ? {} : { byteLength: Number(file.byteLength) }),
    ...(file.diff === undefined ? {} : { diff: file.diff }),
    ...(file.summary === undefined ? {} : { summary: readableText(file.summary, "File summary", 2048) }),
    ...(file.beforeHash === undefined ? {} : { beforeHash: hashValue(file.beforeHash, "File before hash") }),
    ...(file.afterHash === undefined ? {} : { afterHash: hashValue(file.afterHash, "File after hash") }),
  };
}

export function parseEffectStep(value: unknown): SkillEffectStep {
  const step = record(value, "Skill effect step");
  keys(
    step,
    [
      "stepId",
      "scope",
      "plan",
      "bindingEffects",
      "files",
      "metadataEffects",
      "baseReferences",
      "adoptionEvidence",
      "resolutionEvidence",
      "variantCaptureEvidence",
      "unboundResolutionEvidence",
      "unboundResolutionEnvelope",
      "unboundResolutionRestoreOrigin",
      "detachmentEvidence",
      "detachmentRestoreOrigin",
      "propagationEvidence",
      "projectSkillEvidence",
      "externalSkillEvidence",
    ],
    "Skill effect step",
  );
  if (!Array.isArray(step.bindingEffects) || !Array.isArray(step.files))
    throw new Error("Skill effect step collections are invalid.");
  const preview = parsePreviewMarketplaceResponse({ status: "ready", plan: step.plan }) as Extract<
    PreviewMarketplaceResponse,
    { status: "ready" }
  >;
  const bindingEffects = step.bindingEffects.map((value) => {
    const effect = record(value, "Skill binding effect");
    keys(effect, ["bindingId", "before", "after"], "Skill binding effect");
    if (effect.before === undefined && effect.after === undefined) throw new Error("Skill binding effect is empty.");
    return {
      bindingId: id(effect.bindingId, "Binding id"),
      ...(effect.before === undefined ? {} : { before: parseBinding(effect.before) }),
      ...(effect.after === undefined ? {} : { after: parseBinding(effect.after) }),
    };
  });
  if (new Set(bindingEffects.map((effect) => effect.bindingId)).size !== bindingEffects.length)
    throw new Error("Skill binding effects are duplicated.");
  const scope = parseScope(step.scope);
  const files = step.files.map(parseFileSummary);
  const evidenceFields = [
    step.adoptionEvidence,
    step.resolutionEvidence,
    step.variantCaptureEvidence,
    step.unboundResolutionEvidence,
    step.detachmentEvidence,
    step.propagationEvidence,
    step.projectSkillEvidence,
    step.externalSkillEvidence,
  ];
  if (evidenceFields.filter((item) => item !== undefined).length > 1)
    throw new Error("A skill step cannot mix saved reconciliation evidence.");
  if (step.externalSkillEvidence !== undefined) {
    const evidence = parseExternalSkillEvidence(step.externalSkillEvidence);
    if (evidence.refusal && (files.length || preview.plan.actions.length))
      throw new Error("A refused external target cannot contain writes.");
    if (
      preview.plan.kind !== evidence.kind ||
      bindingEffects.length ||
      !scope.targets.length ||
      scope.targets.some((target) => target.projectId !== evidence.projectId) ||
      files.some(
        (file) =>
          file.rootId !== evidence.projectId ||
          (file.relativePath !== "skills-lock.json" &&
            !evidence.layouts.some(
              (layout) => file.relativePath === layout.path || file.relativePath.startsWith(layout.path + "/"),
            )),
      )
    )
      throw new Error("External skill effects exceed their approved project paths.");
    return {
      stepId: id(step.stepId, "Skill step id"),
      scope,
      plan: preview.plan,
      bindingEffects,
      files,
      externalSkillEvidence: evidence,
    };
  }
  if (step.projectSkillEvidence !== undefined) {
    const evidence = parseProjectSkillEvidence(step.projectSkillEvidence);
    if (
      scope.targets.length !== 1 ||
      scope.targets[0]?.projectId !== evidence.projectId ||
      !Array.isArray(step.metadataEffects)
    )
      throw new Error("Project skill effects require one exact project and agent.");
    const metadataEffects = step.metadataEffects.map(parseSkillUseEffect);
    if (
      metadataEffects.some(
        (effect) =>
          effect.location.projectId !== evidence.projectId || effect.location.harnessId !== scope.targets[0]?.harnessId,
      )
    )
      throw new Error("Project skill metadata exceeds its selected scope.");
    return {
      stepId: id(step.stepId, "Skill step id"),
      scope,
      plan: preview.plan,
      bindingEffects,
      files,
      metadataEffects,
      projectSkillEvidence: evidence,
    };
  }
  if (preview.plan.kind === "bridge-skill-uses") {
    if (
      files.length ||
      bindingEffects.length ||
      preview.plan.actions.length ||
      evidenceFields.some((field) => field !== undefined) ||
      step.baseReferences !== undefined ||
      step.unboundResolutionEnvelope !== undefined ||
      step.unboundResolutionRestoreOrigin !== undefined ||
      step.detachmentRestoreOrigin !== undefined ||
      !Array.isArray(step.metadataEffects)
    )
      throw new Error("Legacy bridge restore must contain only exact managed-use removals.");
    const metadataEffects = step.metadataEffects.map(parseSkillUseEffect);
    if (
      metadataEffects.some(
        ({ before, after, location }) =>
          !before ||
          after ||
          !scope.targets.some(
            (target) =>
              target.projectId === location.projectId &&
              target.harnessId === location.harnessId &&
              target.bindingId === before.bindingId,
          ),
      ) ||
      new Set(metadataEffects.map(({ location }) => JSON.stringify(location))).size !== metadataEffects.length
    )
      throw new Error("Legacy bridge restore metadata exceeds its exact scope.");
    return {
      stepId: id(step.stepId, "Skill step id"),
      scope,
      plan: preview.plan,
      bindingEffects,
      files,
      metadataEffects,
    };
  }
  if (
    (step.unboundResolutionEnvelope !== undefined || step.unboundResolutionRestoreOrigin !== undefined) &&
    step.unboundResolutionEvidence === undefined
  )
    throw new Error("An unbound resolution envelope requires its saved evidence.");
  const propagation = parseSkillPropagationStepMetadata(step);
  if ((preview.plan.kind === "propagate-skill") !== Boolean(propagation))
    throw new Error("Propagation step evidence is missing or attached to another operation.");
  if (propagation) {
    const evidence = propagation.propagationEvidence;
    const target = scope.targets[0];
    if (
      preview.plan.kind !== "propagate-skill" ||
      scope.targets.length !== 1 ||
      target?.projectId !== evidence.location.projectId ||
      target.harnessId !== evidence.location.harnessId ||
      target.bindingId !== propagation.metadataEffects[0]!.before?.bindingId ||
      bindingEffects.length !== 1 ||
      bindingEffects[0]!.bindingId !== target.bindingId ||
      !bindingEffects[0]!.before ||
      !bindingEffects[0]!.after ||
      bindingEffects[0]!.before.projectId !== evidence.location.projectId ||
      bindingEffects[0]!.after.projectId !== evidence.location.projectId
    )
      throw new Error("Propagation step does not match its single managed target.");
  }
  const detachment = propagation
    ? undefined
    : parseSkillDetachmentStepMetadata(
        step,
        scope,
        files.length,
        preview.plan.actions.length,
        preview.plan.kind,
        bindingEffects,
      );
  const resolution =
    propagation || detachment
      ? undefined
      : parseSkillResolutionStepMetadata(step, scope, files, preview.plan.actions, preview.plan.kind, bindingEffects);
  const adoption =
    propagation || detachment || resolution || step.unboundResolutionEvidence !== undefined
      ? undefined
      : parseSkillAdoptionStepMetadata(step, scope, files.length, preview.plan.actions.length);
  const capture =
    propagation || detachment || resolution || adoption || step.unboundResolutionEvidence !== undefined
      ? undefined
      : parseSkillVariantCaptureStepMetadata(
          step,
          scope,
          files,
          preview.plan.actions,
          preview.plan.kind,
          bindingEffects,
        );
  const unbound =
    propagation || detachment || resolution || adoption || capture
      ? undefined
      : parseSkillUnboundResolutionStepMetadata(
          step,
          scope,
          files,
          preview.plan.actions,
          preview.plan.kind,
          bindingEffects,
        );
  return {
    stepId: id(step.stepId, "Skill step id"),
    scope,
    plan: preview.plan,
    bindingEffects,
    files,
    ...(adoption ?? {}),
    ...(resolution ?? {}),
    ...(capture ?? {}),
    ...(unbound ?? {}),
    ...(detachment ?? {}),
    ...(propagation ?? {}),
  };
}
