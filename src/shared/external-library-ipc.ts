import { z } from "zod";
import { externalUseStates, parseExternalRepository } from "../domain/external-library";
import { externalErrorSchema, externalHeadSchema, externalTimestampSchema } from "../domain/external-sources";
import { publicationClassifications } from "../domain/publication-drift";
import { publicationPathSchema } from "../domain/publications";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
  .refine((text) => text.split("/").every((part) => part && part !== "." && part !== ".."));
const label = z
  .string()
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const licence = z.enum(["MIT", "Apache-2.0", "other", "none"]);
const base = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("found"),
      commit: externalHeadSchema.shape.commit,
      scanned: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("not-found"),
      scanned: z.number().int().nonnegative(),
      bounded: z.boolean(),
      reason: z.literal("timeout").optional(),
    })
    .strict(),
  z.object({ status: z.literal("unknown"), reason: label }).strict(),
]);
export const externalAutomaticFailureSchema = z
  .object({
    sourceHead: externalHeadSchema.shape.commit,
    copyHash: hash,
    failedAt: externalTimestampSchema,
    reason: label,
    operationId: id.optional(),
  })
  .strict();
export type ExternalAutomaticFailure = z.infer<typeof externalAutomaticFailureSchema>;
export const externalUseSchema = z
  .object({
    id,
    sourceId: id,
    projectId: id,
    projectName: label,
    skillKey: label,
    folderPath: publicationPathSchema.optional(),
    skillPath: publicationPathSchema.optional(),
    lockHash: hash,
    copyHash: hash.optional(),
    sourceHash: hash.optional(),
    lockStale: z.literal(true).optional(),
    installedCommit: externalHeadSchema.shape.commit.optional(),
    state: z.enum(externalUseStates),
    sourceChanged: z.boolean(),
    base,
    removal: z
      .object({ commit: externalHeadSchema.shape.commit, date: externalTimestampSchema, subject: label })
      .strict()
      .optional(),
    diagnostic: label.optional(),
    acknowledged: z.literal(true).optional(),
    lastAutomaticFailure: externalAutomaticFailureSchema.optional(),
  })
  .strict();
export const externalSkillSchema = z
  .object({
    path: publicationPathSchema,
    name: label,
    description: z.string().max(65536),
    lastChangeAt: externalTimestampSchema.optional(),
    licence,
    useIds: z.array(id).max(10000),
  })
  .strict();
const counts = z
  .object({
    "up-to-date": z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();
export const externalSourceSchema = z
  .object({
    id,
    kind: z.enum(["github", "folder"]),
    name: label,
    repo: id.optional(),
    arrival: z.enum(["detected", "owner"]),
    readCopy: label,
    lastCheckAt: externalTimestampSchema.optional(),
    head: externalHeadSchema.optional(),
    lastError: externalErrorSchema.optional(),
    licence,
    skillCount: z.number().int().nonnegative(),
    unusedSkills: z.number().int().nonnegative(),
    counts,
    projects: z.array(z.object({ id, name: label }).strict()).max(10000),
  })
  .strict();
export const externalPassSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            sourceId: id,
            operationId: id.optional(),
            copiesUpdated: z.number().int().nonnegative(),
            failedTargets: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10000)
      .optional(),
    startedAt: externalTimestampSchema,
    finishedAt: externalTimestampSchema,
    result: z.enum(["success", "partial", "failed"]),
    errors: z.number().int().nonnegative(),
    diagnostics: z.array(externalErrorSchema).max(10000),
  })
  .strict();
