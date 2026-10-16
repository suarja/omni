import { createUnifiedDiff } from "../domain/unified-diff";
import type { OperationAction } from "../shared/operations-ipc";
import { hashContent } from "./marketplace-manifests";
import { readRegularFile } from "./operation-files";

type RestoreAction = OperationAction & Readonly<{ absolutePath: string; content?: string | Uint8Array }>;

function decodeUtf8(bytes: Uint8Array | string): string | undefined {
  if (typeof bytes === "string") return bytes;
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : undefined;
}

export async function describeRestoreFiles(root: string, actions: readonly RestoreAction[]): Promise<RestoreAction[]> {
  const described: RestoreAction[] = [];
  for (const action of actions) {
    if (action.kind !== "write-file" && action.kind !== "delete-file") {
      described.push(action);
      continue;
    }
    const before = await readRegularFile(root, action.relativePath);
    const after = action.kind === "write-file" ? action.content : undefined;
    const contentLength =
      after === undefined
        ? (before?.byteLength ?? 0)
        : typeof after === "string"
          ? Buffer.byteLength(after)
          : after.byteLength;
    const beforeText = before === undefined ? "" : decodeUtf8(before);
    const afterText = after === undefined ? "" : decodeUtf8(after);
    const diff =
      beforeText !== undefined && afterText !== undefined
        ? createUnifiedDiff(
            `${action.relativePath} (${before === undefined ? "absent" : "current"})`,
            `${action.relativePath} (${after === undefined ? "deleted" : "restored"})`,
            beforeText,
            afterText,
          ).text
        : `${action.relativePath}: binary content ${after === undefined ? "deleted" : "restored"} (${contentLength} bytes).`;
    described.push({
      ...action,
      byteLength: contentLength,
      ...(before === undefined ? {} : { beforeHash: hashContent(before) }),
      ...(after === undefined ? {} : { afterHash: hashContent(after) }),
      diff,
    });
  }
  return described;
}
