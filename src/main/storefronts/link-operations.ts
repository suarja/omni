import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import type { OperationStore } from "../operation-store";
import type { LinkStorefrontRequest } from "../../shared/storefront-link-ipc";
import type {
  ApplyOperationResponse,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../../shared/operations-ipc";
import { parseApplyOperationRequest } from "../../shared/operations-ipc";
import { samePlan } from "../../shared/agent-plan-freshness";
import { buildStorefrontLinkPlan, StorefrontLinkError } from "./link-plan";
import { createStorefrontService } from "./service";

type Stored = Readonly<{ plan: OperationPlan; request?: LinkStorefrontRequest; original?: OperationReceipt }>;
type Options = Readonly<{ userDataPath: string; store: OperationStore; now: () => number }>;
async function persistLinkReceipt(
  options: Options,
  receipt: OperationReceipt,
  original: OperationReceipt | undefined,
  mutated: boolean,
): Promise<void> {
  try {
    if ((await options.store.append(receipt)).status !== "ready") throw new Error("Receipt persistence failed.");
    if (
      original &&
      receipt.status === "applied" &&
      (await options.store.markRestored(original.operationId)).status !== "ready"
    )
      throw new Error("Undo receipt marking failed.");
  } catch {
    throw new Error(
      `${mutated ? "The storefront registry changed" : "The storefront link did not complete"}, but its receipt could not be saved. Inspect the registry and operation history before retrying.`,
    );
  }
}

export function createStorefrontLinkOperations(options: Options): Readonly<{
  preview(request: LinkStorefrontRequest): Promise<PreviewMarketplaceResponse>;
  previewRestore(operationId: string): Promise<PreviewMarketplaceResponse | undefined>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, Stored>();
  const registry = createLocalJsonRegistryStore(join(options.userDataPath, "omni/project-source-registry.json"));
  const service = createStorefrontService(options);
  let queue = Promise.resolve();
  const preview = async (request: LinkStorefrontRequest): Promise<PreviewMarketplaceResponse> => {
    try {
      const plan = await buildStorefrontLinkPlan(options.userDataPath, request);
      if (plan.storefrontLink?.action !== "existing") plans.set(plan.planId, { plan, request });
      return { status: "ready", plan };
    } catch (error) {
      return {
        status: "blocked",
        reason: error instanceof StorefrontLinkError ? error.code : "storefront-inspection-failed",
        diagnostic:
          error instanceof StorefrontLinkError
            ? error.message
            : "The storefront folder could not be read safely. Restore access and preview again.",
      };
    }
  };
  const previewRestore = async (operationId: string): Promise<PreviewMarketplaceResponse | undefined> => {
    const history = await options.store.read();
    if (history.status !== "ready")
      return { status: "blocked", reason: "receipt-unavailable", diagnostic: "Recover operation history before Undo." };
    const original = history.receipts.find((receipt) => receipt.operationId === operationId);
    if (original?.kind !== "link-storefront") return undefined;
    const loaded = await registry.read();
    const source =
      loaded.status === "ready" && loaded.state.sources.find((source) => source.id === original.registered?.sourceId);
    if (
      original.status !== "applied" ||
      original.restored ||
      !source ||
      source.archivedAt ||
      source.role !== "storefront"
    )
      return {
        status: "blocked",
        reason: "storefront-undo-unavailable",
        diagnostic: "This storefront link is missing, archived or already undone. Refresh the registry.",
      };
    // Undo changes registry state only, even when the storefront folder is offline.
    if (loaded.status !== "ready") throw new Error("The registry is unavailable. Preview Undo after recovery.");
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "archive-storefront",
      displayTarget: source.displayName,
      actions: [],
      git: { mode: "disabled", warnings: [] },
      storefrontLink: {
        path: source.locator.canonicalPath,
        action: "archive",
        storefrontId: source.id,
        revision: loaded.state.revision,
        fingerprint: createHash("sha256").update(JSON.stringify(loaded.state)).digest("hex"),
        inspection: { status: "ready", displayName: source.displayName, isGitRepository: false, plugins: [] },
        unlinkedPlugins: [],
      },
      notes: [
        "Undo archives the storefront link in Omni. Storefront files and publication baselines remain unchanged.",
      ],
    };
    plans.set(plan.planId, { plan, original });
    return { status: "ready", plan };
  };
  const execute = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const input = parseApplyOperationRequest(raw);
    const stored = plans.get(input.planId);
    if (!stored) return undefined;
    const history = await options.store.read();
    if (history.status !== "ready") throw new Error("Recover storefront link history before retrying.");
    const existing = history.receipts.find((receipt) => receipt.operationId === input.planId);
    if (existing) return { status: existing.status, receipt: existing };
    let sourceId = stored.plan.storefrontLink?.storefrontId;
    let diagnostic: string | undefined;
    let mutated = false;
    try {
      const fresh = stored.request ? await preview(stored.request) : await previewRestore(stored.original!.operationId);
      if (!fresh || fresh.status !== "ready" || !samePlan(stored.plan, fresh.plan))
        throw new Error("The storefront or registry changed. Preview the link again.");
      if (stored.request) {
        const result = await service.link(stored.plan.storefrontLink!.path);
        if (result.status !== "linked") {
          if (result.sourceId) {
            sourceId = result.sourceId;
            mutated = true;
          }
          throw new Error(result.message);
        }
        sourceId = result.sourceId;
        mutated = true;
      } else {
        const mutation = await registry.mutate(stored.plan.storefrontLink!.revision, (state) => ({
          ...state,
          sources: state.sources.map((source) =>
            source.id === sourceId ? { ...source, archivedAt: new Date(options.now()).toISOString() } : source,
          ),
        }));
        if (mutation.status !== "ready") throw new Error("The registry changed. Preview Undo again.");
        mutated = true;
      }
    } catch (error) {
      diagnostic =
        error instanceof Error ? error.message : "Storefront linking failed. Inspect the registry before retrying.";
    }
    const receipt: OperationReceipt = {
      operationId: input.planId,
      kind: stored.plan.kind,
      status: diagnostic ? "failed" : "applied",
      appliedAt: new Date(options.now()).toISOString(),
      displayTarget: stored.plan.displayTarget,
      actions: [],
      git: { mode: "disabled" },
      registered: sourceId ? { sourceId } : null,
      ...(stored.original ? { restores: stored.original.operationId } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    await persistLinkReceipt(options, receipt, stored.original, mutated);
    return { status: receipt.status, receipt };
  };
  return {
    preview,
    previewRestore,
    apply(raw) {
      const task = queue.then(() => execute(raw));
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}
