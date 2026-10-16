import { buildCreatePlan, type CreateStored } from "./create-plan";
import { writeStorefront } from "./create-write";
import { buildPublishPlan, type PublishStored } from "./publish-plan";
import { errorText, persistReceipt, writePublication } from "./publish-write";
import type { PublicationOptions } from "./publish-context";
import type { ApplyOperationResponse, OperationApplyProvenance } from "../../shared/operations-ipc";
export type NewPublication = Readonly<{ creation: CreateStored; publishing: PublishStored }>;
export async function applyCreation(
  options: PublicationOptions,
  target: CreateStored,
  newPublication?: NewPublication,
  provenance?: OperationApplyProvenance,
): Promise<ApplyOperationResponse> {
  let created: ApplyOperationResponse | undefined;

  try {
    if (provenance?.agent && provenance.approval !== "omni")
      throw new Error("Agent publication always requires approval in Omni.");
    const freshCreation = await buildCreatePlan(options, target.input, target.sourceId, target.operationId);
    if (freshCreation.fingerprint !== target.fingerprint)
      throw new Error("The storefront creation target changed. Preview again.");
    if (newPublication) {
      const fresh = await buildPublishPlan(
        options,
        newPublication.publishing.request,
        newPublication.publishing.operationId,
        undefined,
        {
          root: target.root,
          sourceId: target.sourceId,
          files: freshCreation.files,
          fingerprint: freshCreation.fingerprint,
          remoteUrl: target.remoteUrl,
        },
      );
      if (fresh.fingerprint !== newPublication.publishing.fingerprint || fresh.plan.publication?.findings.length)
        throw new Error("The new publication changed. Preview again.");
    }
    created = await writeStorefront(options, freshCreation, provenance);
    if (created.status !== "applied" || !newPublication) return created;
    const publishing = await buildPublishPlan(
      options,
      {
        kind: "publish-plugin",
        pluginId: newPublication.publishing.request.pluginId,
        storefrontId: target.sourceId,
      },
      newPublication.publishing.operationId,
    );
    if (
      JSON.stringify(publishing.plan.actions) !== JSON.stringify(newPublication.publishing.plan.actions) ||
      publishing.plan.publication?.findings.length
    )
      throw new Error("The storefront was created, but the publication changed. Preview the plugin again.");
    return writePublication(options, { ...publishing, children: [created.receipt.operationId] }, provenance);
  } catch (error) {
    if (created && newPublication)
      return persistReceipt(options, {
        operationId: newPublication.publishing.operationId,
        kind: "publish-plugin",
        status: "failed",
        appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
        displayTarget: newPublication.publishing.plan.displayTarget,
        actions: newPublication.publishing.plan.actions.map((action) => ({ ...action, status: "failed" })),
        git: { mode: "commit" },
        registered: created.receipt.registered,
        children: [created.receipt.operationId],
        diagnostic: errorText(error),
      });
    return persistReceipt(options, {
      operationId: target.operationId,
      kind: "create-storefront",
      status: "failed",
      appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
      displayTarget: target.input.name,
      actions: target.plan.actions.map((action) => ({ ...action, status: "failed" })),
      git: { mode: "init-and-commit" },
      registered: null,
      diagnostic: errorText(error),
    });
  }
}