const fileVersion = z
  .object({
    hash,
    bytes: z.number().int().nonnegative(),
    binary: z.boolean(),
    text: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
const comparison = z
  .object({
    status: z.enum(["ready", "unavailable"]),
    useId: id,
    base,
    files: z
      .array(
        z
          .object({
            path: publicationPathSchema,
            classification: z.enum(publicationClassifications),
            base: fileVersion.optional(),
            copy: fileVersion.optional(),
            source: fileVersion.optional(),
          })
          .strict(),
      )
      .max(10000),
    diagnostic: label.optional(),
  })
  .strict();
const marketplace = z.object({ id: label, repo: id }).strict();
const mac = z
  .object({
    status: z.enum(["ready", "unavailable"]),
    marketplaces: z.array(marketplace).max(10000),
    error: externalErrorSchema.optional(),
  })
  .strict();
const sourceDetails = z
  .object({
    source: externalSourceSchema.optional(),
    skills: z.array(externalSkillSchema).max(10000),
    uses: z.array(externalUseSchema).max(10000),
    diagnostic: label.optional(),
  })
  .strict();
const list = z
  .object({
    sources: z.array(externalSourceSchema).max(10000),
    lastPass: externalPassSchema.optional(),
    checking: z.boolean(),
    diagnostics: z.array(externalErrorSchema).max(10000),
  })
  .strict();
const addResult = z
  .object({
    status: z.enum(["added", "failed"]),
    source: externalSourceSchema.optional(),
    skills: z.array(externalSkillSchema).max(10000),
    uses: z.array(externalUseSchema).max(10000),
    marketplaceMatches: z.array(marketplace).max(10000),
    error: externalErrorSchema.optional(),
  })
  .strict();

export type ExternalUse = z.infer<typeof externalUseSchema>;
export type ExternalSkill = z.infer<typeof externalSkillSchema>;
export type ExternalSource = z.infer<typeof externalSourceSchema>;
export type ExternalPass = z.infer<typeof externalPassSchema>;
export type ExternalComparison = z.infer<typeof comparison>;
export type ExternalMacSources = z.infer<typeof mac>;
export type ExternalSourceDetails = z.infer<typeof sourceDetails>;
export type ExternalLibraryList = z.infer<typeof list>;
export type ExternalSourceAddResult = z.infer<typeof addResult>;
export const EXTERNAL_LIBRARY_CHANNELS = {
  list: "omni:external-library:list",
  source: "omni:external-library:source",
  compare: "omni:external-library:compare",
  onMac: "omni:external-library:on-mac",
  add: "omni:external-library:add",
  check: "omni:external-library:check",
  acknowledge: "omni:external-library:acknowledge",
} as const;
export function parseExternalSourceRequest(value: unknown): { sourceId: string } {
  return z.object({ sourceId: id }).strict().parse(value);
}
export function parseExternalComparisonRequest(value: unknown): { useId: string } {
  return z.object({ useId: id }).strict().parse(value);
}
export function parseExternalAddRequest(value: unknown): { repository: string } {
  const parsed = z
    .object({ repository: z.string().min(1).max(1024) })
    .strict()
    .parse(value);
  return { repository: parseExternalRepository(parsed.repository) };
}
export function parseExternalLibraryList(value: unknown): ExternalLibraryList {
  return list.parse(value);
}
export function parseExternalSourceDetails(value: unknown): ExternalSourceDetails {
  return sourceDetails.parse(value);
}
export function parseExternalComparison(value: unknown): ExternalComparison {
  return comparison.parse(value);
}
export function parseExternalMacSources(value: unknown): ExternalMacSources {
  return mac.parse(value);
}
export function parseExternalSourceAddResult(value: unknown): ExternalSourceAddResult {
  return addResult.parse(value);
}
export function parseExternalPass(value: unknown): ExternalPass {
  return externalPassSchema.parse(value);
}
export interface ExternalLibraryDesktopApi {
  acknowledgeRemovedExternalUse(request: { useId: string }): Promise<ExternalSourceDetails>;
  listExternalSources(): Promise<ExternalLibraryList>;
  readExternalSource(request: { sourceId: string }): Promise<ExternalSourceDetails>;
  compareExternalUse(request: { useId: string }): Promise<ExternalComparison>;
  listExternalSourcesOnMac(): Promise<ExternalMacSources>;
  addExternalSource(request: { repository: string }): Promise<ExternalSourceAddResult>;
  checkExternalLibrary(): Promise<ExternalPass>;
}
