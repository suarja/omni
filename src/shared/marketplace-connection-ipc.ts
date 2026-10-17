import { z } from "zod";
export const connectMarketplaceSchema = z
  .object({ kind: z.literal("connect-marketplace"), sourceId: z.string().min(1).max(128) })
  .strict();
export type ConnectMarketplaceRequest = z.infer<typeof connectMarketplaceSchema>;
const connectionPlanSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    device: z.string(),
    inode: z.string(),
  })
  .strict();
export type MarketplaceConnectionPlan = z.infer<typeof connectionPlanSchema>;
export function parseMarketplaceConnectionPlan(value: unknown): MarketplaceConnectionPlan {
  return connectionPlanSchema.parse(value);
}
