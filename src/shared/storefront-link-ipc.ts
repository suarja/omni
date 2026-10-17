import { z } from "zod";
import { parseStorefrontInspection } from "./storefronts-ipc";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\//u)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const linkStorefrontSchema = z
  .object({
    kind: z.literal("link-storefront"),
    path: absolutePath,
    reason: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type LinkStorefrontRequest = z.infer<typeof linkStorefrontSchema>;
const planSchema = z
  .object({
    path: absolutePath,
    action: z.enum(["link", "existing", "archive"]),
    storefrontId: z.string().min(1).max(128).optional(),
    revision: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    inspection: z.unknown().transform(parseStorefrontInspection),
    unlinkedPlugins: z.array(z.object({ pluginId: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();
export type StorefrontLinkPlan = z.infer<typeof planSchema>;
export function parseStorefrontLinkPlan(value: unknown): StorefrontLinkPlan {
  return planSchema.parse(value);
}
