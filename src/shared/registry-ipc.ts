import type {
  CorruptRegistryResult,
  EntryKind,
  EntryRef,
  Observation,
  RegistryEntryView,
  RegistryView,
  SourceEntryView,
  SourceOwnership,
  WorkshopConflict,
} from "../domain/project-source-registry";
import { parseSourceRole, type SourceRole } from "../domain/source-roles";
import { parseInventorySnapshot } from "./inventory-dto";

export const REGISTRY_IPC_CHANNELS = {
  listRegistry: "omni:registry:list",
  registerProject: "omni:registry:register-project",
  inspectProject: "omni:registry:inspect-project",
  registerInspectedProject: "omni:registry:register-inspected-project",
  registerSource: "omni:registry:register-source",
  openEntry: "omni:registry:open-entry",
  observeProject: "omni:registry:observe-project",
  observeSource: "omni:registry:observe-source",
  archiveEntry: "omni:registry:archive-entry",
  reactivateEntry: "omni:registry:reactivate-entry",
} as const;

export type RegistryEntryRequest = Readonly<{ kind: EntryKind; id: string }>;
export type RegisterSourceRequest = Readonly<{ ownership: SourceOwnership; role?: SourceRole }>;
export type RegistryLifecycleRequest = RegistryEntryRequest & Readonly<{ expectedRevision: number }>;
export type ObserveProjectRequest = Readonly<{ projectId: string; grantHandle: string }>;
export type ObserveSourceRequest = Readonly<{ sourceId: string; grantHandle: string }>;

export type RevisionConflictResponse = Readonly<{
  status: "revision-conflict";
  expected: number;
  actual: number;
}>;
export type RegistryMutationResponse =
  | Readonly<{ status: "ready"; registry: RegistryView }>
  | RevisionConflictResponse
  | CorruptRegistryResult
  | WorkshopConflict;
export type RegisterProjectResponse =
  | Readonly<{ status: "cancelled" }>
  | Readonly<{
      status: "ready";
      outcome: "created" | "existing" | "reactivated";
      entry: RegistryEntryView<"project">;
      grantHandle: string;
      registryRevision: number;
    }>
  | Readonly<{ status: "inaccessible"; diagnostic: string }>
  | RevisionConflictResponse
  | CorruptRegistryResult;
export type RegisterSourceResponse =
  | Readonly<{ status: "cancelled" }>
  | Readonly<{
      status: "ready";
      outcome: "created" | "existing" | "reactivated";
      entry: SourceEntryView;
      grantHandle: string;
      registryRevision: number;
    }>
  | Readonly<{
      status: "classification-conflict";
      entry: SourceEntryView;
      requestedOwnership: SourceOwnership;
      requestedRole?: SourceRole;
    }>
  | WorkshopConflict
  | Readonly<{ status: "inaccessible"; diagnostic: string }>
  | RevisionConflictResponse
  | CorruptRegistryResult;
export type OpenEntryResponse =
  | Readonly<{ status: "granted"; entry: RegistryEntryView; grantHandle: string }>
  | Readonly<{
      status: "missing" | "inaccessible";
      entry: RegistryEntryView;
      diagnostic: string;
    }>
  | CorruptRegistryResult;
export type ObservationResponse =
  | Readonly<{ status: "observed"; observation: Observation }>
  | Readonly<{
      status: "missing" | "inaccessible";
      subject: EntryRef;
      diagnostic: string;
    }>
  | CorruptRegistryResult;
export type RegistryViewResponse = Readonly<{ status: "ready"; registry: RegistryView }> | CorruptRegistryResult;

export interface RegistryDesktopApi {
  listRegistry(): Promise<RegistryViewResponse>;
  registerProject(): Promise<RegisterProjectResponse>;
  registerSource(request: RegisterSourceRequest): Promise<RegisterSourceResponse>;
  openEntry(request: RegistryEntryRequest): Promise<OpenEntryResponse>;
  observeProject(request: ObserveProjectRequest): Promise<ObservationResponse>;
  observeSource(request: ObserveSourceRequest): Promise<ObservationResponse>;
  archiveEntry(request: RegistryLifecycleRequest): Promise<RegistryMutationResponse>;
  reactivateEntry(request: RegistryLifecycleRequest): Promise<RegistryMutationResponse>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
  }
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function readId(value: unknown, label = "Entry id"): string {
  const id = readText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`${label} is malformed.`);
  }
  return id;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..") || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`${label} must be opaque.`);
  }
  return text;
}

