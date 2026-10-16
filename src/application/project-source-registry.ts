import type { InventoryScanRequest } from "./inventory";
import type { InventoryObservationScope, InventorySnapshot } from "../domain/inventory";
import type { EntryRef, Observation, RegistryState } from "../domain/project-source-registry";

export type ObservationGrant = Readonly<{
  subject: EntryRef;
  canonicalPath: string;
  rootHandle: string;
}>;

export type RegisteredObservationRequest = Readonly<{
  subject: EntryRef;
  grant: ObservationGrant;
  displayRoot: string;
  observedAt?: string;
  gitScopes?: InventoryScanRequest["gitScopes"];
}>;

export type ObservationRunner = (request: InventoryScanRequest) => Promise<InventorySnapshot>;

export type RegisteredObservationResult =
  | Readonly<{ status: "observed"; observation: Observation }>
  | Readonly<{
      status: "inaccessible";
      subject: EntryRef;
      diagnostic: "The registered root could not be observed.";
    }>;

type RegisteredEntry = Readonly<{
  id: string;
  archivedAt?: string;
  locator: Readonly<{ kind: "local-directory"; canonicalPath: string }>;
}>;

function sameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function observationScope(kind: EntryRef["kind"]): InventoryObservationScope {
  return kind === "project" ? "project" : "source";
}

function findActiveEntry(state: RegistryState, subject: EntryRef): RegisteredEntry | undefined {
  const records = subject.kind === "project" ? state.projects : state.sources;
  return records.find((record) => record.id === subject.id && record.archivedAt === undefined);
}

function assertGrantBinding(request: RegisteredObservationRequest, entry: RegisteredEntry): void {
  if (!sameEntry(request.subject, request.grant.subject)) {
    throw new Error("Observation grant is bound to another entry.");
  }
  if (request.grant.canonicalPath !== entry.locator.canonicalPath) {
    throw new Error("Observation grant does not match the registered root.");
  }
  if (!request.grant.rootHandle.trim()) {
    throw new Error("Observation grant handle is required.");
  }
}

function assertSnapshotScope(snapshot: InventorySnapshot, scope: InventoryObservationScope): void {
  if (snapshot.artifacts.some((artifact) => artifact.scope !== scope)) {
    throw new Error("Observed inventory scope does not match the registered entry.");
  }
}

export async function observeRegisteredEntry(
  state: RegistryState,
  request: RegisteredObservationRequest,
  run: ObservationRunner,
): Promise<RegisteredObservationResult> {
  const entry = findActiveEntry(state, request.subject);
  if (!entry) {
    throw new Error("The registered entry is unknown or archived.");
  }
  assertGrantBinding(request, entry);

  const scope = observationScope(request.subject.kind);
  let inventory: InventorySnapshot;
  try {
    inventory = await run({
      approvedRoot: entry.locator.canonicalPath,
      rootHandle: request.grant.rootHandle,
      displayRoot: request.displayRoot,
      scope,
      ...(request.observedAt ? { observedAt: request.observedAt } : {}),
      ...(request.gitScopes ? { gitScopes: request.gitScopes } : {}),
    });
  } catch {
    return {
      status: "inaccessible",
      subject: request.subject,
      diagnostic: "The registered root could not be observed.",
    };
  }

  assertSnapshotScope(inventory, scope);
  return {
    status: "observed",
    observation: {
      subject: request.subject,
      observedAt: inventory.observedAt,
      inventory,
    },
  };
}
