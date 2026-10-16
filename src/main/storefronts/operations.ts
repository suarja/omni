import { buildCreatePlan, type CreateStored } from "./create-plan";
import { applyCreation, type NewPublication } from "./create-apply";
import { randomUUID } from "node:crypto";
import type { PreviewMarketplaceResponse, ApplyOperationResponse, OperationReceipt } from "../../shared/operations-ipc";
import { parseApplyOperationRequest } from "../../shared/operations-ipc";
import {
  parsePublishPluginRequest,
  parseRetryPushRequest,
  parseCreateStorefrontRequest,
} from "../../shared/publication-operations-ipc";
import { parsePreviewRestoreRequest } from "../../shared/operations-import-ipc";
import { buildPublishPlan, type PublishStored } from "./publish-plan";
import { writePublication, errorText, persistReceipt } from "./publish-write";
import {
  applyRecovery,
  buildRecoveryPlan,
  publicationReceipt,
  PublicationRecoveryError,
  type RecoveryStored,
} from "./publish-recovery";
import type { PublicationOptions } from "./publish-context";
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const task = (queues.get(key) ?? Promise.resolve()).then(action);
  queues.set(
    key,
    task.catch(() => undefined),
  );
  return task;
}
function block(reason: string, diagnostic: string): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic };
}
async function failedPublication(
  options: PublicationOptions,
  stored: PublishStored,
  error: unknown,
): Promise<ApplyOperationResponse> {
  const receipt: OperationReceipt = {
    operationId: stored.operationId,
    kind: "publish-plugin",
    status: "failed",
    appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
    displayTarget: stored.plan.displayTarget,
    actions: stored.plan.actions.map((action) => ({ ...action, status: "failed" })),
    git: { mode: "commit" },
    registered: { sourceId: stored.storefrontId },
    diagnostic: errorText(error),
  };
  return persistReceipt(options, receipt);
}
type PublicationOperations = Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  previewRestore(raw: unknown): Promise<PreviewMarketplaceResponse | undefined>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}>;
class PublicationOperationService {
  private readonly createPlans = new Map<string, CreateStored>();
  private readonly newPublishPlans = new Map<string, NewPublication>();
  private readonly plans = new Map<string, PublishStored>();
  private readonly recoveryPlans = new Map<string, RecoveryStored>();
  constructor(private readonly options: PublicationOptions) {}
  private async recoveryPreview(
    operationId: string,
    kind: "retry-push" | "restore-import",
  ): Promise<PreviewMarketplaceResponse | undefined> {
    const original = await publicationReceipt(this.options, operationId);
    if (!original) return undefined;
    try {
      const stored = await buildRecoveryPlan(this.options, original, kind);
      this.recoveryPlans.set(stored.plan.planId, stored);
      return { status: "ready", plan: stored.plan };
    } catch (error) {
      return block(
        error instanceof PublicationRecoveryError ? error.code : "publication-recovery-unavailable",
        errorText(error),
      );
    }
  }
  async previewRestore(raw: unknown): Promise<PreviewMarketplaceResponse | undefined> {
    return this.recoveryPreview(parsePreviewRestoreRequest(raw).operationId, "restore-import");
  }
  async preview(raw: unknown): Promise<PreviewMarketplaceResponse> {
    if (typeof raw === "object" && raw !== null && "kind" in raw) {
      if (raw.kind === "retry-push")
        return (
          (await this.recoveryPreview(parseRetryPushRequest(raw).operationId, "retry-push")) ??
          block("publication-recovery-unavailable", "The publication receipt is unavailable.")
        );
      if (raw.kind === "restore-import")
        return (
          (await this.previewRestore(raw)) ??
          block("publication-recovery-unavailable", "The publication receipt is unavailable.")
        );
      if (raw.kind === "create-storefront") return this.previewCreate(raw);
    }
    return this.previewPlugin(parsePublishPluginRequest(raw));
  }
  private async previewCreate(raw: unknown): Promise<PreviewMarketplaceResponse> {
    const { kind: _kind, ...input } = parseCreateStorefrontRequest(raw);
    try {
      const creation = await buildCreatePlan(this.options, input);
      if (creation.plan.publication?.findings.length)
        return { ...block("publication-checks", "Publication checks block storefront creation."), plan: creation.plan };
      this.createPlans.set(creation.plan.planId, creation);
      return { status: "ready", plan: creation.plan };
    } catch (error) {
      return block("storefront-creation-unavailable", errorText(error));
    }
  }
  private async previewPlugin(
    request: import("../../shared/publication-operations-ipc").PublishPluginRequest,
  ): Promise<PreviewMarketplaceResponse> {
    try {
      if (request.newStorefront) return await this.previewNewPublication(request);
      const stored = await buildPublishPlan(this.options, request);
      if (stored.plan.publication?.findings.length)
        return {
          ...block("publication-checks", "Publication checks block this plan. Fix the workshop and preview again."),
          plan: stored.plan,
        };
      this.plans.set(stored.plan.planId, stored);
      return { status: "ready", plan: stored.plan };
    } catch (error) {
      return block("publication-unavailable", errorText(error));
    }
  }
  private async previewNewPublication(
    request: import("../../shared/publication-operations-ipc").PublishPluginRequest,
  ): Promise<PreviewMarketplaceResponse> {
    const creation = await buildCreatePlan(this.options, request.newStorefront!);
    const publishing = await buildPublishPlan(this.options, request, randomUUID(), undefined, {
      root: creation.root,
      sourceId: creation.sourceId,
      files: creation.files,
      fingerprint: creation.fingerprint,
      remoteUrl: creation.remoteUrl,
    });
    const actions = new Map(
      [...creation.plan.actions, ...publishing.plan.actions].map((action) => [
        action.relativePath,
        { ...action, beforeHash: undefined },
      ]),
    );
    const plan = {
      ...publishing.plan,
      actions: [...actions.values()],
      notes: [...(creation.plan.notes ?? []), ...(publishing.plan.notes ?? [])],
    };
    if (plan.publication?.findings.length)
      return { ...block("publication-checks", "Publication checks block the new storefront publication."), plan };
    this.newPublishPlans.set(plan.planId, { creation, publishing });
    return { status: "ready", plan };
  }
  async apply(raw: unknown): Promise<ApplyOperationResponse | undefined> {
    const request = parseApplyOperationRequest(raw);
    const stored = this.plans.get(request.planId);
    const recovery = this.recoveryPlans.get(request.planId);
    const creation = this.createPlans.get(request.planId);
    const newPublication = this.newPublishPlans.get(request.planId);
    if (!stored && !recovery && !creation && !newPublication) return undefined;
    this.plans.delete(request.planId);
    this.recoveryPlans.delete(request.planId);
    this.createPlans.delete(request.planId);
    this.newPublishPlans.delete(request.planId);
    return serialize(this.options.userDataPath, async () => {
      if (creation || newPublication)
        return applyCreation(this.options, creation ?? newPublication!.creation, newPublication, request.provenance);
      if (recovery) return applyRecovery(this.options, recovery, request.provenance);
      return this.applySingle(stored!, request);
    });
  }
  private async applySingle(
    stored: PublishStored,
    request: import("../../shared/operations-ipc").ApplyOperationRequest,
  ): Promise<ApplyOperationResponse> {
    try {
      if (request.provenance?.agent && request.provenance.approval !== "omni")
        throw new Error("Agent publication always requires approval in Omni.");
      const choices = { ...stored.request.conflictChoices, ...request.conflictChoices };
      const fresh = await buildPublishPlan(
        this.options,
        { ...stored.request, conflictChoices: choices },
        stored.operationId,
      );
      if (fresh.fingerprint !== stored.fingerprint)
        throw new Error("The publication changed after preview. Preview again.");
      if (fresh.plan.publication?.conflicts.length)
        throw new Error("Resolve every conflicting file before publishing.");
      if (fresh.plan.publication?.findings.length)
        throw new Error("Publication checks block the chosen merged files. Fix the workshop and preview again.");
      return writePublication(
        this.options,
        { ...fresh, plan: { ...fresh.plan, planId: stored.plan.planId } },
        request.provenance,
      );
    } catch (error) {
      return failedPublication(this.options, stored, error);
    }
  }
}
export function createPublicationOperations(options: PublicationOptions): PublicationOperations {
  const service = new PublicationOperationService(options);
  return {
    preview: (raw) => service.preview(raw),
    previewRestore: (raw) => service.previewRestore(raw),
    apply: (raw) => service.apply(raw),
  };
}
