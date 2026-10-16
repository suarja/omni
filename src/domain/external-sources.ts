import { z } from "zod";
import { parseExternalRepository, externalReadCopyFolder } from "./external-library";
import { publicationPathSchema } from "./publications";
export const externalRepositorySchema = z
  .string()
  .max(201)
  .refine((value) => {
    try {
      return parseExternalRepository(value) === value;
    } catch {
      return false;
    }
  });
export const externalTimestampSchema = z.string().datetime();
export const externalErrorSchema = z
  .object({
    type: z.enum(["offline", "not-found", "auth", "timeout", "other"]),
    message: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u),
  })
  .strict();
export const externalHeadSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40,64}$/u),
    date: externalTimestampSchema,
  })
  .strict();
export const externalSourceRecordSchema = z
  .object({
    repo: externalRepositorySchema,
    arrival: z.enum(["detected", "owner"]),
    readCopyFolder: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    lastCheckAt: externalTimestampSchema.optional(),
    head: externalHeadSchema.optional(),
    lastError: externalErrorSchema.optional(),
  })
  .strict()
  .refine((source) => source.readCopyFolder === externalReadCopyFolder(source.repo));
export const externalCopyVersionSchema = z
  .object({
    repo: externalRepositorySchema,
    skillPath: publicationPathSchema,
    copyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    head: externalHeadSchema.shape.commit,
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("found"), commit: externalHeadSchema.shape.commit }).strict(),
      z
        .object({ status: z.literal("not-found"), bounded: z.boolean(), reason: z.literal("timeout").optional() })
        .strict(),
    ]),
  })
  .strict();
export type ExternalCopyVersion = z.infer<typeof externalCopyVersionSchema>;
export const externalSourcesStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(externalSourceRecordSchema).max(10000),
    copyVersions: z.array(externalCopyVersionSchema).max(100000).optional(),
  })
  .strict()
  .refine((store) => new Set(store.sources.map((source) => source.repo)).size === store.sources.length)
  .refine(
    (store) =>
      new Set(store.copyVersions?.map((entry) => JSON.stringify([entry.repo, entry.skillPath, entry.copyHash])))
        .size === (store.copyVersions?.length ?? 0),
    {
      message: "External copy version cache keys must be unique.",
    },
  )
  .refine((store) => new Set(store.sources.map((source) => source.readCopyFolder)).size === store.sources.length, {
    message: "External repositories must have distinct read-copy folders.",
  });
export type ExternalSourceRecord = z.infer<typeof externalSourceRecordSchema>;
export type ExternalSourcesRecord = z.infer<typeof externalSourcesStoreSchema>;
