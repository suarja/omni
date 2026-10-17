import { readDirectoryIdentity } from "./registry-directory-identity";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import { registerSource, type RegistryState } from "../domain/project-source-registry";
import { activeWorkshop, isWorkshopSource } from "../domain/source-roles";
import type { ConnectMarketplaceRequest } from "../shared/marketplace-connection-ipc";
import type {
  ApplyOperationResponse,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import { samePlan } from "../shared/agent-plan-freshness";
import type { OperationStore } from "./operation-store";
import { readGitText } from "./git-read";

type Options = Readonly<{
  userDataPath: string;
  store: OperationStore;
  now: () => number;
  onChanged?: () => Promise<void>;
}>;
type Stored = Readonly<{ plan: OperationPlan; request?: ConnectMarketplaceRequest; original?: OperationReceipt }>;
const fingerprint = (state: RegistryState): string => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const blocked = (reason: string, diagnostic: string): PreviewMarketplaceResponse => ({
  status: "blocked",
  reason,
  diagnostic,
});

export function createMarketplaceConnectionOperations(options: Options): Readonly<{
  preview(request: ConnectMarketplaceRequest): Promise<PreviewMarketplaceResponse>;
  previewRestore(operationId: string): Promise<PreviewMarketplaceResponse | undefined>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const registry = createLocalJsonRegistryStore(join(options.userDataPath, "omni/project-source-registry.json"));
  const plans = new Map<string, Stored>();
  let queue = Promise.resolve();
  async function preview(request: ConnectMarketplaceRequest): Promise<PreviewMarketplaceResponse> {
    const loaded = await registry.read();
    if (loaded.status !== "ready")
      return blocked("registry-unavailable", "Recover the marketplace registry and retry.");
    if (activeWorkshop(loaded.state))
      return blocked(
        "active-workshop-exists",
        "A personal marketplace is already connected. Keep its registration or archive it first.",
      );
    const source = loaded.state.sources.find(
      (source) => source.id === request.sourceId && !source.archivedAt && source.ownership === "external",
    );
    if (!source)
      return blocked("external-folder-unavailable", "This local external source is unavailable. Refresh the library.");
    try {
      const identity = await readDirectoryIdentity(source.locator.canonicalPath);
      const root = identity.canonicalPath;
      if (root !== source.locator.canonicalPath) throw Error("Folder identity changed.");
      const gitRoot = await readGitText(root, ["rev-parse", "--show-toplevel"]);
      if (!gitRoot || (await realpath(gitRoot)) !== root)
        return blocked(
          "marketplace-not-repository",
          "Select the root of a local marketplace Git repository. This folder is not a Git repository root.",
        );
      const plan: OperationPlan = {
        planId: randomUUID(),
        kind: "connect-marketplace",
        displayTarget: source.displayName,
        actions: [],
        git: { mode: "disabled", warnings: [] },
        marketplaceConnection: {
          sourceId: source.id,
          revision: loaded.state.revision,
          fingerprint: fingerprint(loaded.state),
          device: identity.device,
          inode: identity.inode,
        },
        notes: [
          "Use this folder as your personal marketplace and archive its external registration. Undo restores the external registration. No repository files change.",
        ],
      };
      plans.set(plan.planId, { plan, request });
      return { status: "ready", plan };
    } catch {
      return blocked(
        "marketplace-folder-inaccessible",
        "The local marketplace folder cannot be read safely. Restore access and retry.",
      );
    }
  }
  async function previewRestore(operationId: string): Promise<PreviewMarketplaceResponse | undefined> {
    const history = await options.store.read();
    if (history.status !== "ready") return blocked("receipt-unavailable", "Recover operation history before Undo.");
    const original = history.receipts.find((receipt) => receipt.operationId === operationId);
    if (original?.kind !== "connect-marketplace") return undefined;
    const loaded = await registry.read();
    if (loaded.status !== "ready")
      return blocked("registry-unavailable", "Recover the marketplace registry before Undo.");
    const external = loaded.state.sources.find((source) => source.id === original.source?.id);
    const workshop = loaded.state.sources.find((source) => source.id === original.registered?.sourceId);
    if (
      original.status !== "applied" ||
      original.restored ||
      !external?.archivedAt ||
      external.ownership !== "external" ||
      !isWorkshopSource(workshop) ||
      workshop.locator.canonicalPath !== external.locator.canonicalPath
    )
      return blocked(
        "marketplace-undo-unavailable",
        "The marketplace registrations changed or were already undone. Refresh the workspace.",
      );
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "undo-connect-marketplace",
      displayTarget: external.displayName,
      actions: [],
      git: { mode: "disabled", warnings: [] },
      marketplaceConnection: {
        sourceId: external.id,
        revision: loaded.state.revision,
        fingerprint: fingerprint(loaded.state),
        device: "",
        inode: "",
      },
      notes: [
        "Archive the personal workshop and restore its external registration. Repository files remain unchanged.",
      ],
    };
    plans.set(plan.planId, { plan, original });
    return { status: "ready", plan };
  }
  async function mutateConnection(stored: Stored): Promise<string | undefined> {
    let connectedId = stored.original?.registered?.sourceId;
    const approved = stored.plan.marketplaceConnection!;
    const mutation = await registry.mutate(approved.revision, (state) => {
      if (fingerprint(state) !== approved.fingerprint)
        throw Error("The registry changed. Review the connection again.");
      const external = state.sources.find((source) => source.id === approved.sourceId)!;
      const timestamp = new Date(options.now()).toISOString();
      if (stored.original)
        return {
          ...state,
          sources: state.sources.map((source) => {
            if (source.id === connectedId) return { ...source, archivedAt: timestamp };
            if (source.id !== external.id) return source;
            const { archivedAt: _archive, ...rest } = source;
            return rest;
          }),
        };
      // Reuse the normal personal-source registration rules, then retain the archived external identity.
      const decision = registerSource(
        { ...state, sources: state.sources.filter((source) => source.id !== external.id) },
        {
          displayName: external.displayName,
          canonicalPath: external.locator.canonicalPath,
          ownership: "personal",
          role: "workshop",
          createdAt: timestamp,
        },
      );
      if (decision.result.status !== "ready")
        throw Error("The personal marketplace could not be registered. Refresh and retry.");
      connectedId = decision.result.entry.ref.id;
      return {
        ...state,
        sources: [
          ...state.sources.map((source) =>
            source.id === external.id
              ? { ...source, archivedAt: timestamp }
              : (decision.nextState.sources.find((next) => next.id === source.id) ?? source),
          ),
          ...decision.nextState.sources.filter((source) => !state.sources.some((known) => known.id === source.id)),
        ],
      };
    });
    if (mutation.status !== "ready") throw Error("The marketplace registry changed. Review the connection again.");
    return connectedId;
  }
  async function execute(raw: unknown): Promise<ApplyOperationResponse | undefined> {
    const input = parseApplyOperationRequest(raw);
    const stored = plans.get(input.planId);
    if (!stored) return undefined;
    const history = await options.store.read();
    if (history.status !== "ready") throw Error("Recover marketplace connection history before retrying.");
    const existing = history.receipts.find((receipt) => receipt.operationId === input.planId);
    if (existing) return { status: existing.status, receipt: existing };
    let workshopId = stored.original?.registered?.sourceId;
    let diagnostic: string | undefined;
    let mutated = false;
    try {
      const fresh = stored.request ? await preview(stored.request) : await previewRestore(stored.original!.operationId);
      if (!fresh || fresh.status !== "ready" || !samePlan(stored.plan, fresh.plan))
        throw Error("The marketplace folder or registry changed. Review the connection again.");
      plans.delete(fresh.plan.planId);
      workshopId = await mutateConnection(stored);
      mutated = true;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : "Marketplace connection failed. Refresh and retry.";
    }
    const receipt: OperationReceipt = {
      operationId: input.planId,
      kind: stored.plan.kind,
      status: diagnostic ? "failed" : "applied",
      appliedAt: new Date(options.now()).toISOString(),
      displayTarget: stored.plan.displayTarget,
      actions: [],
      git: { mode: "disabled" },
      registered: workshopId ? { sourceId: workshopId } : null,
      source: { kind: "source", id: stored.plan.marketplaceConnection!.sourceId, relativePath: "." },
      ...(stored.original ? { restores: stored.original.operationId } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    if ((await options.store.append(receipt)).status !== "ready")
      throw Error(
        `${mutated ? "The marketplace registry changed" : "The marketplace connection failed"}, but its receipt could not be saved. Inspect the registry and history before retrying.`,
      );
    if (
      stored.original &&
      !diagnostic &&
      (await options.store.markRestored(stored.original.operationId)).status !== "ready"
    )
      throw Error("Undo completed, but its original receipt could not be marked. Inspect operation history.");
    if (mutated) {
      try {
        await options.onChanged?.();
      } catch {
        throw Error(
          "The marketplace registration changed and its receipt was saved, but the library refresh failed. Refresh the workspace or use Undo in History.",
        );
      }
    }
    return { status: receipt.status, receipt };
  }
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
