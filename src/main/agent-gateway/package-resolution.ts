import { activeWorkshop } from "../../domain/source-roles";
import { observationIssueForLocation, unscopedObservationIssue } from "../skill-reconciliation/location-observation";
import { resolveObservedPackage } from "../../domain/observed-package-resolution";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { AgentWriteRequest } from "../../shared/agents-ipc";
import type { RegistryIpcServices } from "../registry-ipc";

export type PackageRequestBlock = Readonly<{
  status: "blocked";
  reason: string;
  details: readonly Readonly<{ code: string; message: string; recoveryAction: "refresh" | "reconnect" }>[];
}>;

type PackageTarget = Readonly<{ sourceId: string; packageId: string }>;

function blocked(code: string, message: string, recoveryAction: "refresh" | "reconnect"): PackageRequestBlock {
  return { status: "blocked", reason: message, details: [{ code, message, recoveryAction }] };
}

async function resolveGatewayPackage(
  registry: RegistryIpcServices,
  target: PackageTarget,
): Promise<Readonly<{ status: "resolved"; packageId: string }> | PackageRequestBlock> {
  const observed = await registry.observeRegisteredEntry({ kind: "source", id: target.sourceId });
  if (observed.status !== "observed")
    return blocked(
      "source-observation-incomplete",
      `Source "${target.sourceId}" could not be observed. Reconnect it and retry.`,
      "reconnect",
    );
  const inventory = observed.observation.inventory;
  const result = resolveObservedPackage(inventory.packages ?? [], target.packageId);
  const possibleRoot = target.packageId.includes("/") ? target.packageId : `packages/${target.packageId}`;
  if (
    (unscopedObservationIssue(inventory) &&
      !(result.status === "resolved" && result.package.id === target.packageId)) ||
    (result.status === "blocked" && observationIssueForLocation(inventory, possibleRoot))
  )
    return blocked(
      "source-observation-incomplete",
      `Source "${target.sourceId}" could not be observed completely.`,
      "reconnect",
    );
  if (result.status === "blocked")
    return blocked(result.code, `Source "${target.sourceId}": ${result.message}`, "refresh");
  return { status: "resolved", packageId: result.package.id };
}

export async function resolveGatewayRequest(
  registry: RegistryIpcServices,
  request: AgentWriteRequest,
): Promise<Readonly<{ status: "resolved"; request: AgentWriteRequest }> | PackageRequestBlock> {
  if (request.kind === "import-artifact" && request.target.packageId !== undefined) {
    const listed = await registry.listRegistry();
    const source = listed.status === "ready" ? activeWorkshop(listed.registry) : undefined;
    if (!source)
      return blocked("source-unavailable", "Open the active workshop before capturing a skill.", "reconnect");
    const resolved = await resolveGatewayPackage(registry, {
      sourceId: source.ref.id,
      packageId: request.target.packageId,
    });
    if (resolved.status === "blocked") return resolved;
    return { status: "resolved", request: { ...request, target: { packageId: resolved.packageId } } };
  }
  if (request.kind === "maintain-current" || request.kind === "update-and-maintain") {
    const source = await resolveGatewayPackage(registry, request.source);
    if (source.status === "blocked") return source;
    if (request.kind === "maintain-current")
      return {
        status: "resolved",
        request: { ...request, source: { ...request.source, packageId: source.packageId } },
      };
    const write = await resolveGatewayRequest(registry, request.request);
    if (write.status === "blocked") return write;
    if (write.request.kind !== "write-skill") throw new Error("The resolved update request must write a skill.");
    return {
      status: "resolved",
      request: { ...request, source: { ...request.source, packageId: source.packageId }, request: write.request },
    };
  }
  if (
    (request.kind === "write-skill" && !request.newPackage) ||
    request.kind === "assign" ||
    (request.kind === "make-compatible" && request.packageId !== undefined)
  ) {
    const result = await resolveGatewayPackage(registry, { sourceId: request.sourceId, packageId: request.packageId! });
    if (result.status === "blocked") return result;
    return { status: "resolved", request: { ...request, packageId: result.packageId } };
  }
  return { status: "resolved", request };
}

export async function resolveGatewaySource(
  registry: RegistryIpcServices,
  source: SourceSkillRef,
): Promise<Readonly<{ status: "resolved"; source: SourceSkillRef }> | PackageRequestBlock> {
  const result = await resolveGatewayPackage(registry, source);
  return result.status === "blocked"
    ? result
    : { status: "resolved", source: { ...source, packageId: result.packageId } };
}
