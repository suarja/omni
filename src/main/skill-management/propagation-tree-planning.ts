import { createHash } from "node:crypto";

import type { SkillRevision } from "../../domain/skill-reconciliation/types";
import type { SkillPropagationTarget } from "../../shared/skill-propagation-ipc";

type Tree = Readonly<{ revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function summarizePropagationFiles(source: Tree, local: Tree): SkillPropagationTarget["files"] {
  const paths = new Set([...source.files.keys(), ...local.files.keys()]);
  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => {
      const sourceBytes = source.files.get(path);
      const localBytes = local.files.get(path);
      if (sourceBytes && localBytes && Buffer.from(sourceBytes).equals(Buffer.from(localBytes))) {
        return {
          path,
          state: "unchanged" as const,
          byteLength: sourceBytes.byteLength,
          beforeHash: sha256(localBytes),
          afterHash: sha256(sourceBytes),
        };
      }
      if (!sourceBytes)
        return {
          path,
          state: "delete" as const,
          byteLength: localBytes?.byteLength,
          beforeHash: localBytes ? sha256(localBytes) : undefined,
        };
      return {
        path,
        state: localBytes ? ("change" as const) : ("add" as const),
        byteLength: sourceBytes.byteLength,
        ...(localBytes ? { beforeHash: sha256(localBytes) } : {}),
        afterHash: sha256(sourceBytes),
      };
    });
}
