import { z } from "zod";
import { parseExternalRepository } from "../domain/external-library";
import { publicationPathSchema } from "../domain/publications";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const sourceId = z.string().transform((value, context) => {
  try {
    return parseExternalRepository(value);
  } catch {
    context.addIssue({ code: "custom", message: "External repository is invalid." });
    return z.NEVER;
  }
});
const unique = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .array(schema)
    .min(1)
    .max(10000)
    .refine(
      (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
      "Duplicate selections.",
    );
export const externalInstallSchema = z
  .object({
    kind: z.literal("install-external-skill"),
    sourceId,
    skillPath: publicationPathSchema,
    skillName: z
      .string()
      .refine(
        (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name) || name === "__proto__",
        "Skill name is unsafe.",
      ),
    targets: unique(z.object({ projectId: id, harnessIds: unique(z.enum(["codex", "claude-code"])) }).strict()).refine(
      (targets) => new Set(targets.map((target) => target.projectId)).size === targets.length,
    ),
    conflict: z.enum(["refuse", "replace"]),
  })
  .strict();
const update = z.object({ kind: z.literal("update-external-skills"), sourceId, useIds: unique(id) }).strict();
const merge = z
  .object({
    kind: z.literal("merge-external-skill"),
    sourceId,
    useId: id,
    choices: z
      .array(z.object({ path: publicationPathSchema, choice: z.enum(["mine", "source"]) }).strict())
      .max(512)
      .refine((choices) => new Set(choices.map((choice) => choice.path)).size === choices.length),
    wholeCopy: z.enum(["mine", "source"]).optional(),
  })
  .strict();
const schema = z.discriminatedUnion("kind", [externalInstallSchema, update, merge]);
export type ExternalSkillIntent = z.infer<typeof schema>;
export type ExternalInstallIntent = z.infer<typeof externalInstallSchema>;
export function parseExternalSkillIntent(value: unknown): ExternalSkillIntent {
  return schema.parse(value);
}
export function isExternalSkillIntent(value: { kind: string }): value is ExternalSkillIntent {
  return ["install-external-skill", "update-external-skills", "merge-external-skill"].includes(value.kind);
}
