import { activeWorkshop, activeStorefronts, assertWorkshopTarget, StorefrontTargetError } from "../domain/source-roles";
import { homedir } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { parseRegistryState } from "../domain/project-source-registry";
import type { PathsResponse } from "../shared/operations-import-ipc";

export type PersonalMarketplace = Readonly<{ id: string; name: string; root: string }>;

function isWithin(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith("../") && !distance.startsWith("/"));
}

function displayRoot(path: string): string {
  const home = resolve(homedir());
  const resolved = resolve(path);
  if (resolved === home) return "~";
  if (isWithin(home, resolved)) return `~/${relative(home, resolved).replaceAll("\\", "/")}`;
  return resolved;
}

// Source write operations may edit connected checkouts, but never published storefront copies.
export async function readRegisteredSource(
  userDataPath: string,
  sourceId: string,
  ownership?: "personal" | "external",
): Promise<PersonalMarketplace | undefined> {
  const registryPath = join(resolve(userDataPath), "omni", "project-source-registry.json");
  try {
    const state = parseRegistryState(JSON.parse(await readFile(registryPath, "utf8")) as unknown);
    const registration = state.sources.find(
      (source) =>
        source.id === sourceId &&
        source.archivedAt === undefined &&
        (ownership === undefined || source.ownership === ownership),
    );
    if (!registration) return undefined;
    assertWorkshopTarget(registration);
    const root = await realpath(registration.locator.canonicalPath);
    return { id: registration.id, name: registration.displayName, root };
  } catch (error: unknown) {
    if (error instanceof StorefrontTargetError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("The source registration is unavailable.");
  }
}

export async function readActiveWorkshop(userDataPath: string): Promise<PersonalMarketplace | undefined> {
  const registryPath = join(resolve(userDataPath), "omni", "project-source-registry.json");
  try {
    const state = parseRegistryState(JSON.parse(await readFile(registryPath, "utf8")) as unknown);
    const registration = activeWorkshop(state);
    if (!registration && activeStorefronts(state).length) throw new StorefrontTargetError();
    if (!registration) return undefined;
    assertWorkshopTarget(registration);
    const root = await realpath(registration.locator.canonicalPath);
    return { id: registration.id, name: registration.displayName, root };
  } catch (error: unknown) {
    if (error instanceof StorefrontTargetError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("The personal marketplace registration is unavailable.");
  }
}

export async function readRegisteredEntryName(
  userDataPath: string,
  kind: "project" | "source",
  id: string,
): Promise<string | undefined> {
  const registryPath = join(resolve(userDataPath), "omni", "project-source-registry.json");
  try {
    const state = parseRegistryState(JSON.parse(await readFile(registryPath, "utf8")) as unknown);
    const records = kind === "project" ? state.projects : state.sources;
    return records.find((record) => record.id === id)?.displayName;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("The registry entry is unavailable.");
  }
}

export async function operationPaths(userDataPath: string, storePath: string): Promise<PathsResponse> {
  const marketplace = await readActiveWorkshop(userDataPath).catch((error: unknown) => {
    if (error instanceof StorefrontTargetError) return undefined;
    throw error;
  });
  return {
    ...(marketplace ? { marketplace: { displayRoot: displayRoot(marketplace.root) } } : {}),
    store: { displayRoot: displayRoot(storePath) },
  };
}
