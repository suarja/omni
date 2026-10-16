import { agentHomeDir } from "./agent-harnesses";
import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { parseRegistryState } from "../domain/project-source-registry";
import type { ReceiptDiffResponse, OperationReceipt } from "../shared/operations-ipc";
import { parseReceiptDiffRequest } from "../shared/operations-receipt-parsers";
import { createUnifiedDiff } from "../domain/unified-diff";
import { hashContent } from "./marketplace-manifests";
import { isMissing } from "./fs-optional";
import { readRegularFile } from "./operation-files";
import { readActiveWorkshop, readRegisteredSource } from "./operations-paths";
import type { OperationStore } from "./operation-store";

export type ReceiptRootOptions = Readonly<{ userDataPath: string; homeDir?: string; isPackaged?: boolean }>;
type ReceiptDiffOptions = ReceiptRootOptions & Readonly<{ operationStore: OperationStore }>;

export async function receiptRoot(receipt: OperationReceipt, options: ReceiptRootOptions): Promise<string | undefined> {
  const home = agentHomeDir(options);
  if (receipt.kind === "install-agents" || receipt.kind === "disconnect-agents" || receipt.kind === "register-mcp")
    return home;
  if (receipt.project) {
    try {
      const state = parseRegistryState(
        JSON.parse(
          await readFile(join(options.userDataPath, "omni", "project-source-registry.json"), "utf8"),
        ) as unknown,
      );
      const project = state.projects.find((candidate) => candidate.id === receipt.project?.id && !candidate.archivedAt);
      return project ? await realpath(project.locator.canonicalPath) : undefined;
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  const marketplace = receipt.registered
    ? await readRegisteredSource(options.userDataPath, receipt.registered.sourceId)
    : await readActiveWorkshop(options.userDataPath);
  return marketplace?.root;
}

function fileEntry(
  receipt: OperationReceipt,
  relativePath: string,
): NonNullable<OperationReceipt["files"]>[number] | undefined {
  return receipt.files?.find((file) => file.relativePath === relativePath);
}

function actionEntry(receipt: OperationReceipt, relativePath: string): OperationReceipt["actions"][number] | undefined {
  return receipt.actions.find((action) => action.relativePath === relativePath);
}

function receiptPath(receipt: OperationReceipt, relativePath: string): string {
  return receipt.kind === "install-agents" || receipt.kind === "disconnect-agents" || receipt.kind === "register-mcp"
    ? relativePath.replace(/^~\//u, "")
    : relativePath;
}

async function backupContent(
  receipt: OperationReceipt,
  options: ReceiptDiffOptions,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  const backupRelativePath = receiptPath(receipt, relativePath);
  const path = join(options.userDataPath, "omni", "backups", receipt.operationId, backupRelativePath);
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (!receipt.project) return undefined;
    try {
      return await readFile(
        join(options.userDataPath, "omni", "backups", receipt.operationId, receipt.project.id, backupRelativePath),
      );
    } catch (fallbackError: unknown) {
      if (isMissing(fallbackError)) return undefined;
      throw fallbackError;
    }
  }
}

export function createReceiptDiffOperations(options: ReceiptDiffOptions): Readonly<{
  get(raw: unknown): Promise<ReceiptDiffResponse>;
}> {
  const get = async (raw: unknown): Promise<ReceiptDiffResponse> => {
    const request = parseReceiptDiffRequest(raw);
    const loaded = await options.operationStore.read();
    if (loaded.status !== "ready") return { status: "unavailable", reason: loaded.diagnostic };
    const receipt = loaded.receipts.find((candidate) => candidate.operationId === request.operationId);
    if (!receipt) return { status: "unavailable", reason: "The operation receipt is unavailable." };
    const allowed = new Set([
      ...receipt.actions.map((action) => action.relativePath),
      ...(receipt.files ?? []).map((file) => file.relativePath),
      ...(receipt.manifests ?? []).map((manifest) => manifest.relativePath),
    ]);
    if (!allowed.has(request.relativePath)) throw new Error("Receipt path is not part of the operation.");
    const action = actionEntry(receipt, request.relativePath);
    const file = fileEntry(receipt, request.relativePath);
    const before = await backupContent(receipt, options, request.relativePath);
    if (!before && file && action?.beforeHash)
      return { status: "unavailable", reason: "The operation backup is unavailable." };
    // The hash Omni verified right after writing: skills/files carry contentHash, settings files afterHash.
    const writtenHash =
      file?.contentHash ??
      receipt.manifests?.find((manifest) => receiptPath(receipt, manifest.relativePath) === request.relativePath)
        ?.afterHash;
    const root = await receiptRoot(receipt, options);
    const after = root ? await readRegularFile(root, receiptPath(receipt, request.relativePath)) : undefined;
    if (!before && !file && !after) return { status: "unavailable", reason: "The operation backup is unavailable." };
    const beforeContent = before ?? new Uint8Array();
    const diff = createUnifiedDiff(
      request.relativePath,
      request.relativePath,
      beforeContent,
      after ?? new Uint8Array(),
    );
    return {
      status: "ready",
      diff,
      before: { byteLength: beforeContent.byteLength },
      ...(after
        ? {
            after: {
              byteLength: after.byteLength,
              changedSince: writtenHash !== undefined && hashContent(after) !== writtenHash,
            },
          }
        : {}),
    };
  };
  return { get };
}
