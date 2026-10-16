import { parsePluginDescription } from "./plugin-description-ipc";
import type { HarnessId } from "../domain/harness-targets";
import { assertKeys, assertRecord, readOpaque, readText } from "./operations-ipc-parser-utils";

type AddToProjectBase = Readonly<{
  kind: "add-to-project";
  entry: Readonly<{ ownerRepo: string; skill: string }>;
  projectId: string;
  grantHandle: string;
  harnessIds: readonly HarnessId[];
}>;
export type AddToProjectRequest =
  | (AddToProjectBase & Readonly<{ packageId: string }>)
  | (AddToProjectBase & Readonly<{ newPackageName: string; description: string }>);

const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

function readOwnerRepo(value: unknown): string {
  const ownerRepo = readText(value, "Catalogue owner/repo");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(ownerRepo))
    throw new Error("Catalogue owner/repo is malformed.");
  return ownerRepo;
}

function readSkill(value: unknown): string {
  const skill = readText(value, "Catalogue skill");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(skill)) throw new Error("Catalogue skill is malformed.");
  return skill;
}

function readHarnessIds(value: unknown): readonly HarnessId[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("At least one harness is required.");
  const harnessIds = value.map((item) => {
    if (!HARNESSES.includes(item as HarnessId)) throw new Error("Harness id is invalid.");
    return item as HarnessId;
  });
  if (new Set(harnessIds).size !== harnessIds.length) throw new Error("Harness ids must be unique.");
  return harnessIds;
}

function readPackageId(value: unknown): string {
  const packageId = readText(value, "Package path").replaceAll("\\", "/");
  if (packageId.startsWith("/") || /^[A-Za-z]:\//u.test(packageId)) throw new Error("Package path must be relative.");
  if (packageId.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Package path must be safe.");
  return packageId;
}

export function parseAddToProjectRequest(value: unknown): AddToProjectRequest {
  const request = assertRecord(value, "Add-to-project request");
  assertKeys(
    request,
    ["kind", "entry", "projectId", "grantHandle", "packageId", "newPackageName", "description", "harnessIds"],
    "Add-to-project request",
  );
  if (request.kind !== "add-to-project") throw new Error("Operation kind is invalid.");
  const entry = assertRecord(request.entry, "Catalogue entry");
  assertKeys(entry, ["ownerRepo", "skill"], "Catalogue entry");
  const hasPackage = request.packageId !== undefined;
  const hasNewPackage = request.newPackageName !== undefined;
  if (hasPackage === hasNewPackage) throw new Error("Choose exactly one package destination.");
  if (hasPackage && request.description !== undefined)
    throw new Error("Existing package targets cannot set a description.");
  const base = {
    kind: "add-to-project",
    entry: { ownerRepo: readOwnerRepo(entry.ownerRepo), skill: readSkill(entry.skill) },
    projectId: readOpaque(request.projectId, "Project id"),
    grantHandle: readOpaque(request.grantHandle, "Grant handle"),
    harnessIds: readHarnessIds(request.harnessIds),
  } as const;
  return hasPackage
    ? { ...base, packageId: readPackageId(request.packageId) }
    : {
        ...base,
        newPackageName: readText(request.newPackageName, "New package name"),
        description: parsePluginDescription(request.description),
      };
}
