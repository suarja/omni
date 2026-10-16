import type { PackageRequestBlock } from "./package-resolution";
import type { AgentClient } from "./server";
import { parseAgentWriteRequest, type AgentWriteRequest } from "../../shared/agents-ipc";
import type { SourceSkillRef, SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { SkillPropagationCandidate } from "../../shared/skill-propagation-ipc";
import {
  fail,
  id,
  keys,
  object,
  optionalBoolean,
  path,
  skillBody,
  skillFiles,
  skillFolderName,
  text,
} from "./router-inputs";

type Preview = (
  request: AgentWriteRequest,
  client: AgentClient,
  askInOmni?: boolean,
) => Promise<Readonly<Record<string, unknown>>>;

type ResolveRequest = (
  request: AgentWriteRequest,
) => Promise<Readonly<{ status: "resolved"; request: AgentWriteRequest }> | PackageRequestBlock>;

type ReadCandidates = (source: SourceSkillRef) => Promise<readonly SkillPropagationCandidate[]>;

async function resolveProjectLocations(
  source: SourceSkillRef,
  projectIds: unknown,
  readCandidates?: ReadCandidates,
): Promise<readonly SkillLocationKey[] | undefined> {
  if (projectIds === undefined) return undefined;
  if (!Array.isArray(projectIds) || !projectIds.length || projectIds.length > 64)
    throw fail("Skill synchronization projects are invalid.");
  const ids = projectIds.map((value) => id(value, "Project id"));
  if (new Set(ids).size !== ids.length) throw fail("Skill synchronization projects must be unique.");
  if (!readCandidates) throw fail("Linked copies are unavailable. Refresh the source before synchronizing.");
  const candidates = await readCandidates(source);
  const locations = candidates
    .flatMap((candidate) => candidate.locations)
    .filter((location) => ids.includes(location.projectId));
  if (ids.some((projectId) => !locations.some((location) => location.projectId === projectId)))
    throw fail(
      "A selected project has no managed linked copy of this source. Refresh the source and select a linked project.",
    );
  return locations;
}

export async function previewSkill(
  method: string,
  params: unknown,
  client: AgentClient,
  preview: Preview,
  readCandidates?: ReadCandidates,
  resolveSource?: (
    source: SourceSkillRef,
  ) => Promise<Readonly<{ status: "resolved"; source: SourceSkillRef }> | PackageRequestBlock>,
  resolveRequest?: ResolveRequest,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (method === "preview_sync_skill") {
    const value = object(params, method);
    keys(value, ["sourceId", "packageId", "artifactPath", "projectIds", "askInOmni"], method);
    let source = {
      sourceId: id(value.sourceId, "Source id"),
      packageId: path(value.packageId, "Package id"),
      artifactPath: path(value.artifactPath, "Artifact path"),
    };
    if (resolveSource) {
      const resolved = await resolveSource(source);
      if (resolved.status === "blocked") return resolved;
      source = resolved.source;
    }
    const locations = await resolveProjectLocations(source, value.projectIds, readCandidates);
    return preview(
      parseAgentWriteRequest({ kind: "maintain-current", source, ...(locations === undefined ? {} : { locations }) }),
      client,
      optionalBoolean(value.askInOmni, "askInOmni"),
    );
  }
  if (method === "preview_update_and_maintain_skill") {
    const value = object(params, method);
    keys(value, ["source", "request", "locations", "askInOmni"], method);
    let source = value.source;
    let write = value.request;
    if (resolveSource && resolveRequest) {
      const input = object(source, "Skill source");
      keys(input, ["sourceId", "packageId", "artifactPath"], "Skill source");
      const resolvedSource = await resolveSource({
        sourceId: id(input.sourceId, "Source id"),
        packageId: path(input.packageId, "Package id"),
        artifactPath: path(input.artifactPath, "Artifact path"),
      });
      if (resolvedSource.status === "blocked") return resolvedSource;
      const resolvedWrite = await resolveRequest(parseAgentWriteRequest(write));
      if (resolvedWrite.status === "blocked") return resolvedWrite;
      source = resolvedSource.source;
      write = resolvedWrite.request;
    }
    const request = parseAgentWriteRequest({
      kind: "update-and-maintain",
      source,
      request: write,
      ...(value.locations === undefined ? {} : { locations: value.locations }),
    });
    return preview(request, client, optionalBoolean(value.askInOmni, "askInOmni"));
  }
  if (method === "preview_maintain_current_skill") {
    const value = object(params, method);
    keys(value, ["source", "locations", "retryOf", "askInOmni"], method);
    const request = parseAgentWriteRequest({
      kind: "maintain-current",
      source: value.source,
      ...(value.locations === undefined ? {} : { locations: value.locations }),
      ...(value.retryOf === undefined ? {} : { retryOf: value.retryOf }),
    });
    return preview(request, client, optionalBoolean(value.askInOmni, "askInOmni"));
  }
  if (method !== "preview_create_skill" && method !== "preview_update_skill") return undefined;
  const value = object(params, method);
  if (method === "preview_create_skill") {
    keys(
      value,
      ["sourceId", "packageId", "newPackage", "name", "description", "body", "files", "reason", "askInOmni"],
      method,
    );
    const extraFiles = value.files === undefined ? [] : skillFiles(value.files, method);
    return preview(
      parseAgentWriteRequest({
        kind: "write-skill",
        sourceId: value.sourceId,
        ...(value.newPackage === undefined
          ? { packageId: value.packageId }
          : { newPackage: value.newPackage, ...(value.packageId === undefined ? {} : { packageId: value.packageId }) }),
        mode: "create",
        folderName: value.name,
        files: [
          {
            path: "SKILL.md",
            // Double-quoted YAML scalars: a description with ": " or a "#" stays valid frontmatter.
            content: `---\nname: ${JSON.stringify(text(value.name, "Skill name", 64))}\ndescription: ${JSON.stringify(text(value.description, "Skill description", 1024))}\n---\n\n${skillBody(value.body)}`,
          },
          ...extraFiles,
        ],
        ...(value.reason === undefined ? {} : { reason: text(value.reason, "Reason", 1024) }),
      }),
      client,
      optionalBoolean(value.askInOmni, "askInOmni"),
    );
  }
  keys(
    value,
    [
      "sourceId",
      "packageId",
      "folderName",
      "assetId",
      "body",
      "files",
      "replaceFolder",
      "reason",
      "sourceOnly",
      "askInOmni",
    ],
    method,
  );
  const folderName = value.folderName ?? skillFolderName(value.assetId);
  const files =
    value.files === undefined
      ? [{ path: "SKILL.md", content: skillBody(value.body) }]
      : skillFiles(value.files, method);
  const request = parseAgentWriteRequest({
    kind: "write-skill",
    sourceId: value.sourceId,
    packageId: value.packageId,
    mode: "update",
    folderName,
    files,
    ...(value.replaceFolder === undefined ? {} : { replaceFolder: value.replaceFolder }),
    ...(value.reason === undefined ? {} : { reason: text(value.reason, "Reason", 1024) }),
  });
  const sourceOnly = optionalBoolean(value.sourceOnly, "sourceOnly");
  const intent = sourceOnly
    ? request
    : parseAgentWriteRequest({
        kind: "update-and-maintain",
        source: { sourceId: value.sourceId, packageId: value.packageId, artifactPath: `skills/${folderName}` },
        request,
      });
  return preview(intent, client, optionalBoolean(value.askInOmni, "askInOmni"));
}