function readDisplayRoot(value: unknown): string {
  const root = readText(value, "Display root");
  if (
    (root.includes("/") && !root.startsWith("~/")) ||
    /^[A-Za-z]:/u.test(root) ||
    root.includes("\\") ||
    root.split("/").some((part) => part === ".." || part === ".") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(root)
  ) {
    throw new Error("Display root is not safe for IPC.");
  }
  return root;
}

function readDiagnostic(value: unknown): string {
  const diagnostic = readText(value, "Registry diagnostic");
  if (
    diagnostic.length > 240 ||
    /[\r\n]/.test(diagnostic) ||
    /(?:password|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(diagnostic) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(diagnostic)
  ) {
    throw new Error("Registry diagnostic is not safe for IPC.");
  }
  return diagnostic;
}

function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Registry revision must be a non-negative integer.");
  }
  return value;
}

function readOwnership(value: unknown): SourceOwnership {
  if (value !== "personal" && value !== "external") {
    throw new Error("Source ownership is invalid.");
  }
  return value;
}

function parseRef(value: unknown): EntryRef {
  const ref = assertRecord(value, "Entry reference");
  assertKeys(ref, ["kind", "id"], "Entry reference");
  if (ref.kind !== "project" && ref.kind !== "source") {
    throw new Error("Entry kind is invalid.");
  }
  return { kind: ref.kind, id: readId(ref.id) };
}

function parseEntryView<K extends EntryKind>(value: unknown, expectedKind: K): RegistryEntryView<K> {
  const entry = assertRecord(value, "Registry entry");
  assertKeys(
    entry,
    ["ref", "displayName", "displayRoot", "availability", "archivedAt", "ownership", "role", "capabilities"],
    "Registry entry",
  );
  const ref = parseRef(entry.ref);
  if (ref.kind !== expectedKind) throw new Error("Registry entry kind is invalid.");
  if (entry.availability !== "available" && entry.availability !== "missing" && entry.availability !== "inaccessible") {
    throw new Error("Registry availability is invalid.");
  }
  return {
    ref: { kind: expectedKind, id: ref.id },
    displayName: readText(entry.displayName, "Display name"),
    displayRoot: readDisplayRoot(entry.displayRoot),
    availability: entry.availability,
    ...(entry.archivedAt === undefined ? {} : { archivedAt: readText(entry.archivedAt, "Archived at") }),
  };
}

function parseSourceView(value: unknown): SourceEntryView {
  const entry = assertRecord(value, "Source entry");
  assertKeys(
    entry,
    ["ref", "displayName", "displayRoot", "availability", "archivedAt", "ownership", "role", "capabilities"],
    "Source entry",
  );
  const base = parseEntryView(entry, "source");
  const ref = base.ref;
  const capabilities = assertRecord(entry.capabilities, "Source capabilities");
  assertKeys(capabilities, ["observe", "write"], "Source capabilities");
  if (capabilities.observe !== true || capabilities.write !== false) {
    throw new Error("Source capabilities are invalid.");
  }
  const role = parseSourceRole(readOwnership(entry.ownership), entry.role);
  return {
    ...base,
    ref,
    ownership: readOwnership(entry.ownership),
    ...(role ? { role } : {}),
    capabilities: { observe: true, write: false },
  };
}

function parseRegistry(value: unknown): RegistryView {
  const registry = assertRecord(value, "Registry view");
  assertKeys(registry, ["revision", "projects", "sources"], "Registry view");
  if (!Array.isArray(registry.projects) || !Array.isArray(registry.sources)) {
    throw new Error("Registry entries must be arrays.");
  }
  return {
    revision: readRevision(registry.revision),
    projects: registry.projects.map((entry) => parseEntryView(entry, "project")),
    sources: registry.sources.map(parseSourceView),
  };
}

function parseCorrupt(value: RecordValue): CorruptRegistryResult {
  assertKeys(value, ["status", "diagnostic", "recoveryAvailable"], "Corrupt registry response");
  if (value.status !== "corrupt" || typeof value.recoveryAvailable !== "boolean") {
    throw new Error("Corrupt registry response is invalid.");
  }
  return {
    status: "corrupt",
    diagnostic: readDiagnostic(value.diagnostic),
    recoveryAvailable: value.recoveryAvailable,
  };
}

