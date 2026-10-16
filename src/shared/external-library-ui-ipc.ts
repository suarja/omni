import { z } from "zod";
import {
  externalSourceSchema,
  externalSkillSchema,
  externalUseSchema,
  parseExternalAddRequest,
} from "./external-library-ipc";
import { publicationPathSchema } from "../domain/publications";
import { externalErrorSchema } from "../domain/external-sources";
import type { ReadArtifactResponse } from "./artifact-ipc";

export const EXTERNAL_LIBRARY_UI_CHANNELS = {
  discover: "omni:external-library-ui:discover",
  importSource: "omni:external-library-ui:import-source",
  readDocument: "omni:external-library-ui:read-document",
  openRepository: "omni:external-library-ui:open-repository",
} as const;
const discovery = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      source: externalSourceSchema,
      skills: z.array(externalSkillSchema).max(10000),
      uses: z.array(externalUseSchema).max(10000),
      marketplaceMatches: z
        .array(z.object({ id: z.string().max(4096), repo: z.string().max(256) }).strict())
        .max(10000),
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: externalErrorSchema }).strict(),
]);
const importRequest = z.object({ sourceId: z.string().min(1).max(256), skillPath: publicationPathSchema }).strict();
const importSource = z
  .object({
    kind: z.literal("source"),
    id: z.string().min(1).max(128),
    grantHandle: z.string().min(1).max(256),
    relativePath: publicationPathSchema,
  })
  .strict();
const opened = z.discriminatedUnion("status", [
  z.object({ status: z.literal("opened") }).strict(),
  z.object({ status: z.literal("blocked"), message: z.string().min(1).max(4096) }).strict(),
]);
export type ExternalDiscovery = z.infer<typeof discovery>;
export type ExternalImportSource = z.infer<typeof importSource>;
export function parseExternalDiscovery(value: unknown): ExternalDiscovery {
  return discovery.parse(value);
}
export function parseExternalImportSource(value: unknown): ExternalImportSource {
  return importSource.parse(value);
}
export function parseExternalImportRequest(value: unknown): z.infer<typeof importRequest> {
  return importRequest.parse(value);
}
export function parseExternalSkillDocumentRequest(value: unknown): z.infer<typeof importRequest> {
  return importRequest.parse(value);
}
export function parseExternalRepositoryOpened(value: unknown): z.infer<typeof opened> {
  return opened.parse(value);
}
export { parseExternalAddRequest };
export interface ExternalLibraryUiDesktopApi {
  discoverExternalSource(request: { repository: string }): Promise<ExternalDiscovery>;
  prepareExternalSkillImport(request: { sourceId: string; skillPath: string }): Promise<ExternalImportSource>;
  readExternalSkillDocument(request: { sourceId: string; skillPath: string }): Promise<ReadArtifactResponse>;
  openExternalSourceRepository(request: { sourceId: string }): Promise<z.infer<typeof opened>>;
}
