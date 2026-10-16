import { activeWorkshop, isWorkshopSource, type SourceRole } from "../domain/source-roles";
import { createProjectInspection } from "./project-inspection";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { app, dialog, ipcMain } from "electron";

import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import { isMissing } from "./fs-optional";
import {
  observeRegisteredEntry as observeRegisteredInventory,
  type ObservationGrant,
} from "../application/project-source-registry";
import { createDefaultRuntime, type Runtime } from "../application/runtime";
import {
  registerProject,
  registerSource,
  type EntryRef,
  type ProjectRegistration,
  type RegistryEntryView,
  type RegistryLoadResult,
  type RegistryState,
  type SourceRegistration,
} from "../domain/project-source-registry";
import type { ProjectSourceRegistryStore } from "../ports/project-source-registry";
import {
  REGISTRY_IPC_CHANNELS,
  parseEmptyRegistryRequest,
  parseObserveProjectRequest,
  parseObserveSourceRequest,
  parseRegisterSourceRequest,
  parseRegistryEntryRequest,
  parseRegistryLifecycleRequest,
  type OpenEntryResponse,
  type ObservationResponse,
  type RegisterProjectResponse,
  type RegisterSourceResponse,
  type RegistryMutationResponse,
  type RegistryViewResponse,
} from "../shared/registry-ipc";
import type { InventoryScanRequest } from "../application/inventory";
import { createReadableRegistryView } from "./registry-display";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type Clock = () => number;
type DirectoryPicker = Readonly<{
  showOpenDialog(options: { properties: readonly ["openDirectory"] }): Promise<{
    canceled: boolean;
    filePaths: readonly string[];
  }>;
}>;

type RegistryIpcOptions = Readonly<{
  runtime?: Runtime;
  now?: Clock;
  ttlMs?: number;
  userDataPath?: string;
  registryStore?: ProjectSourceRegistryStore;
  directoryPicker?: DirectoryPicker;
}>;

type DirectoryIdentity = Readonly<{
  canonicalPath: string;
  device: string;
  inode: string;
}>;

export type RegistryGrant = Readonly<{
  handle: string;
  subject: EntryRef;
  root: string;
  device: string;
  inode: string;
  expiresAt: number;
  displayName?: string;
}>;

export type RegistryGrantStore = Readonly<{
  issue(payload: Omit<RegistryGrant, "handle" | "expiresAt">): string;
  get(handle: string): RegistryGrant | undefined;
}>;

export type RegistryIpcServices = RegistryGrantStore &
  Readonly<{
    registerProjectByPath?(path: string): Promise<RegisterProjectResponse>;
    archiveProject?(id: string, expectedRevision: number): Promise<RegistryMutationResponse>;
    getRegisteredLocator?(ref: EntryRef): Promise<string | undefined>;
    registerSourceByPath(path: string, displayName: string): Promise<RegisterSourceResponse>;
    hasActivePersonalSource(): Promise<boolean>;
    listRegistry(): Promise<RegistryViewResponse>;
    getGrantForEntry(ref: EntryRef): Promise<string | undefined>;
    /** Local agent status only; registry views sent to the renderer remain redacted. */
    getRegisteredRoot(ref: EntryRef): Promise<string | undefined>;
    observeRegisteredEntry(ref: EntryRef): Promise<ObservationResponse>;
    observeEntryWithGrant(ref: EntryRef, grantHandle: string): Promise<ObservationResponse>;
  }>;

const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;

function sameRef(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Registry request failed safely.";
  if (
    message.length > 240 ||
    /[\r\n]/.test(message) ||
    /(?:password|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(message) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
  ) {
    return "Registry request failed safely.";
  }
  return message;
}

function safeCorrupt(result: { status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }): {
  status: "corrupt";
  diagnostic: string;
  recoveryAvailable: boolean;
} {
  return {
    status: "corrupt",
    diagnostic: safeErrorMessage(new Error(result.diagnostic)),
    recoveryAvailable: result.recoveryAvailable,
  };
}

function identityPart(value: bigint | number): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(path);
  const details = await stat(canonicalPath);
  if (!details.isDirectory()) throw new Error("Registered root is not a directory.");
  return {
    canonicalPath,
    device: identityPart(details.dev),
    inode: identityPart(details.ino),
  };
}

