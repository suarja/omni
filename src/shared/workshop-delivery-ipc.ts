import { z } from "zod";

const count = z.number().int().nonnegative();
const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
export const workshopSyncSchema = z
  .object({
    status: z.enum(["current", "ahead", "behind", "diverged", "no-upstream", "unavailable", "push-failed"]),
    ahead: count,
    behind: count,
    branch: text.optional(),
    upstream: text.optional(),
    destination: text.optional(),
    head: commit.optional(),
    pushedCommit: commit.optional(),
    diagnostic: text.optional(),
  })
  .strict();
export type WorkshopSyncState = z.infer<typeof workshopSyncSchema>;
export const workshopPushSchema = z
  .object({
    status: z.enum(["pushed", "failed", "unknown"]),
    commit,
    ahead: count,
    behind: count,
    upstream: text.optional(),
    destination: text.optional(),
    diagnostic: text.optional(),
  })
  .strict();
export type WorkshopPushResult = z.infer<typeof workshopPushSchema>;
const commandSchema = z
  .object({
    executable: z.enum(["claude", "codex"]),
    args: z.array(text).min(1).max(12),
    cwd: text.optional(),
  })
  .strict();
export type PluginUpdateCommand = z.infer<typeof commandSchema>;
const installedPluginSchema = z
  .object({
    harness: z.enum(["claude-code", "codex"]),
    marketplace: text,
    name: text,
    scope: z.enum(["user", "project", "local", "managed"]).optional(),
    projectPath: text.optional(),
    version: text.optional(),
    commit: commit.optional(),
    expectedVersion: text.optional(),
    state: z.enum(["current", "behind", "unknown"]),
    commands: z.array(commandSchema),
    diagnostic: text.optional(),
  })
  .strict();
export type InstalledWorkshopPlugin = z.infer<typeof installedPluginSchema>;
export const workshopDeliverySchema = z
  .object({
    status: z.enum(["ready", "unavailable"]),
    workshop: z.object({ sourceId: text, name: text, sync: workshopSyncSchema }).strict().nullable(),
    plugins: z
      .object({
        status: z.enum(["ready", "partial", "unavailable"]),
        behind: count,
        installations: z.array(installedPluginSchema),
        diagnostics: z.array(text),
      })
      .strict(),
    projects: z.array(
      z
        .object({
          projectId: text,
          conflicts: count,
          updates: count,
          unavailable: count,
        })
        .strict(),
    ),
    diagnostics: z.array(text),
  })
  .strict();
export type WorkshopDeliveryStatus = z.infer<typeof workshopDeliverySchema>;
export const WORKSHOP_DELIVERY_CHANNEL = "omni:workshop-delivery:read";
export interface WorkshopDeliveryDesktopApi {
  getWorkshopDelivery(): Promise<WorkshopDeliveryStatus>;
}
export function parseWorkshopDelivery(value: unknown): WorkshopDeliveryStatus {
  return workshopDeliverySchema.parse(value);
}
export const workshopDeliveryRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry-workshop-push"), sourceId: text }).strict(),
  z.object({ kind: z.literal("update-workshop-plugins"), harness: z.enum(["claude-code", "codex"]) }).strict(),
]);
export type WorkshopDeliveryRequest = z.infer<typeof workshopDeliveryRequestSchema>;
export const pluginCommandResultSchema = z
  .object({
    command: commandSchema,
    status: z.enum(["applied", "failed", "skipped"]),
    diagnostic: text.optional(),
  })
  .strict();
export type PluginCommandResult = z.infer<typeof pluginCommandResultSchema>;
