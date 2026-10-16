import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { RegistryIpcServices } from "./registry-ipc";
import type { OperationStore } from "./operation-store";
import type { RegisterProjectRequest } from "../shared/project-registration-ipc";
import type {
  ApplyOperationResponse,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import {
  resolveRegistrationPath,
  type RegistrationPathPolicy,
  type RegistrationPathResult,
} from "./project-registration-path";
import { samePlan } from "../shared/agent-plan-freshness";

type Options = Readonly<{
  registry: RegistryIpcServices;
  store: OperationStore;
  now: () => number;
  policy?: RegistrationPathPolicy;
}>;
type Stored = Readonly<{ plan: OperationPlan; request?: RegisterProjectRequest; original?: OperationReceipt }>;
async function describeRegistration(
  resolved: Extract<RegistrationPathResult, { status: "resolved" }>,
  action: "register" | "restore" | "existing",
  policy?: RegistrationPathPolicy,
): Promise<string> {
  const session =
    resolved.cwd && resolved.cwd !== resolved.root
      ? await resolveRegistrationPath(resolved.cwd, undefined, [], policy)
      : undefined;
  const otherFolder =
    resolved.cwd &&
    resolved.cwd !== resolved.root &&
    (session?.status !== "resolved" || session.root !== resolved.root);
  const home = policy?.homeDir ?? homedir();
  const displayPath = (path: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const folderNote = otherFolder ? ` — not this session's folder (${displayPath(resolved.cwd!)})` : "";
  return `${action === "restore" ? "Restore" : "Register"} project ${basename(resolved.root)} (${displayPath(resolved.root)}${resolved.gitRoot ? ", git root" : ""})${folderNote}. Omni will read its skills; nothing is written in the folder. Undo archives it.`;
}

export function createProjectRegistrationOperations(options: Options): Readonly<{
  preview(request: RegisterProjectRequest): Promise<PreviewMarketplaceResponse>;
  previewRestore(operationId: string): Promise<PreviewMarketplaceResponse | undefined>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, Stored>();
  let queue = Promise.resolve();
  const blocked = (reason: string, diagnostic: string): PreviewMarketplaceResponse => ({
    status: "blocked",
    reason,
    diagnostic,
  });
  const preview = async (request: RegisterProjectRequest): Promise<PreviewMarketplaceResponse> => {
    const listed = await options.registry.listRegistry();
    if (listed.status !== "ready" || !options.registry.getRegisteredLocator)
      return blocked("registry-unavailable", "The project registry is unavailable. Reopen Omni and retry.");
    const sources: string[] = [];
    for (const entry of listed.registry.sources) {
      const root = await options.registry.getRegisteredLocator(entry.ref);
      if (!root) return blocked("registry-unavailable", "A marketplace locator is unavailable. Refresh and retry.");
      sources.push(root);
    }
    const resolved = await resolveRegistrationPath(request.cwd, request.path, sources, options.policy);
    if (resolved.status === "blocked") return blocked(resolved.code, resolved.reason);
    let known: (typeof listed.registry.projects)[number] | undefined;
    for (const entry of listed.registry.projects) {
      if ((await options.registry.getRegisteredLocator(entry.ref)) === resolved.root) {
        known = entry;
        break;
      }
    }
    const action = known ? (known.archivedAt ? "restore" : "existing") : "register";
    const summary = await describeRegistration(resolved, action, options.policy);
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "register-project",
      displayTarget: basename(resolved.root),
      actions: [],
      git: { mode: "disabled", warnings: [] },
      projectRegistration: {
        path: resolved.root,
        ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
        gitRoot: resolved.gitRoot,
        device: resolved.device,
        inode: resolved.inode,
        action,
        revision: listed.registry.revision,
        ...(known ? { projectId: known.ref.id } : {}),
      },
      notes: [summary, ...(request.reason ? [request.reason] : [])],
    };
    if (action !== "existing") plans.set(plan.planId, { plan, request });
    return { status: "ready", plan };
  };
  const previewRestore = async (operationId: string): Promise<PreviewMarketplaceResponse | undefined> => {
    const history = await options.store.read();
    if (history.status !== "ready")
      return blocked("receipt-unavailable", "Operation history is unavailable. Inspect recovery before continuing.");
    const original = history.receipts.find((receipt) => receipt.operationId === operationId);
    if (original?.kind !== "register-project") return undefined;
    if (original.status !== "applied" || original.restored || !original.project)
      return blocked("project-undo-unavailable", "This project registration can no longer be undone.");
    const listed = await options.registry.listRegistry();
    if (listed.status !== "ready") return blocked("registry-unavailable", "The project registry is unavailable.");
    const entry = listed.registry.projects.find((entry) => entry.ref.id === original.project?.id);
    const root = entry && (await options.registry.getRegisteredLocator?.(entry.ref));
    if (!entry || entry.archivedAt || !root)
      return blocked(
        "project-undo-unavailable",
        "The registered project is missing or already archived. Refresh the registry.",
      );
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "archive-project",
      displayTarget: entry.displayName,
      actions: [],
      git: { mode: "disabled", warnings: [] },
      notes: ["Undo archives the project in Omni. Project files remain unchanged."],
      projectRegistration: {
        path: root,
        cwd: root,
        gitRoot: false,
        device: "",
        inode: "",
        action: "archive",
        projectId: entry.ref.id,
        revision: listed.registry.revision,
      },
    };
    plans.set(plan.planId, { plan, original });
    return { status: "ready", plan };
  };
  const execute = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const input = parseApplyOperationRequest(raw);
    const stored = plans.get(input.planId);
    if (!stored) return undefined;
    const registration = stored.plan.projectRegistration!;
    const operationId = input.planId;
    const history = await options.store.read();
    if (history.status !== "ready")
      throw new Error("Project registration history is unavailable. Inspect recovery before retrying.");
    const existing = history.receipts.find((receipt) => receipt.operationId === operationId);
    if (existing) return { status: existing.status, receipt: existing };
    let projectId = registration.projectId;
    let diagnostic: string | undefined;
    let mutated = false;
    try {
      if (stored.request) {
        const fresh = await preview(stored.request);
        if (fresh.status !== "ready" || !samePlan(stored.plan, fresh.plan))
          throw new Error("The project folder or registry changed. Preview registration again.");
        if (!options.registry.registerProjectByPath)
          throw new Error("Project registration is unavailable. Reopen Omni and retry.");
        const result = await options.registry.registerProjectByPath(registration.path);
        if (result.status !== "ready")
          throw new Error(`Project registration failed (${result.status}). Refresh the registry before retrying.`);
        projectId = result.entry.ref.id;
        mutated = result.outcome !== "existing";
      } else {
        const fresh = await previewRestore(stored.original!.operationId);
        if (!fresh || fresh.status !== "ready" || !samePlan(stored.plan, fresh.plan))
          throw new Error("The project registry changed. Preview Undo again.");
        const result = await options.registry.archiveProject?.(projectId!, registration.revision);
        if (result?.status !== "ready")
          throw new Error("Project archive failed. Refresh the registry before retrying.");
        mutated = true;
      }
    } catch (error) {
      diagnostic =
        error instanceof Error ? error.message : "Project registration failed. Inspect the registry before retrying.";
    }
    const receipt: OperationReceipt = {
      operationId,
      kind: stored.plan.kind,
      status: diagnostic ? "failed" : "applied",
      appliedAt: new Date(options.now()).toISOString(),
      displayTarget: stored.plan.displayTarget,
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      ...(projectId ? { project: { id: projectId } } : {}),
      ...(stored.original ? { restores: stored.original.operationId } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    try {
      const saved = await options.store.append(receipt);
      if (saved.status !== "ready") throw new Error("Receipt store is unavailable.");
      if (stored.original && !diagnostic) {
        const marked = await options.store.markRestored(stored.original.operationId);
        if (marked.status !== "ready") throw new Error("Undo receipt could not be marked.");
      }
    } catch {
      throw new Error(
        `${mutated ? "The project registry changed" : "Project registration did not complete"}, but its receipt could not be saved. Inspect the registry and operation history before retrying.`,
      );
    }
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