function createGrantStore(now: Clock, ttlMs: number): RegistryGrantStore {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("Registry grant limits are invalid.");
  const grants = new Map<string, RegistryGrant>();
  const prune = (): void => {
    const timestamp = now();
    for (const [handle, grant] of grants) if (grant.expiresAt <= timestamp) grants.delete(handle);
  };
  return {
    issue(payload) {
      prune();
      const handle = randomUUID();
      grants.set(handle, { ...payload, handle, expiresAt: now() + ttlMs });
      return handle;
    },
    get(handle) {
      prune();
      return grants.get(handle);
    },
  };
}

function findRegistration(state: RegistryState, ref: EntryRef): ProjectRegistration | SourceRegistration | undefined {
  const records = ref.kind === "project" ? state.projects : state.sources;
  return records.find((record) => record.id === ref.id);
}

function entryViewFor(state: RegistryState, ref: EntryRef): RegistryEntryView | undefined {
  return (
    ref.kind === "project" ? createReadableRegistryView(state).projects : createReadableRegistryView(state).sources
  ).find((entry) => sameRef(entry.ref, ref));
}

function viewFor(registry: RegistryViewResponse, ref: EntryRef): RegistryEntryView | undefined {
  if (registry.status !== "ready") return undefined;
  const entries = ref.kind === "project" ? registry.registry.projects : registry.registry.sources;
  return entries.find((entry) => sameRef(entry.ref, ref));
}

async function availabilityFor(state: RegistryState): Promise<RegistryViewResponse> {
  const availability = new Map<string, "available" | "missing" | "inaccessible">();
  const registrations = [...state.projects, ...state.sources];
  await Promise.all(
    registrations.map(async (registration) => {
      try {
        const identity = await readDirectoryIdentity(registration.locator.canonicalPath);
        availability.set(
          registration.locator.canonicalPath,
          identity.canonicalPath === registration.locator.canonicalPath ? "available" : "inaccessible",
        );
      } catch (error: unknown) {
        availability.set(registration.locator.canonicalPath, isMissing(error) ? "missing" : "inaccessible");
      }
    }),
  );
  return {
    status: "ready",
    registry: createReadableRegistryView(state, (locator) => availability.get(locator.canonicalPath) ?? "inaccessible"),
  };
}

function mutationError(
  result: Exclude<Awaited<ReturnType<ProjectSourceRegistryStore["mutate"]>>, { status: "ready" }>,
): RegistryMutationResponse {
  return result.status === "corrupt" ? safeCorrupt(result) : result;
}

async function loadStore(store: ProjectSourceRegistryStore): Promise<RegistryLoadResult> {
  return store.read();
}

function registrationResponse(
  entry: RegistryEntryView,
  outcome: "created" | "existing" | "reactivated",
  grantHandle: string,
  revision: number,
): RegisterProjectResponse | RegisterSourceResponse {
  return { status: "ready", outcome, entry, grantHandle, registryRevision: revision } as RegisterProjectResponse;
}

function grantSubject(subject: EntryRef, grant: RegistryGrant | undefined): ObservationGrant {
  if (!grant || !sameRef(subject, grant.subject)) throw new Error("Invalid or expired registry grant.");
  return { subject, canonicalPath: grant.root, rootHandle: grant.handle };
}

function updateArchive<T extends ProjectRegistration | SourceRegistration>(
  record: T,
  archivedAt: string | undefined,
): T {
  if (archivedAt) return { ...record, archivedAt } as T;
  const { archivedAt: _archivedAt, ...activeRecord } = record;
  return activeRecord as T;
}

