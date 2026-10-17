import { registerPublicationPreview, registerStorefrontLinkPreview } from "./publication-tool.js";
import { registerExternalLibraryTools } from "./external-library-tools.js";
import type { ApprovalReason } from "../../../src/shared/agents-ipc.js";
import { OMNI_APPROVAL_INSTRUCTIONS } from "./approval-text.js";
import { RUNTIME_VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createWakingGatewayClient } from "./desktop-wake-adapter.js";
import { type GatewayClientLike, type GatewayResult } from "./gateway-client.js";
import { inspectBootstrapStatus } from "./bootstrap-status.js";
import {
  summarizeApply,
  summarizeCatalogSearch,
  summarizePlan,
  summarizeSkillPreview,
  summarizeSession,
  summarizeStackProfile,
  summarizeSuggest,
} from "./summary.js";

const PACKAGE_ID_INSTRUCTIONS =
  "Use the packageId shown by omni_list_marketplace or omni_find_skill, for example packages/<name>. The short package name also works. ";

const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const path = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:\//u.test(value) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Path must be safe and relative.",
  );
const harness = z.enum(["claude-code", "codex"]);
const tagId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u);
const files = z
  .array(
    z
      .object({
        path,
        content: z
          .string()
          .min(1)
          .max(256 * 1024)
          .refine((value) => !/[\u0000\u007f-\u009f]/u.test(value), "File content contains a control character."),
      })
      .strict(),
  )
  .min(1)
  .max(32)
  .refine((items) => new Set(items.map((item) => item.path)).size === items.length, "File paths must be unique.");
const empty = z.object({}).strict();
const folderName = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const projectIds = z
  .array(id)
  .min(1)
  .refine((items) => new Set(items).size === items.length, "Project ids must be unique.");
const captureTarget = z.union([
  z.object({ packageId: path }).strict(),
  z
    .object({
      newPackageName: z.string().trim().min(1).max(240),
      description: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .regex(/^[^\r\n\u0000-\u001f]+$/u),
      projectTo: z.array(harness).min(1).optional(),
    })
    .strict()
    .refine(
      (value) => !value.projectTo || new Set(value.projectTo).size === value.projectTo.length,
      "Target harnesses must be unique.",
    ),
]);

function toolResult(value: Record<string, unknown>): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function normalize(result: GatewayResult): Record<string, unknown> {
  if (result.ok) return result.result as Record<string, unknown>;
  if ("unavailable" in result) return result.unavailable;
  if (result.error.code === "not-available") return { status: "not-available", message: result.error.message };
  return { status: "error", code: result.error.code, message: result.error.message };
}

function previewResult(result: GatewayResult): Record<string, unknown> {
  const value = normalize(result);
  if (value.status !== undefined && value.status !== "ready") return value;
  if (
    value.status === "ready" &&
    (typeof value.projectId === "string" || typeof value.storefrontId === "string") &&
    value.requestId === undefined
  )
    return value;
  if (
    typeof value.requestId !== "string" ||
    (value.approval !== "conversation" && value.approval !== "omni") ||
    typeof value.plan !== "object" ||
    value.plan === null
  )
    return { status: "error", code: "invalid-response", message: "Omni returned an invalid preview." };
  const skillPreview =
    typeof value.skillPreview === "object" && value.skillPreview !== null
      ? (value.skillPreview as Record<string, unknown>)
      : undefined;
  return {
    requestId: value.requestId,
    plan: value.plan,
    approval: value.approval,
    ...(value.approvalReason ? { approvalReason: value.approvalReason } : {}),
    ...(typeof value.intentId === "string" ? { intentId: value.intentId } : {}),
    ...(skillPreview ? { skillPreview } : {}),
    ...(value.sourceOnly === true ? { sourceOnly: true } : {}),
    summary: skillPreview
      ? summarizeSkillPreview(skillPreview, value.approval, value.approvalReason as ApprovalReason | undefined)
      : summarizePlan(
          value.plan as Record<string, unknown>,
          value.approval,
          value.approvalReason as ApprovalReason | undefined,
        ),
  };
}

function createSkillGatewayParams(input: {
  sourceId: string;
  packageId?: string;
  newPackage?: { name: string; description: string };
  folderName: string;
  files: readonly { path: string; content: string }[];
  reason?: string;
  askInOmni?: boolean;
}): Record<string, unknown> {
  const skill = input.files.find((file) => file.path === "SKILL.md");
  if (!skill) return { ...input, name: input.folderName };
  const frontmatter = /^---\nname:\s*(.+)\ndescription:\s*(.+)\n---\n\n([\s\S]*)$/u.exec(skill.content);
  if (!frontmatter) return { ...input, name: input.folderName };
  return {
    sourceId: input.sourceId,
    ...(input.newPackage ? { newPackage: input.newPackage } : { packageId: input.packageId }),
    name: input.folderName,
    description: frontmatter[2],
    body: frontmatter[3],
    files: input.files.filter((file) => file.path !== "SKILL.md"),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.askInOmni === undefined ? {} : { askInOmni: input.askInOmni }),
  };
}

