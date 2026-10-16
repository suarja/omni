import { z } from "zod";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\//)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const registerProjectSchema = z
  .object({
    kind: z.literal("register-project"),
    cwd: absolutePath.optional(),
    path: absolutePath,
    reason: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type RegisterProjectRequest = z.infer<typeof registerProjectSchema>;
const registrationPlanSchema = z
  .object({
    cwd: absolutePath.optional(),
    path: absolutePath,
    gitRoot: z.boolean(),
    device: z.string(),
    inode: z.string(),
    action: z.enum(["register", "restore", "archive", "existing"]),
    projectId: z.string().min(1).max(128).optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectRegistrationPlan = z.infer<typeof registrationPlanSchema>;
export function parseProjectRegistrationPlan(value: unknown): ProjectRegistrationPlan {
  return registrationPlanSchema.parse(value);
}
