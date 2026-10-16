import { receiptDiagnostic } from "./operation-diagnostics";
import { randomUUID } from "node:crypto";
import type { SkillManagementService } from "../application/skill-management";
import type { SkillLocationKey } from "../domain/skill-reconciliation/types";
import type { ImportArtifactRequest } from "../shared/operations-import-ipc";
import { parsePreviewImportRequest } from "../shared/operations-import-ipc";
import {
  parseApplyOperationRequest,
  type ApplyOperationResponse,
  type PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import type { RegistryIpcServices } from "./registry-ipc";
import type { OperationStore } from "./operation-store";
import type { SkillRelationshipStore } from "../ports/skill-reconciliation";
import type { SkillBaseStore } from "./skill-reconciliation/bases";
import type { createImportOperations } from "./operations-import";
import { observeProjectCopies } from "./skill-reconciliation/ipc";
import { block } from "./operations-import-plan";

type Link = Readonly<{ skillId: string; locations: readonly SkillLocationKey[] }>;
type Options = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bases: SkillBaseStore;
  service: SkillManagementService;
  imports: ReturnType<typeof createImportOperations>;
  store: OperationStore;
  now: () => number;
}>;

async function captureLink(request: ImportArtifactRequest, options: Options): Promise<Link | undefined> {
  if (request.source.kind !== "project" || !request.relativePath.match(/(?:^|\/)skills\/[^/]+(?:\/SKILL\.md)?$/u))
    return undefined;
  const folder = request.relativePath.replace(/\/SKILL\.md$/u, "");
  const view = await options.service.readProjectSkills!(request.source.id);
  const row = view.skills.find((row) => Object.values(row.agents).some((agent) => agent.folderPath === folder));
  if (!row || row.origin.kind !== "project-only") return undefined;
  const observed = await options.registry.observeEntryWithGrant(request.source, request.source.grantHandle);
  if (observed.status !== "observed") throw new Error("The project copy cannot be observed. Refresh before capture.");
  const folders = Object.values(row.agents)
    .filter((agent) => agent.state === "installed")
    .map((agent) => agent.folderPath);
  const members = observed.observation.inventory.artifacts
    .filter(
      (artifact) => artifact.kind === "skill" && folders.some((path) => artifact.relativePath === `${path}/SKILL.md`),
    )
    .map((artifact) => ({
      ref: {
        kind: "artifact" as const,
        entry: { kind: "project" as const, id: request.source.id },
        artifactId: artifact.id,
      },
      relativePath: artifact.relativePath,
    }));
  const copies = await observeProjectCopies(
    { projectId: request.source.id, grantHandle: request.source.grantHandle, groups: [{ groupId: row.id, members }] },
    options.registry,
    options.relationships,
    options.bases,
    options.now,
  );
  if (copies.status !== "ready")
    throw new Error("The complete project skill cannot be observed. Refresh before capture.");
  const group = copies.groups
    .flatMap((group) => group.correlation.groups)
    .find((group) => group.locations.some((copy) => copy.location.folderPath === folder));
  if (!group) throw new Error("The project copy identity is unavailable. Refresh before capture.");
  return { skillId: group.skillId, locations: group.locations.map((copy) => copy.location) };
}

export function createProjectCaptureOperations(options: Options): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const links = new Map<string, Link>();
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewImportRequest(raw);
    const preview = await options.imports.preview(request);
    if (preview.status !== "ready") return preview;
    try {
      const link = await captureLink(request, options);
      if (link) links.set(preview.plan.planId, link);
      return preview;
    } catch (error) {
      return block(
        "capture-link-unavailable",
        receiptDiagnostic(error, "The project link cannot be prepared safely. Refresh the project and preview again."),
      );
    }
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw),
      link = links.get(request.planId);
    links.delete(request.planId);
    const imported = await options.imports.apply(request);
    if (!link || !imported || imported.status !== "applied") return imported;
    let linkOperation: string | undefined, diagnostic: string | undefined;
    try {
      const artifactPath = imported.receipt.files
        ?.find((file) => file.relativePath.endsWith("/SKILL.md"))
        ?.relativePath.slice(imported.receipt.displayTarget.length + 1)
        .replace(/\/SKILL\.md$/u, "");
      if (!artifactPath || !imported.receipt.registered) throw new Error("The captured skill receipt is incomplete.");
      const preview = await options.service.preview(
        {
          kind: "reconcile",
          request: {
            choice: "adopt-exact",
            ...link,
            source: {
              sourceId: imported.receipt.registered.sourceId,
              packageId: imported.receipt.displayTarget,
              artifactPath,
            },
          },
        },
        { kind: "desktop" },
      );
      if (preview.status !== "ready") throw new Error(preview.reason);
      const result = await options.service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: new Date(options.now()).toISOString(),
      });
      linkOperation = result.operationId;
      if (result.status !== "applied" && result.status !== "no-op")
        throw new Error(result.issues.map((issue) => issue.message).join("\n") || "Project linking did not complete.");
    } catch (error) {
      diagnostic = `The marketplace copy was saved, but its project link did not complete. ${receiptDiagnostic(error, "Refresh and inspect the operation before restoring it.")}`;
    }
    const receipt = {
      ...imported.receipt,
      operationId: randomUUID(),
      status: diagnostic ? ("failed" as const) : ("applied" as const),
      children: [imported.receipt.operationId, ...(linkOperation ? [linkOperation] : [])],
      ...(diagnostic ? { diagnostic } : {}),
    };
    const persisted = await options.store.append(receipt);
    if (persisted.status !== "ready")
      throw new Error(
        "The capture result could not be saved. Preserve the import and project-link receipts before recovery.",
      );
    return { status: receipt.status, receipt };
  };
  return { preview, apply };
}
