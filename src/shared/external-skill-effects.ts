import { z } from "zod";
import { publicationPathSchema } from "../domain/publications";

export const externalOperationKindSchema = z.enum([
  "install-external-skill",
  "update-external-skills",
  "merge-external-skill",
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const layout = z
  .object({
    path: publicationPathSchema.refine((path) => /^\.(?:agents|claude|codex)\/skills\/[^/]+$/u.test(path)),
    harnessId: z.enum(["codex", "claude-code"]),
    beforeHash: hash.optional(),
    afterHash: hash.optional(),
  })
  .strict();
export const externalSkillEvidenceSchema = z
  .object({
    kind: externalOperationKindSchema,
    projectId: id,
    sourceId: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u),
    device: z.string().regex(/^\d+$/u),
    inode: z.string().regex(/^\d+$/u),
    backupPath: publicationPathSchema.refine((path) =>
      /^omni\/backups\/external-skills\/[^/]+\/[^/]+\.json$/u.test(path),
    ),
    backupHash: hash,
    direction: z.enum(["forward", "restore"]),
    restores: id.optional(),
    layouts: z
      .array(layout)
      .min(1)
      .max(10000)
      .refine((items) => new Set(items.map((item) => item.path)).size === items.length),
    beforeLockHash: hash.optional(),
    afterLockHash: hash.optional(),
    copies: z.number().int().min(1).max(10000),
    refusal: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ExternalSkillEvidence = z.infer<typeof externalSkillEvidenceSchema>;
export function parseExternalSkillEvidence(value: unknown): ExternalSkillEvidence {
  return externalSkillEvidenceSchema.parse(value);
}
