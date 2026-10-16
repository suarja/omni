import { createArtifactIdentity, deriveIdentityFindings } from "../../domain/identity";
import type { Observation } from "../../domain/project-source-registry";
import type { ObservedArtifact, ObservedPackage } from "../../domain/inventory";
import type { AgentFindSkillResponse } from "../../shared/agents-ipc";
import type { RegistryIpcServices } from "../registry-ipc";
import { hashGrantedPath } from "../granted-hashing";
import { fail, keys, object, text } from "./router-inputs";
import { readRegisteredRoots } from "./router-observations";

function packageFor(observation: Observation, artifact: ObservedArtifact): ObservedPackage | undefined {
  return observation.inventory.packages?.find((item) => item.id === artifact.packageId);
}
export function createFindSkillReader(
  services: RegistryIpcServices,
): (params: unknown) => Promise<AgentFindSkillResponse> {
  return async (params: unknown): Promise<AgentFindSkillResponse> => {
    const request = object(params, "find_skill parameters");
    keys(request, ["query"], "find_skill parameters");
    const query = text(request.query, "Skill query").toLowerCase();
    const loaded = await services.listRegistry();
    if (loaded.status !== "ready") throw fail("The registry is unavailable.");
    const registry = loaded.registry;
    const { observations, unreadRoots } = await readRegisteredRoots(
      services,
      [...registry.sources, ...registry.projects].filter((entry) => entry.archivedAt === undefined),
    );
    const matches = observations.flatMap(({ entry, observation }) =>
      observation.inventory.artifacts
        .filter((artifact) => {
          const packageInfo = packageFor(observation, artifact);
          return [
            artifact.relativePath,
            artifact.displayPath,
            artifact.summary ?? "",
            packageInfo?.displayName ?? "",
            packageInfo?.description ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(query);
        })
        .map((artifact) => {
          const packageInfo = packageFor(observation, artifact);
          return {
            root: entry.ref,
            ...(artifact.packageId ? { packageId: artifact.packageId } : {}),
            artifact: {
              id: artifact.id,
              kind: artifact.kind,
              relativePath: artifact.relativePath,
              displayPath: artifact.displayPath,
              ...(artifact.summary ? { summary: artifact.summary } : {}),
            },
            ...(packageInfo
              ? {
                  package: {
                    id: packageInfo.id,
                    displayName: packageInfo.displayName,
                    ...(packageInfo.description ? { description: packageInfo.description } : {}),
                    ...(packageInfo.version ? { version: packageInfo.version } : {}),
                  },
                }
              : {}),
          };
        }),
    );
    const identities = (
      await Promise.all(
        observations.flatMap(({ entry, observation }) => {
          const grantPromise = services.getGrantForEntry(entry.ref);
          return observation.inventory.artifacts.map(async (artifact) => {
            const grantHandle = await grantPromise;
            const grant = grantHandle ? services.get(grantHandle) : undefined;
            if (!grant) return undefined;
            const hashed = await hashGrantedPath(grant, artifact.relativePath);
            return hashed.status === "hashed"
              ? createArtifactIdentity({
                  artifactId: artifact.id,
                  contentHash: hashed.contentHash,
                  byteLength: hashed.byteLength,
                  kind: artifact.kind,
                  root: entry.ref,
                  relativePath: artifact.relativePath,
                  package: packageFor(observation, artifact),
                })
              : undefined;
          });
        }),
      )
    ).flatMap((identity) => (identity ? [identity] : []));
    const packages = observations.flatMap(({ observation }) => observation.inventory.packages ?? []);
    const findings = deriveIdentityFindings(
      identities,
      packages,
      observations.flatMap(({ observation }) => observation.inventory.diagnostics),
    );
    return {
      status: unreadRoots.length ? "partial" : "ready",
      unreadRoots,
      matches,
      identityFindings: findings.map((finding) => ({
        kind: finding.kind,
        roots: finding.roots,
        examples: finding.examples,
      })),
    };
  };
}