export function registerRegistryIpcHandlers(
  assertTrustedSender: SenderGuard,
  options: RegistryIpcOptions = {},
): RegistryIpcServices {
  const runtime = options.runtime ?? createDefaultRuntime();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  const picker = options.directoryPicker ?? dialog;
  const userDataPath = options.userDataPath ?? app.getPath("userData");
  const store =
    options.registryStore ?? createLocalJsonRegistryStore(join(userDataPath, "omni", "project-source-registry.json"));
  const grants = createGrantStore(now, ttlMs);

  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeErrorMessage(error));
      }
    };

  const pickDirectory = async (): Promise<DirectoryIdentity | undefined> => {
    const result = await picker.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length !== 1) return undefined;
    return readDirectoryIdentity(result.filePaths[0] ?? "");
  };

  const issueGrant = async (subject: EntryRef, path: string): Promise<string> => {
    const identity = await readDirectoryIdentity(path);
    if (identity.canonicalPath !== path) throw new Error("Registered root changed.");
    return grants.issue({ subject, root: path, device: identity.device, inode: identity.inode });
  };

  const registerAtPath = async (
    kind: "project" | "source",
    path: string,
    ownership?: "personal" | "external",
    requestedDisplayName?: string,
    role?: SourceRole,
  ): Promise<RegisterProjectResponse | RegisterSourceResponse> => {
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") return safeCorrupt(loaded);
    let selected: DirectoryIdentity | undefined;
    try {
      selected = await readDirectoryIdentity(path);
    } catch (error: unknown) {
      return {
        status: "inaccessible",
        diagnostic: isMissing(error) ? "The selected directory is missing." : "The selected directory is inaccessible.",
      };
    }
    if (!selected) return { status: "cancelled" };
    const createdAt = new Date(now()).toISOString();
    const decision =
      kind === "project"
        ? registerProject(loaded.state, {
            displayName: requestedDisplayName || basename(selected.canonicalPath) || "Selected project",
            canonicalPath: selected.canonicalPath,
            createdAt,
          })
        : registerSource(loaded.state, {
            displayName: requestedDisplayName || basename(selected.canonicalPath) || "Selected source",
            canonicalPath: selected.canonicalPath,
            ownership: ownership as "personal" | "external",
            ...(role ? { role } : {}),
            createdAt,
          });
    if (decision.result.status !== "ready") return decision.result;
    let state = loaded.state;
    if (decision.result.outcome !== "existing") {
      const mutation = await store.mutate(loaded.state.revision, () => decision.nextState);
      if (mutation.status === "corrupt") return safeCorrupt(mutation);
      if (mutation.status !== "ready") return mutation;
      state = mutation.state;
    }
    const ref = decision.result.entry.ref;
    const registration = findRegistration(state, ref);
    if (!registration) throw new Error("Registered entry could not be reopened.");
    const grantHandle = await issueGrant(ref, registration.locator.canonicalPath);
    const entry = entryViewFor(state, ref);
    if (!entry) throw new Error("Registered entry view could not be created.");
    return registrationResponse(entry, decision.result.outcome, grantHandle, state.revision);
  };

  const register = async (
    kind: "project" | "source",
    ownership?: "personal" | "external",
    role?: SourceRole,
  ): Promise<RegisterProjectResponse | RegisterSourceResponse> => {
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") return safeCorrupt(loaded);
    let selected: DirectoryIdentity | undefined;
    try {
      selected = await pickDirectory();
    } catch (error: unknown) {
      return {
        status: "inaccessible",
        diagnostic: isMissing(error) ? "The selected directory is missing." : "The selected directory is inaccessible.",
      };
    }
    if (!selected) return { status: "cancelled" };
    return registerAtPath(kind, selected.canonicalPath, ownership, undefined, role);
  };

  const registerSourceByPath = async (path: string, displayName: string): Promise<RegisterSourceResponse> => {
    return registerAtPath("source", path, "personal", displayName) as Promise<RegisterSourceResponse>;
  };

  const hasActivePersonalSource = async (): Promise<boolean> => {
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") throw new Error("Registry is unavailable.");
    return Boolean(activeWorkshop(loaded.state));
  };

  const openEntry = async (rawRequest: unknown): Promise<OpenEntryResponse> => {
    const request = parseRegistryEntryRequest(rawRequest);
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") return safeCorrupt(loaded);
    const registration = findRegistration(loaded.state, request);
    const entry = viewFor(await availabilityFor(loaded.state), request);
    if (!registration || !entry) throw new Error("Registered entry is unknown.");
    if (registration.archivedAt) return { status: "inaccessible", entry, diagnostic: "The entry is archived." };
    try {
      const grantHandle = await issueGrant(request, registration.locator.canonicalPath);
      return { status: "granted", entry, grantHandle };
    } catch (error: unknown) {
      return {
        status: isMissing(error) ? "missing" : "inaccessible",
        entry,
        diagnostic: isMissing(error) ? "The registered root is missing." : "The registered root is inaccessible.",
      };
    }
  };

  const observe = async (kind: "project" | "source", rawRequest: unknown): Promise<ObservationResponse> => {
    const request = kind === "project" ? parseObserveProjectRequest(rawRequest) : parseObserveSourceRequest(rawRequest);
    const subject: EntryRef = { kind, id: "projectId" in request ? request.projectId : request.sourceId };
    const grantHandle = request.grantHandle;
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") return safeCorrupt(loaded);
    const entry = findRegistration(loaded.state, subject);
    const view = entryViewFor(loaded.state, subject);
    if (!entry || !view || entry.archivedAt) throw new Error("Registered entry is unknown or archived.");
    const grant = grants.get(grantHandle);
    const observationGrant = grantSubject(subject, grant);
    let identity: DirectoryIdentity;
    try {
      identity = await readDirectoryIdentity(entry.locator.canonicalPath);
    } catch (error: unknown) {
      return {
        status: isMissing(error) ? "missing" : "inaccessible",
        subject,
        diagnostic: isMissing(error) ? "The registered root is missing." : "The registered root is inaccessible.",
      };
    }
    if (
      identity.canonicalPath !== observationGrant.canonicalPath ||
      identity.device !== grant?.device ||
      identity.inode !== grant?.inode
    ) {
      return { status: "inaccessible", subject, diagnostic: "The registered root changed since it was opened." };
    }
    const result = await observeRegisteredInventory(
      loaded.state,
      { subject, grant: observationGrant, displayRoot: basename(entry.locator.canonicalPath) || "<root>" },
      runtime.scanInventory,
    );
    return result.status === "observed" ? result : { status: "inaccessible", subject, diagnostic: result.diagnostic };
  };

  const mutateLifecycle = async (rawRequest: unknown, archive: boolean): Promise<RegistryMutationResponse> => {
    const request = parseRegistryLifecycleRequest(rawRequest);
    const loaded = await loadStore(store);
    if (loaded.status === "corrupt") return safeCorrupt(loaded);
    const registration = findRegistration(loaded.state, request);
    if (!registration) throw new Error("Registered entry is unknown.");
    const archivedAt = archive ? new Date(now()).toISOString() : undefined;
    if (
      !archive &&
      request.kind === "source" &&
      isWorkshopSource({ ...(registration as SourceRegistration), archivedAt: undefined })
    ) {
      const workshop = activeWorkshop(loaded.state);
      if (workshop && workshop.id !== request.id)
        return { status: "workshop-conflict", reason: "active-workshop-exists", workshopId: workshop.id };
    }
    const mutation =
      request.kind === "project"
        ? await store.mutate(request.expectedRevision, (state) => ({
            ...state,
            projects: state.projects.map((record) =>
              record.id === request.id ? updateArchive(record, archivedAt) : record,
            ),
          }))
        : await store.mutate(request.expectedRevision, (state) => ({
            ...state,
            sources: state.sources.map((record) =>
              record.id === request.id ? updateArchive(record, archivedAt) : record,
            ),
          }));
    if (mutation.status !== "ready") return mutationError(mutation);
    return availabilityFor(mutation.state);
  };

  const projectInspection = createProjectInspection({
    grants,
    runtime,
    pickDirectory,
    readIdentity: readDirectoryIdentity,
    register: registerAtPath,
  });
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.inspectProject,
    guard(async (request) => {
      parseEmptyRegistryRequest(request);
      return projectInspection.inspect();
    }),
  );
  ipcMain.handle(REGISTRY_IPC_CHANNELS.registerInspectedProject, guard(projectInspection.register));
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.listRegistry,
    guard(async (request) => {
      parseEmptyRegistryRequest(request);
      const loaded = await loadStore(store);
      return loaded.status === "ready" ? availabilityFor(loaded.state) : safeCorrupt(loaded);
    }),
  );
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.registerProject,
    guard(async (request) => {
      parseEmptyRegistryRequest(request);
      return register("project");
    }),
  );
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.registerSource,
    guard(async (request) => {
      const parsed = parseRegisterSourceRequest(request);
      return register("source", parsed.ownership, parsed.role);
    }),
  );
  ipcMain.handle(REGISTRY_IPC_CHANNELS.openEntry, guard(openEntry));
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.observeProject,
    guard((request) => observe("project", request)),
  );
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.observeSource,
    guard((request) => observe("source", request)),
  );
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.archiveEntry,
    guard((request) => mutateLifecycle(request, true)),
  );
  ipcMain.handle(
    REGISTRY_IPC_CHANNELS.reactivateEntry,
    guard((request) => mutateLifecycle(request, false)),
  );

  const listRegistry = async (): Promise<RegistryViewResponse> => {
    const loaded = await loadStore(store);
    return loaded.status === "ready" ? availabilityFor(loaded.state) : safeCorrupt(loaded);
  };
  const getRegisteredRoot = async (ref: EntryRef): Promise<string | undefined> => {
    const loaded = await loadStore(store);
    if (loaded.status !== "ready") throw new Error("Registered roots are unavailable; inspect the registry.");
    const entry = findRegistration(loaded.state, ref);
    return entry && entry.archivedAt === undefined ? entry.locator.canonicalPath : undefined;
  };
  const getGrantForEntry = async (ref: EntryRef): Promise<string | undefined> => {
    const opened = await openEntry(ref);
    return opened.status === "granted" ? opened.grantHandle : undefined;
  };
  const observeRegistered = async (ref: EntryRef): Promise<ObservationResponse> => {
    const opened = await openEntry(ref);
    if (opened.status !== "granted") {
      return opened.status === "corrupt"
        ? opened
        : { status: opened.status, subject: ref, diagnostic: opened.diagnostic };
    }
    return observe(
      ref.kind,
      ref.kind === "project"
        ? { projectId: ref.id, grantHandle: opened.grantHandle }
        : { sourceId: ref.id, grantHandle: opened.grantHandle },
    );
  };
  const observeWithGrant = async (ref: EntryRef, grantHandle: string): Promise<ObservationResponse> =>
    observe(ref.kind, ref.kind === "project" ? { projectId: ref.id, grantHandle } : { sourceId: ref.id, grantHandle });
  return Object.assign(grants, {
    registerSourceByPath,
    registerProjectByPath: (path: string) => registerAtPath("project", path) as Promise<RegisterProjectResponse>,
    archiveProject: (id: string, expectedRevision: number) =>
      mutateLifecycle({ kind: "project", id, expectedRevision }, true),
    getRegisteredLocator: async (ref: EntryRef): Promise<string | undefined> => {
      const loaded = await loadStore(store);
      if (loaded.status !== "ready") throw new Error("Registry locators are unavailable; inspect the registry.");
      return findRegistration(loaded.state, ref)?.locator.canonicalPath;
    },
    hasActivePersonalSource,
    listRegistry,
    getGrantForEntry,
    getRegisteredRoot,
    observeRegisteredEntry: observeRegistered,
    observeEntryWithGrant: observeWithGrant,
  });
}