function parseConflict(value: RecordValue): RevisionConflictResponse {
  assertKeys(value, ["status", "expected", "actual"], "Revision conflict");
  if (value.status !== "revision-conflict") throw new Error("Revision conflict is invalid.");
  return { status: "revision-conflict", expected: readRevision(value.expected), actual: readRevision(value.actual) };
}

function parseRegistryResult(value: unknown): RegistryMutationResponse {
  const response = assertRecord(value, "Registry response");
  if (response.status === "workshop-conflict") return parseWorkshopConflict(response);
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "revision-conflict") return parseConflict(response);
  if (response.status !== "ready") throw new Error("Registry response status is invalid.");
  assertKeys(response, ["status", "registry"], "Registry response");
  return { status: "ready", registry: parseRegistry(response.registry) };
}

export function parseEmptyRegistryRequest(value: unknown): void {
  const request = assertRecord(value, "Registry request");
  assertKeys(request, [], "Registry request");
}

export function parseRegistryEntryRequest(value: unknown): RegistryEntryRequest {
  return parseRef(value);
}

export function parseRegisterSourceRequest(value: unknown): RegisterSourceRequest {
  const request = assertRecord(value, "Source registration request");
  assertKeys(request, ["ownership", "role"], "Source registration request");
  const ownership = readOwnership(request.ownership);
  const role = parseSourceRole(ownership, request.role);
  return { ownership, ...(role ? { role } : {}) };
}

function parseWorkshopConflict(response: RecordValue): WorkshopConflict {
  assertKeys(response, ["status", "reason", "workshopId"], "Workshop conflict");
  if (response.reason !== "active-workshop-exists") throw new Error("Workshop conflict reason is invalid.");
  return { status: "workshop-conflict", reason: "active-workshop-exists", workshopId: readId(response.workshopId) };
}

export function parseRegistryLifecycleRequest(value: unknown): RegistryLifecycleRequest {
  const request = assertRecord(value, "Registry lifecycle request");
  assertKeys(request, ["kind", "id", "expectedRevision"], "Registry lifecycle request");
  return {
    ...parseRegistryEntryRequest({ kind: request.kind, id: request.id }),
    expectedRevision: readRevision(request.expectedRevision),
  };
}

export function parseObserveProjectRequest(value: unknown): ObserveProjectRequest {
  const request = assertRecord(value, "Project observation request");
  assertKeys(request, ["projectId", "grantHandle"], "Project observation request");
  return {
    projectId: readId(request.projectId, "Project id"),
    grantHandle: readOpaque(request.grantHandle, "Grant handle"),
  };
}

export function parseObserveSourceRequest(value: unknown): ObserveSourceRequest {
  const request = assertRecord(value, "Source observation request");
  assertKeys(request, ["sourceId", "grantHandle"], "Source observation request");
  return {
    sourceId: readId(request.sourceId, "Source id"),
    grantHandle: readOpaque(request.grantHandle, "Grant handle"),
  };
}

export function parseRegistryViewResponse(value: unknown): RegistryViewResponse {
  const response = assertRecord(value, "Registry view response");
  if (response.status === "corrupt") return parseCorrupt(response);
  assertKeys(response, ["status", "registry"], "Registry view response");
  if (response.status !== "ready") throw new Error("Registry view response status is invalid.");
  return { status: "ready", registry: parseRegistry(response.registry) };
}

function parseGrantHandle(value: unknown): string {
  return readOpaque(value, "Grant handle");
}

function parseRegisterEntry(value: unknown, kind: EntryKind): RegistryEntryView {
  const entry = kind === "project" ? parseEntryView(value, "project") : parseSourceView(value);
  if (entry.ref.kind !== kind) throw new Error("Registry entry kind is invalid.");
  return entry;
}

function entryKind(value: unknown): EntryKind {
  const entry = assertRecord(value, "Registry entry");
  return parseRef(entry.ref).kind;
}

