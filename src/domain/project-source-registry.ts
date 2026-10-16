import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";

import type { InventorySnapshot } from "./inventory";
import { activeWorkshop, parseSourceRole, type SourceRole } from "./source-roles";

export type EntryKind = "project" | "source";
export type EntryRef = Readonly<{ kind: EntryKind; id: string }>;
export type LocalDirectoryLocator = Readonly<{
  kind: "local-directory";
  canonicalPath: string;
}>;
export type SourceOwnership = "personal" | "external";

export type ProjectRegistration = Readonly<{
  id: string;
  displayName: string;
  locator: LocalDirectoryLocator;
  createdAt: string;
  archivedAt?: string;
}>;

export type SourceRegistration = Readonly<{
  id: string;
  displayName: string;
  locator: LocalDirectoryLocator;
  ownership: SourceOwnership;
  role?: SourceRole;
  createdAt: string;
  archivedAt?: string;
}>;

export type RegistryState = Readonly<{
  schemaVersion: 1;
  revision: number;
  projects: readonly ProjectRegistration[];
  sources: readonly SourceRegistration[];
}>;

export type Availability = "available" | "missing" | "inaccessible";
export type RegistryEntryView<K extends EntryKind = EntryKind> = Readonly<{
  ref: Readonly<{ kind: K; id: string }>;
  displayName: string;
  displayRoot: string;
  availability: Availability;
  archivedAt?: string;
}>;
export type SourceEntryView = RegistryEntryView<"source"> &
  Readonly<{
    ownership: SourceOwnership;
    role?: SourceRole;
    capabilities: Readonly<{ observe: true; write: false }>;
  }>;
export type RegistryView = Readonly<{
  revision: number;
  projects: readonly RegistryEntryView<"project">[];
  sources: readonly SourceEntryView[];
}>;

export type CorruptRegistryResult = Readonly<{
  status: "corrupt";
  diagnostic: string;
  recoveryAvailable: boolean;
}>;
export type RegistryLoadResult = Readonly<{ status: "ready"; state: RegistryState }> | CorruptRegistryResult;
export type RevisionConflictResult = Readonly<{
  status: "revision-conflict";
  expected: number;
  actual: number;
}>;
export type RegistryMutationResult =
  Readonly<{ status: "ready"; state: RegistryState }> | RevisionConflictResult | CorruptRegistryResult;
export type RegistryViewResult = Readonly<{ status: "ready"; registry: RegistryView }> | CorruptRegistryResult;

export type RegisterOutcome = "created" | "existing" | "reactivated";
export type RegistrationInput = Readonly<{
  id?: string;
  displayName: string;
  canonicalPath: string;
  createdAt: string;
}>;
export type SourceRegistrationInput = RegistrationInput &
  Readonly<{
    ownership: SourceOwnership;
    role?: SourceRole;
  }>;
export type ProjectRegistrationResult = Readonly<{
  status: "ready";
  outcome: RegisterOutcome;
  entry: RegistryEntryView<"project">;
}>;
export type ProjectRegistrationDecision = Readonly<{
  result: ProjectRegistrationResult;
  nextState: RegistryState;
}>;
export type SourceClassificationConflict = Readonly<{
  status: "classification-conflict";
  entry: SourceEntryView;
  requestedOwnership: SourceOwnership;
  requestedRole?: SourceRole;
}>;
export type WorkshopConflict = Readonly<{
  status: "workshop-conflict";
  reason: "active-workshop-exists";
  workshopId: string;
}>;
export type SourceRegistrationResult =
  | Readonly<{
      status: "ready";
      outcome: RegisterOutcome;
      entry: SourceEntryView;
    }>
  | SourceClassificationConflict
  | WorkshopConflict;
export type SourceRegistrationDecision = Readonly<{
  result: SourceRegistrationResult;
  nextState: RegistryState;
}>;