/**
 * Adds a `message` summary only when `value.status` is one of `readyStatuses` — an unavailable,
 * denied, or error result (from `normalize`) is returned exactly as-is, so a summary written for
 * the happy path never overwrites the real reason a read failed.
 */
function withMessage(
  value: Record<string, unknown>,
  readyStatuses: readonly string[],
  summarize: (value: Record<string, unknown>) => string,
): Record<string, unknown> {
  return readyStatuses.includes(String(value.status)) ? { ...value, message: summarize(value) } : value;
}

function registerReadTools(server: McpServer, gateway: GatewayClientLike): void {
  server.registerTool(
    "omni_bootstrap_status",
    {
      description:
        "Diagnose the Omni bootstrap path and try to open an installed Desktop in the background when its default profile is unreachable: plugin/runtime, Desktop installation and reachability, harness registration, and the one next action to take.",
      inputSchema: empty,
    },
    async () =>
      toolResult(
        await inspectBootstrapStatus({
          runtimePath: process.env.OMNI_MCP_RUNTIME_PATH ?? process.argv[1] ?? "unknown",
          gatewayProbe: async () => {
            const result = await gateway.request("status", {});
            return result.ok && (result.result as { status?: unknown }).status === "ready";
          },
        }),
      ),
  );
  server.registerTool(
    "omni_status",
    {
      description:
        "Read Omni status, marketplace, and registered projects. Use before planning work; writes still require approval in the app.",
      inputSchema: empty,
    },
    async () => toolResult(normalize(await gateway.request("status", {}))),
  );
  server.registerTool(
    "omni_list_marketplace",
    {
      description:
        "List packages, artifacts, and harness compatibilities in the personal marketplace. Use to discover available Omni assets; writes still require approval in the app.",
      inputSchema: empty,
    },
    async () => toolResult(normalize(await gateway.request("list_marketplace", {}))),
  );
  server.registerTool(
    "omni_find_skill",
    {
      description:
        "Find skills by name or description across the marketplace and projects, including identity findings. Use before creating a duplicate; writes still require approval in the app.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(240) }).strict(),
    },
    async ({ query }) => toolResult(normalize(await gateway.request("find_skill", { query }))),
  );
  server.registerTool(
    "omni_skill_inventory",
    {
      description:
        "Read compact paginated skill units and whole-scope identity computed from full folder hashes. Scopes provide local roots; displayed hashes have 12 hex characters. Follow nextCursor until complete. Unavailable roots and read limits are explicit. This tool performs no writes.",
      inputSchema: z
        .object({
          projectIds: z.array(id).max(64).optional(),
          includeMarketplace: z.boolean().optional(),
          cursor: z.string().trim().min(1).max(128).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(normalize(await gateway.request("skill_inventory", input))),
  );
  registerExternalLibraryTools(server, {
    list: async () => toolResult(normalize(await gateway.request("list_external_library", {}))),
    preview: async (input) => toolResult(previewResult(await gateway.request("preview_install_external", input))),
  });
  server.registerTool(
    "omni_list_project_assets",
    {
      description:
        "List managed, unmanaged, and drifting assets for one project. Use to inspect project state before assignment; writes still require approval in the app.",
      inputSchema: z.object({ projectId: id }).strict(),
    },
    async ({ projectId }) => toolResult(normalize(await gateway.request("list_project_assets", { projectId }))),
  );
  server.registerTool(
    "omni_drift_report",
    {
      description:
        "Report marketplace drift for one project or all projects. Use to identify harness updates and conflicts; writes still require approval in the app.",
      inputSchema: z.object({ projectId: id.optional() }).strict(),
    },
    async ({ projectId }) =>
      toolResult(normalize(await gateway.request("drift_report", projectId ? { projectId } : {}))),
  );
  server.registerTool(
    "omni_receipt",
    {
      description:
        "Read an Omni operation receipt by operationId or requestId. Use to verify what was actually applied; this read does not request additional approval.",
      inputSchema: z.object({ operationId: id.optional(), requestId: id.optional() }).strict(),
    },
    async (input) => {
      if (Boolean(input.operationId) === Boolean(input.requestId)) throw new Error("Provide operationId or requestId.");
      return toolResult(normalize(await gateway.request("receipt", input)));
    },
  );
  server.registerTool(
    "omni_stack_profile",
    {
      description:
        "Read the deterministic stack profile Omni detected for one project (tags with evidence, languages, agent harnesses). Read-only, no model involved; use before Suggest or Explain to ground either in real evidence.",
      inputSchema: z.object({ projectId: id }).strict(),
    },
    async ({ projectId }) =>
      toolResult(
        withMessage(normalize(await gateway.request("stack_profile", { projectId })), ["ready"], summarizeStackProfile),
      ),
  );
  server.registerTool(
    "omni_catalog_search",
    {
      description:
        "Search the merged skill catalogue (the marketplace plus the skills.sh snapshot) by free text and/or tags, optionally ranked for one project's stack. Read-only; adding a result to a marketplace goes through omni_preview_create_skill after you fetch its SKILL.md yourself from the returned url, then consent, then omni_apply.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(200).optional(),
          tags: z.array(tagId).max(20).optional(),
          projectId: id.optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
    },
    async (input) =>
      toolResult(
        withMessage(normalize(await gateway.request("catalog_search", input)), ["ready"], summarizeCatalogSearch),
      ),
  );
  server.registerTool(
    "omni_suggest",
    {
      description:
        "Read the deterministic, ranked skill suggestions for one project (same ranker as the Suggested-for-this-project card): each result carries why (the matched stack tags) and alreadyInProject. Read-only; adding a chosen suggestion goes through omni_catalog_search for its entry, fetching its SKILL.md yourself from the url, then omni_preview_create_skill, consent, omni_apply, then omni_preview_assign.",
      inputSchema: z.object({ projectId: id, limit: z.number().int().min(1).max(20).optional() }).strict(),
    },
    async (input) =>
      toolResult(withMessage(normalize(await gateway.request("suggest", input)), ["ready"], summarizeSuggest)),
  );
  server.registerTool(
    "omni_session",
    {
      description:
        'Read one agent session from the current Activity snapshot (title, task, and transcript-tail evidence) by its sessionId. Read-only; use to ground a session or receipt summary in facts instead of guessing — say "unknown" for any field this does not carry.',
      inputSchema: z.object({ sessionId: z.string().trim().min(1).max(256) }).strict(),
    },
    async ({ sessionId }) =>
      toolResult(withMessage(normalize(await gateway.request("session", { sessionId })), ["found"], summarizeSession)),
  );
}

function registerPreviewTools(server: McpServer, gateway: GatewayClientLike): void {
  server.registerTool(
    "omni_preview_register_project",
    {
      description:
        "Preview registering the calling agent's working directory, resolving its Git root when present. Pass path to register another project with conversation consent. Absolute paths work without a known working directory; relative paths resolve against the calling agent's working directory. The target resolves to its Git root when present. Omni reads skills; nothing is written in the project. Undo archives it. Already registered returns ready with projectId and no write. Use conversation consent with the configured projects approval setting, then omni_apply and chain omni_preview_assign using projectId. " +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          path: z.string().trim().min(1).max(4096).optional(),
          reason: z.string().trim().min(1).max(1024).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_register_project", input))),
  );
  registerStorefrontLinkPreview(server, gateway, (result) => toolResult(previewResult(result)));
  registerPublicationPreview(server, gateway, (result) => toolResult(previewResult(result)));
  server.registerTool(
    "omni_preview_capture",
    {
      description:
        "Preview capturing a project skill or copying a locked external skill into your personal marketplace. Choose target.packageId, or target.newPackageName with a required English description; a new plugin is created with its first skill. External copies keep their lock provenance and do not relink the project. Returns the approval mode and exact plan. For conversation approval, call omni_apply when the plan matches the user's already authorized scope; ask once only if authorization is missing or scope changed. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({ projectId: id, relativePath: path, target: captureTarget, askInOmni: z.boolean().optional() })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_capture", input))),
  );
  server.registerTool(
    "omni_preview_make_compatible",
    {
      description:
        "Preview making a marketplace package compatible with Claude Code or Codex. Returns the approval mode and plan. For conversation approval, call omni_apply when the plan matches the user's already authorized scope; ask once only if authorization is missing or scope changed. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({ sourceId: id, harness, packageId: path.optional(), askInOmni: z.boolean().optional() })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_make_compatible", input))),
  );
  server.registerTool(
    "omni_preview_assign",
    {
      description:
        "Preview assigning one marketplace artifact to projects and optional Claude Code/Codex harnesses. When harnesses are omitted Omni selects both by default. Returns the approval mode and exact plan; source-only skill creation never assigns a project. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          artifactPath: path,
          sourceId: id,
          packageId: path,
          projectIds: z.array(id).min(1),
          harnesses: z
            .array(harness)
            .optional()
            .refine((items) => !items || new Set(items).size === items.length, "Assignment harnesses must be unique."),
          askInOmni: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_assign", input))),
  );
  server.registerTool(
    "omni_preview_remove",
    {
      description:
        "Preview removing selected Omni-managed skill uses from their project targets. Returns the exact preview and approval mode; failed or partial outcomes keep receipts for recovery. For Omni approval, use the returned reason. " +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          bindingIds: z
            .array(id)
            .min(1)
            .refine((items) => new Set(items).size === items.length, "Binding ids must be unique."),
          askInOmni: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_remove", input))),
  );
  server.registerTool(
    "omni_preview_restore",
    {
      description:
        "Preview restoring a saved Omni skill operation by operationId. Returns the exact preview and approval mode; inspect recovery before retrying a terminal failure. For Omni approval, use the returned reason. " +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z.object({ operationId: id, askInOmni: z.boolean().optional() }).strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_restore", input))),
  );
  server.registerTool(
    "omni_preview_create_skill",
    {
      description:
        "Preview creating a skill folder in a marketplace from supplied files. Choose packageId or newPackage: { name, description }, with a required English description. A new plugin is created with its first skill, without needing a registered project. Returns the approval mode and plan. For conversation approval, call omni_apply when the plan matches the user's already authorized scope; ask once only if authorization is missing or scope changed. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          sourceId: id,
          packageId: path.optional(),
          newPackage: z
            .object({
              name: folderName,
              description: z
                .string()
                .trim()
                .min(1)
                .max(1024)
                .regex(/^[^\r\n\u0000-\u001f\u007f-\u009f]+$/u),
            })
            .strict()
            .optional(),
          folderName,
          files,
          reason: z.string().trim().min(1).max(1024).optional(),
          askInOmni: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => {
      if (Boolean(input.packageId) === Boolean(input.newPackage))
        throw new Error("Choose exactly one packageId or newPackage.");
      return toolResult(previewResult(await gateway.request("preview_create_skill", createSkillGatewayParams(input))));
    },
  );
  server.registerTool(
    "omni_preview_update_skill",
    {
      description:
        "Preview updating an owned skill folder and its eligible linked project copies with supplied files. Use sourceOnly: true to update only the marketplace. Returns the approval mode and plan. For conversation approval, call omni_apply when the plan matches the user's already authorized scope; ask once only if authorization is missing or scope changed. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          sourceId: id,
          packageId: path,
          folderName,
          files,
          replaceFolder: z.boolean().optional(),
          sourceOnly: z.boolean().optional(),
          reason: z.string().trim().min(1).max(1024).optional(),
          askInOmni: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_update_skill", input))),
  );
  server.registerTool(
    "omni_preview_sync_skill",
    {
      description:
        "Preview updating linked copies from the current marketplace skill without rewriting the source. Omit projectIds to include all linked projects. Local edits are retained. Follow the returned approval mode, then call omni_apply under the user's existing authorization for that scope. For Omni approval, use the returned reason. " +
        PACKAGE_ID_INSTRUCTIONS +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          sourceId: id,
          packageId: path,
          artifactPath: path,
          projectIds: z.array(id).min(1).max(64).optional(),
          askInOmni: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => toolResult(previewResult(await gateway.request("preview_sync_skill", input))),
  );
}

function registerApplyTool(server: McpServer, gateway: GatewayClientLike): void {
  server.registerTool(
    "omni_apply",
    {
      description:
        "Apply a preview covered by the user's clear authorization or by Omni approval. Prior authorization for the same scope counts; do not ask again. Returns the operation outcome and receipts; inspect recovery before retrying a partial or recovery-required result. " +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z.object({ requestId: id }).strict(),
    },
    async ({ requestId }) => {
      const value = normalize(await gateway.request("apply", { requestId, waitMs: 45000 }));
      return toolResult({ ...value, ...(value.status ? { message: summarizeApply(value) } : {}) });
    },
  );
}

export function createOmniServer(gateway: GatewayClientLike = createWakingGatewayClient()): McpServer {
  const server = new McpServer(
    { name: "omni", version: RUNTIME_VERSION },
    {
      instructions:
        "Omni is the source of truth for reusable skills. Call omni_bootstrap_status first when the installation path is unclear; it distinguishes the plugin, MCP runtime, Desktop installation, Desktop reachability, harness registration, and skills. Then call omni_status before skill work. Never write a reusable SKILL.md directly. Present previews and use omni_apply when the user has already clearly authorized the same scope; ask once only when authorization is missing or scope changes. If Desktop is unavailable, follow nextAction and do not silently create a local replacement. For Omni approval, use the returned reason. " +
        OMNI_APPROVAL_INSTRUCTIONS,
    },
  );
  registerReadTools(server, gateway);
  registerPreviewTools(server, gateway);
  registerApplyTool(server, gateway);
  return server;
}
