import { z } from "zod";
const schema = z
  .object({
    source: z
      .string()
      .min(3)
      .max(201)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
    ref: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
      .optional(),
    skillPath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !/[\u0000-\u001f\u007f-\u009f]/u.test(path) &&
          !/^[A-Za-z]:/u.test(path) &&
          path.split("/").every((part) => part && part !== "." && part !== ".."),
      )
      .optional(),
    computedHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type SkillCopyProvenance = z.infer<typeof schema>;
export function parseSkillCopyProvenance(value: unknown): SkillCopyProvenance {
  return schema.parse(value);
}
