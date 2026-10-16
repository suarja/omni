import { stat } from "node:fs/promises";

import { ipcMain } from "electron";

import { createArtifactIdentity } from "../domain/identity";
import type { InventoryArtifactKind, ObservedPackage } from "../domain/inventory";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { currentGrantRoot, hashGrantedPath, resolveGrantedPath } from "./granted-hashing";
import {
  IDENTITY_IPC_CHANNELS,
  parseHashArtifactsRequest,
  type HashArtifactsResponse,
  type HashArtifactRequest,
} from "../shared/identity-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type HashResult = Awaited<ReturnType<typeof hashGrantedPath>>;
const MANIFESTS = [
  "omni.plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
] as const;

function sameSubject(request: { kind: string; id: string }, grant: RegistryGrant): boolean {
  return request.kind === grant.subject.kind && request.id === grant.subject.id;
}

async function packageForPath(grant: RegistryGrant, relativePath: string): Promise<ObservedPackage | undefined> {
  const parts = relativePath.split("/");
  for (let length = Math.max(0, parts.length - 1); length >= 0; length -= 1) {
    const root = parts.slice(0, length).join("/");
    for (const manifest of MANIFESTS) {
      const manifestPath = root ? `${root}/${manifest}` : manifest;
      const location = await resolveGrantedPath(grant, manifestPath);
      if (location === "denied" || location === "unavailable") continue;
      const details = await stat(location).catch(() => undefined);
      if (!details?.isFile()) continue;
      return {
        id: root || "root",
        relativeRoot: root || "root",
        displayName: root.split("/").at(-1) ?? "root",
        format:
          manifest === "omni.plugin.json"
            ? "omni"
            : manifest.startsWith(".claude")
              ? "claude-plugin"
              : manifest.startsWith(".codex")
                ? "codex-plugin"
                : "cursor-plugin",
        manifestPaths: [manifestPath],
        artifactIds: [],
      };
    }
  }
  return undefined;
}

async function hashRequestedArtifact(grant: RegistryGrant, artifact: HashArtifactRequest): Promise<HashResult> {
  return hashGrantedPath(grant, artifact.relativePath);
}

function skipReason(status: Exclude<HashResult["status"], "hashed">): "too-large" | "unavailable" | "denied" {
  return status;
}

async function hashGrantedArtifacts(
  request: ReturnType<typeof parseHashArtifactsRequest>,
  grants: RegistryGrantStore,
): Promise<HashArtifactsResponse> {
  const grant = grants.get(request.grantHandle);
  if (!grant || !sameSubject(request, grant) || !(await currentGrantRoot(grant))) return { status: "denied" };
  const identities = [] as NonNullable<
    Extract<HashArtifactsResponse, { status: "hashed" }>["identities"]
  > extends readonly (infer T)[]
    ? T[]
    : never[];
  const skipped: { artifactId: string; reason: "too-large" | "unavailable" | "denied" }[] = [];
  for (const artifact of request.artifacts) {
    const result = await hashRequestedArtifact(grant, artifact);
    if (result.status !== "hashed") {
      skipped.push({ artifactId: artifact.artifactId, reason: skipReason(result.status) });
      continue;
    }
    identities.push(
      createArtifactIdentity({
        artifactId: artifact.artifactId,
        contentHash: result.contentHash,
        byteLength: result.byteLength,
        kind: artifact.kind,
        root: grant.subject,
        relativePath: artifact.relativePath,
        package: await packageForPath(grant, artifact.relativePath),
      }),
    );
  }
  return {
    status: "hashed",
    subject: grant.subject,
    identities,
    skipped: skipped.sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  };
}

export function registerIdentityIpcHandlers(assertTrustedSender: SenderGuard, grants: RegistryGrantStore): void {
  ipcMain.handle(IDENTITY_IPC_CHANNELS.hashArtifacts, async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    try {
      return await hashGrantedArtifacts(parseHashArtifactsRequest(rawRequest), grants);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Identity request failed safely.";
      throw new Error(message.length <= 240 && !/[\r\n]/.test(message) ? message : "Identity request failed safely.");
    }
  });
}