export function parseRegisterProjectResponse(value: unknown): RegisterProjectResponse {
  const response = assertRecord(value, "Project registration response");
  if (response.status === "cancelled") {
    assertKeys(response, ["status"], "Project registration response");
    return { status: "cancelled" };
  }
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "revision-conflict") return parseConflict(response);
  if (response.status === "inaccessible") {
    assertKeys(response, ["status", "diagnostic"], "Project registration response");
    return { status: "inaccessible", diagnostic: readDiagnostic(response.diagnostic) };
  }
  assertKeys(
    response,
    ["status", "outcome", "entry", "grantHandle", "registryRevision"],
    "Project registration response",
  );
  if (response.status !== "ready" || !["created", "existing", "reactivated"].includes(String(response.outcome))) {
    throw new Error("Project registration response is invalid.");
  }
  return {
    status: "ready",
    outcome: response.outcome as "created" | "existing" | "reactivated",
    entry: parseRegisterEntry(response.entry, "project") as RegistryEntryView<"project">,
    grantHandle: parseGrantHandle(response.grantHandle),
    registryRevision: readRevision(response.registryRevision),
  };
}

export function parseRegisterSourceResponse(value: unknown): RegisterSourceResponse {
  const response = assertRecord(value, "Source registration response");
  if (response.status === "workshop-conflict") return parseWorkshopConflict(response);
  if (response.status === "cancelled") {
    assertKeys(response, ["status"], "Source registration response");
    return { status: "cancelled" };
  }
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "revision-conflict") return parseConflict(response);
  if (response.status === "inaccessible") {
    assertKeys(response, ["status", "diagnostic"], "Source registration response");
    return { status: "inaccessible", diagnostic: readDiagnostic(response.diagnostic) };
  }
  if (response.status === "classification-conflict") {
    assertKeys(response, ["status", "entry", "requestedOwnership", "requestedRole"], "Source conflict response");
    const role = parseSourceRole(readOwnership(response.requestedOwnership), response.requestedRole);
    return {
      status: "classification-conflict",
      entry: parseSourceView(response.entry),
      requestedOwnership: readOwnership(response.requestedOwnership),
      ...(role ? { requestedRole: role } : {}),
    };
  }
  assertKeys(
    response,
    ["status", "outcome", "entry", "grantHandle", "registryRevision"],
    "Source registration response",
  );
  if (response.status !== "ready" || !["created", "existing", "reactivated"].includes(String(response.outcome))) {
    throw new Error("Source registration response is invalid.");
  }
  return {
    status: "ready",
    outcome: response.outcome as "created" | "existing" | "reactivated",
    entry: parseSourceView(response.entry),
    grantHandle: parseGrantHandle(response.grantHandle),
    registryRevision: readRevision(response.registryRevision),
  };
}

export function parseOpenEntryResponse(value: unknown): OpenEntryResponse {
  const response = assertRecord(value, "Open entry response");
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "granted") {
    assertKeys(response, ["status", "entry", "grantHandle"], "Open entry response");
    return {
      status: "granted",
      entry: parseRegisterEntry(response.entry, entryKind(response.entry)),
      grantHandle: parseGrantHandle(response.grantHandle),
    };
  }
  assertKeys(response, ["status", "entry", "diagnostic"], "Open entry response");
  if (response.status !== "missing" && response.status !== "inaccessible")
    throw new Error("Open entry status is invalid.");
  return {
    status: response.status,
    entry: parseRegisterEntry(response.entry, entryKind(response.entry)),
    diagnostic: readDiagnostic(response.diagnostic),
  };
}

export function parseObservationResponse(value: unknown): ObservationResponse {
  const response = assertRecord(value, "Observation response");
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "observed") {
    assertKeys(response, ["status", "observation"], "Observation response");
    const observation = assertRecord(response.observation, "Observation");
    assertKeys(observation, ["subject", "observedAt", "inventory"], "Observation");
    return {
      status: "observed",
      observation: {
        subject: parseRef(observation.subject),
        observedAt: readText(observation.observedAt, "Observed at"),
        inventory: parseInventorySnapshot(observation.inventory),
      },
    };
  }
  assertKeys(response, ["status", "subject", "diagnostic"], "Observation response");
  if (response.status !== "missing" && response.status !== "inaccessible")
    throw new Error("Observation status is invalid.");
  return {
    status: response.status,
    subject: parseRef(response.subject),
    diagnostic: readDiagnostic(response.diagnostic),
  };
}

export function parseRegistryMutationResponse(value: unknown): RegistryMutationResponse {
  return parseRegistryResult(value);
}
