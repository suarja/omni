import { z } from "zod";

const schema = z
  .object({
    projectId: z.string().min(1).max(128),
    rowId: z.string().min(1).max(128),
    action: z.enum(["disable", "enable", "delete", "install-agent", "remove-agent", "restore"]),
    origin: z.enum(["mine", "external", "project-only"]),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ProjectSkillEvidence = z.infer<typeof schema>;
export function parseProjectSkillEvidence(value: unknown): ProjectSkillEvidence {
  return schema.parse(value);
}