export type Observation = Readonly<{
  subject: EntryRef;
  observedAt: string;
  inventory: InventorySnapshot;
}>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is RecordValue {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertKeys(value: RecordValue, label: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${label} contains unknown field "${unknown}".`);
  }
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readId(value: unknown): string {
  const id = readString(value, "Registration id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Registration id "${id}" is malformed.`);
  }
  return id;
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readString(value, label);
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be an ISO-8601 timestamp.`);
  }
  return timestamp;
}

export function parseLocalDirectoryLocator(value: unknown): LocalDirectoryLocator {
  assertRecord(value, "Directory locator");
  assertKeys(value, "Directory locator", ["kind", "canonicalPath"]);
  if (value.kind !== "local-directory") {
    throw new Error("Directory locator kind is unsupported.");
  }
  const canonicalPath = readString(value.canonicalPath, "Canonical path");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(canonicalPath)) {
    throw new Error("Canonical path contains control characters.");
  }
  if (!isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath) {
    throw new Error("Canonical path must be normalized and absolute.");
  }
  return Object.freeze({ kind: "local-directory", canonicalPath });
}

export function parseEntryRef(value: unknown): EntryRef {
  assertRecord(value, "Entry reference");
  assertKeys(value, "Entry reference", ["kind", "id"]);
  if (value.kind !== "project" && value.kind !== "source") {
    throw new Error("Entry reference kind is unsupported.");
  }
  return Object.freeze({ kind: value.kind, id: readId(value.id) });
}

function parseRegistration(value: unknown, kind: EntryKind): ProjectRegistration | SourceRegistration {
  assertRecord(value, `${kind} registration`);
  const keys =
    kind === "source"
      ? ["id", "displayName", "locator", "ownership", "role", "createdAt", "archivedAt"]
      : ["id", "displayName", "locator", "createdAt", "archivedAt"];
  assertKeys(value, `${kind} registration`, keys);
  const registration = {
    id: readId(value.id),
    displayName: readString(value.displayName, "Display name"),
    locator: parseLocalDirectoryLocator(value.locator),
    createdAt: readTimestamp(value.createdAt, "Created at"),
    ...(value.archivedAt === undefined ? {} : { archivedAt: readTimestamp(value.archivedAt, "Archived at") }),
  };
  if (kind === "source") {
    if (value.ownership !== "personal" && value.ownership !== "external") {
      throw new Error("Source ownership is unsupported.");
    }
    const role = parseSourceRole(value.ownership, value.role);
    return Object.freeze({ ...registration, ownership: value.ownership, ...(role ? { role } : {}) });
  }
  return Object.freeze(registration);
}

export function parseProjectRegistration(value: unknown): ProjectRegistration {
  return parseRegistration(value, "project") as ProjectRegistration;
}

export function parseSourceRegistration(value: unknown): SourceRegistration {
  return parseRegistration(value, "source") as SourceRegistration;
}

function assertRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Registry revision must be a non-negative integer.");
  }
  return value;
}

function assertUniqueRecords(projects: readonly ProjectRegistration[], sources: readonly SourceRegistration[]): void {
  const ids = new Set<string>();
  const activeLocators = new Set<string>();
  for (const [kind, records] of [
    ["project", projects],
    ["source", sources],
  ] as const) {
    for (const record of records) {
      if (ids.has(record.id)) {
        throw new Error(`Duplicate registration id "${record.id}".`);
      }
      ids.add(record.id);
      if (record.archivedAt === undefined) {
        const locatorKey = `${kind}:${record.locator.canonicalPath}`;
        if (activeLocators.has(locatorKey)) {
          throw new Error(`Duplicate active ${kind} locator.`);
        }
        activeLocators.add(locatorKey);
      }
    }
  }
}

export function parseRegistryState(value: unknown): RegistryState {
  assertRecord(value, "Registry state");
  assertKeys(value, "Registry state", ["schemaVersion", "revision", "projects", "sources"]);
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported registry schema version.");
  }
  const revision = assertRevision(value.revision);
  if (!Array.isArray(value.projects) || !Array.isArray(value.sources)) {
    throw new Error("Registry projects and sources must be arrays.");
  }
  const projects = value.projects.map(parseProjectRegistration);
  const sources = value.sources.map(parseSourceRegistration);
  assertUniqueRecords(projects, sources);
  return Object.freeze({
    schemaVersion: 1,
    revision,
    projects: Object.freeze(projects),
    sources: Object.freeze(sources),
  });
}

function displayRoot(canonicalPath: string): string {
  return basename(canonicalPath) || "<root>";
}

function entryView<K extends EntryKind>(
  kind: K,
  registration: ProjectRegistration | SourceRegistration,
  availability: Availability,
): RegistryEntryView<K> {
  return {
    ref: { kind, id: registration.id },
    displayName: registration.displayName,
    displayRoot: displayRoot(registration.locator.canonicalPath),
    availability,
    ...(registration.archivedAt ? { archivedAt: registration.archivedAt } : {}),
  } as RegistryEntryView<K>;
}

export function createRegistryView(
  state: RegistryState,
  resolveAvailability: (locator: LocalDirectoryLocator) => Availability = () => "available",
): RegistryView {
  return {
    revision: state.revision,
    projects: state.projects.map(
      (registration) =>
        entryView("project", registration, resolveAvailability(registration.locator)) as RegistryEntryView<"project">,
    ),
    sources: state.sources.map((registration) => ({
      ...entryView("source", registration, resolveAvailability(registration.locator)),
      ownership: registration.ownership,
      ...(registration.role ? { role: registration.role } : {}),
      capabilities: { observe: true, write: false },
    })),
  };
}

function validateInput(input: RegistrationInput): RegistrationInput {
  const id = input.id === undefined ? undefined : readId(input.id);
  const displayName = readString(input.displayName, "Display name");
  const canonicalPath = parseLocalDirectoryLocator({
    kind: "local-directory",
    canonicalPath: input.canonicalPath,
  }).canonicalPath;
  const createdAt = readTimestamp(input.createdAt, "Created at");
  return { ...(id ? { id } : {}), displayName, canonicalPath, createdAt };
}

function nextState(
  state: RegistryState,
  projects: readonly ProjectRegistration[],
  sources: readonly SourceRegistration[],
): RegistryState {
  return parseRegistryState({
    schemaVersion: 1,
    revision: state.revision,
    projects,
    sources,
  });
}

function findByPath<T extends ProjectRegistration | SourceRegistration>(
  records: readonly T[],
  canonicalPath: string,
): T | undefined {
  return (
    records.find((record) => record.archivedAt === undefined && record.locator.canonicalPath === canonicalPath) ??
    records.find((record) => record.archivedAt !== undefined && record.locator.canonicalPath === canonicalPath)
  );
}

function createId(inputId: string | undefined, state: RegistryState): string {
  const id = inputId ?? randomUUID();
  const ids = new Set([...state.projects, ...state.sources].map((record) => record.id));
  if (ids.has(id)) {
    throw new Error(`Duplicate registration id "${id}".`);
  }
  return id;
}

function sourceEntryView(registration: SourceRegistration): SourceEntryView {
  return {
    ...entryView("source", registration, "available"),
    ownership: registration.ownership,
    ...(registration.role ? { role: registration.role } : {}),
    capabilities: { observe: true, write: false },
  };
}

export function registerProject(state: RegistryState, input: RegistrationInput): ProjectRegistrationDecision {
  const validInput = validateInput(input);
  const match = findByPath(state.projects, validInput.canonicalPath);
  if (match && match.archivedAt === undefined) {
    return {
      result: { status: "ready", outcome: "existing", entry: entryView("project", match, "available") },
      nextState: state,
    };
  }
  if (match) {
    const registration = {
      ...match,
      displayName: validInput.displayName,
      archivedAt: undefined,
    } as ProjectRegistration;
    return {
      result: { status: "ready", outcome: "reactivated", entry: entryView("project", registration, "available") },
      nextState: nextState(
        state,
        state.projects.map((item) => (item.id === match.id ? registration : item)),
        state.sources,
      ),
    };
  }
  const registration: ProjectRegistration = {
    id: createId(validInput.id, state),
    displayName: validInput.displayName,
    locator: { kind: "local-directory", canonicalPath: validInput.canonicalPath },
    createdAt: validInput.createdAt,
  };
  return {
    result: { status: "ready", outcome: "created", entry: entryView("project", registration, "available") },
    nextState: nextState(state, [...state.projects, registration], state.sources),
  };
}

export function registerSource(state: RegistryState, input: SourceRegistrationInput): SourceRegistrationDecision {
  const validInput = validateInput(input);
  if (input.ownership !== "personal" && input.ownership !== "external") {
    throw new Error("Source ownership is unsupported.");
  }
  const role = parseSourceRole(input.ownership, input.role);
  const match = findByPath(state.sources, validInput.canonicalPath);
  if (match && (match.ownership !== input.ownership || (match.role ?? "workshop") !== (role ?? "workshop"))) {
    return {
      result: {
        status: "classification-conflict",
        entry: sourceEntryView(match),
        requestedOwnership: input.ownership,
        ...(role ? { requestedRole: role } : {}),
      },
      nextState: state,
    };
  }
  if (match && match.archivedAt === undefined) {
    return {
      result: { status: "ready", outcome: "existing", entry: sourceEntryView(match) },
      nextState: state,
    };
  }
  const workshop = activeWorkshop(state);
  if (input.ownership === "personal" && role !== "storefront" && workshop) {
    return {
      result: { status: "workshop-conflict", reason: "active-workshop-exists", workshopId: workshop.id },
      nextState: state,
    };
  }
  if (match) {
    const registration = {
      ...match,
      displayName: validInput.displayName,
      archivedAt: undefined,
    } as SourceRegistration;
    return {
      result: { status: "ready", outcome: "reactivated", entry: sourceEntryView(registration) },
      nextState: nextState(
        state,
        state.projects,
        state.sources.map((item) => (item.id === match.id ? registration : item)),
      ),
    };
  }
  const registration: SourceRegistration = {
    id: createId(validInput.id, state),
    displayName: validInput.displayName,
    locator: { kind: "local-directory", canonicalPath: validInput.canonicalPath },
    ownership: input.ownership,
    ...(role ? { role } : {}),
    createdAt: validInput.createdAt,
  };
  return {
    result: { status: "ready", outcome: "created", entry: sourceEntryView(registration) },
    nextState: nextState(state, state.projects, [...state.sources, registration]),
  };
}
