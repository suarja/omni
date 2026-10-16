import { z } from "zod";
import { createHash } from "node:crypto";
import type { RegistryIpcServices } from "../registry-ipc";
import type { OperationStore } from "../operation-store";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { ExternalLibraryService } from "./service";
import type { FileWriter } from "../operation-files";
import { exactSkillTreeSchema, hashProjectSkillValue } from "../skill-management/project-skill-files";
import { externalSkillEvidenceSchema } from "../../shared/external-skill-effects";
import { publicationPathSchema } from "../../domain/publications";

export type ExternalOperationDependencies = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  library: ExternalLibraryService;
  operationStore: OperationStore;
  journal: SkillOperationJournal;
  now?: () => number;
  fileWriter?: FileWriter;
}>;
export const externalBackupSchema = z
  .object({
    evidence: externalSkillEvidenceSchema,
    sources: z
      .array(z.object({ path: publicationPathSchema, hash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict())
      .max(10000),
    sourceHead: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/u)
      .optional(),
    licence: z.enum(["MIT", "Apache-2.0", "other", "none"]).optional(),
    layouts: z
      .array(
        z
          .object({
            path: publicationPathSchema,
            harnessId: z.enum(["codex", "claude-code"]),
            before: exactSkillTreeSchema.optional(),
            after: exactSkillTreeSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    lockBefore: z
      .string()
      .max(1024 * 1024)
      .optional(),
    lockAfter: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
export type ExternalBackup = z.infer<typeof externalBackupSchema>;
export type ExternalTargetPlan = Readonly<{ backup: ExternalBackup; bytes: string }>;
export function hashExternalBytes(bytes: string | Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}
// The content digest excludes its own field; every other backup byte remains covered.
export function serializeExternalBackup(backup: ExternalBackup): ExternalTargetPlan {
  const unsigned = { ...backup, evidence: { ...backup.evidence, backupHash: "0".repeat(64) } };
  const hash = hashProjectSkillValue(unsigned);
  const signed = { ...backup, evidence: { ...backup.evidence, backupHash: hash } };
  return { backup: signed, bytes: JSON.stringify(signed) };
}
